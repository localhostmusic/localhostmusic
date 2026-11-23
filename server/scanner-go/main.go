// lhm-scan is a parallel library scanner sidecar. It mirrors
// server/src/scanner/scan.ts but parses tags across a worker pool, with one
// writer goroutine owning SQLite. No CGO, so it cross-compiles statically.
// Prints {"added":N,"issues":M} as JSON on stdout, everything else on stderr.
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	taglib "go.senan.xyz/taglib"
	_ "modernc.org/sqlite"
)

// Same set as scan.ts AUDIO.
var audioExt = map[string]bool{
	".mp3": true, ".flac": true, ".m4a": true, ".m4b": true, ".ogg": true, ".opus": true,
	".wav": true, ".aiff": true, ".aif": true, ".ape": true, ".wv": true,
}

// creditsVersion mirrors CREDITS_VERSION in server/src/db/migrate.ts. Tracks below
// it get their tags re-read even when the file is unchanged.
const creditsVersion = 1

type tags struct {
	title       string
	artist      string   // primary, artists[0]
	artists     []string // every ARTIST frame, in tag order
	album       string
	albumArtist string // "" when absent
	trackNo     *int64
	discNo      *int64
	year        *int64
	genre       string // "" when absent
	duration    *float64
	picture     []byte // nil when no embedded art
}

// a file handed to a parse worker. recreditID != 0 means the track row already
// exists and only its credit list needs rebuilding.
type job struct {
	path       string
	recreditID int64
	updateID   int64
}

// parsed result handed from a parse worker to the writer.
type result struct {
	path       string
	tags       *tags  // nil when err != ""
	err        string // non-empty: recorded as a scan_issue
	updateID   int64
	recreditID int64 // mirrors job.recreditID
}

// existing track row, as far as the skip logic cares.
type existingTrack struct {
	id          int64
	creditsV    int64
	mtime, size int64
}

func main() {
	musicDir := flag.String("music", "", "music library root")
	dataDir := flag.String("data", "", "data dir (covers/ live here)")
	dbPath := flag.String("db", "", "path to lhm.db")
	workers := flag.Int("workers", runtime.NumCPU(), "parse worker count")
	flag.Parse()
	if *musicDir == "" || *dataDir == "" || *dbPath == "" {
		fmt.Fprintln(os.Stderr, "usage: lhm-scan --music DIR --data DIR --db FILE [--workers N]")
		os.Exit(2)
	}

	added, issues, recredited, err := run(*musicDir, *dataDir, *dbPath, *workers)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scan failed:", err)
		os.Exit(1)
	}
	// The Node caller parses exactly this line.
	json.NewEncoder(os.Stdout).Encode(map[string]int64{
		"added": added, "issues": issues, "recredited": recredited,
	})
}

func run(musicDir, dataDir, dbPath string, workers int) (int64, int64, int64, error) {
	// busy_timeout lets the sidecar wait out a live server's writes instead of
	// erroring; WAL + foreign_keys match the server's own pragmas.
	dsn := "file:" + dbPath + "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return 0, 0, 0, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1) // one writer; no in-process contention

	// Only unchanged files with current credits can be skipped.
	existing, err := loadExistingPaths(db)
	if err != nil {
		return 0, 0, 0, err
	}

	jobs := make(chan job, 256)
	results := make(chan result, 256)

	// Parse workers: CPU/IO-heavy, DB-free.
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				t, err := readTags(j.path)
				if err != nil {
					results <- result{path: j.path, err: err.Error(), recreditID: j.recreditID, updateID: j.updateID}
					continue
				}
				results <- result{path: j.path, tags: t, recreditID: j.recreditID, updateID: j.updateID}
			}
		}()
	}
	go func() { wg.Wait(); close(results) }()

	// Walker: feed new files to the pool, plus indexed files whose credits need a
	// tag re-read.
	go func() {
		defer close(jobs)
		filepath.WalkDir(musicDir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil // skip unreadable dir, keep walking
			}
			if !audioExt[strings.ToLower(filepath.Ext(p))] {
				return nil
			}
			if e, ok := existing[p]; ok {
				st, err := d.Info()
				if err != nil {
					return nil
				}
				if st.ModTime().UnixMilli() != e.mtime || st.Size() != e.size {
					jobs <- job{path: p, updateID: e.id}
					return nil
				}
				if e.creditsV >= creditsVersion {
					return nil
				}
				jobs <- job{path: p, recreditID: e.id}
				return nil
			}
			jobs <- job{path: p}
			return nil
		})
	}()

	return writeAll(db, dataDir, results)
}

func loadExistingPaths(db *sql.DB) (map[string]existingTrack, error) {
	rows, err := db.Query("SELECT path, id, credits_v, COALESCE(mtime,0), COALESCE(size,0) FROM tracks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := make(map[string]existingTrack)
	for rows.Next() {
		var p string
		var e existingTrack
		if err := rows.Scan(&p, &e.id, &e.creditsV, &e.mtime, &e.size); err != nil {
			return nil, err
		}
		m[p] = e
	}
	return m, rows.Err()
}

// writeAll is the single writer goroutine. It owns all DB mutation and the dedup
// caches. Artist/album get-or-create and FTS run as individual statements (their
// rowid is needed at once). Track inserts are batched 200 per transaction.
func writeAll(db *sql.DB, dataDir string, results <-chan result) (int64, int64, int64, error) {
	coversDir := filepath.Join(dataDir, "covers")
	if err := os.MkdirAll(coversDir, 0o755); err != nil {
		return 0, 0, 0, err
	}

	artistCache := map[string]int64{}
	albumCache := map[string]int64{} // key: title \x00 artistId
	covered := map[int64]bool{}

	// Seed covered from albums that already have art.
	if rows, err := db.Query("SELECT id FROM albums WHERE cover_path IS NOT NULL"); err == nil {
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				covered[id] = true
			}
		}
		rows.Close()
	}

	artistID := func(name string) (int64, error) {
		if id, ok := artistCache[name]; ok {
			return id, nil
		}
		var id int64
		err := db.QueryRow("SELECT id FROM artists WHERE name=?", name).Scan(&id)
		if err == sql.ErrNoRows {
			res, e := db.Exec("INSERT INTO artists(name) VALUES(?)", name)
			if e != nil {
				return 0, e
			}
			id, _ = res.LastInsertId()
			if _, e := db.Exec("INSERT INTO search_fts(kind,ref_id,name) VALUES('artist',?,?)", id, name); e != nil {
				return 0, e
			}
		} else if err != nil {
			return 0, err
		}
		artistCache[name] = id
		return id, nil
	}

	albumID := func(title string, aID int64, year *int64) (int64, error) {
		key := title + "\x00" + strconv.FormatInt(aID, 10)
		if id, ok := albumCache[key]; ok {
			return id, nil
		}
		var id int64
		var existingYear *int64
		err := db.QueryRow("SELECT id,year FROM albums WHERE title=? AND artist_id=?", title, aID).Scan(&id, &existingYear)
		if err == sql.ErrNoRows {
			res, e := db.Exec("INSERT INTO albums(title,artist_id,year) VALUES(?,?,?)", title, aID, year)
			if e != nil {
				return 0, e
			}
			id, _ = res.LastInsertId()
			if _, e := db.Exec("INSERT INTO search_fts(kind,ref_id,name) VALUES('album',?,?)", id, title); e != nil {
				return 0, e
			}
		} else if err != nil {
			return 0, err
		} else if existingYear == nil && year != nil {
			// Backfill a missing album year, never overwrite one. Same as the JS scanner.
			if _, e := db.Exec("UPDATE albums SET year=? WHERE id=?", year, id); e != nil {
				return 0, e
			}
		}
		albumCache[key] = id
		return id, nil
	}

	// credits resolves every ARTIST frame to an artist id, keeping tag order.
	// Frame 0 is the lead, the rest are guests (scan.ts writeCredits).
	type credit struct {
		artistID int64
		role     string
		position int64
	}
	resolveCredits := func(names []string) ([]credit, error) {
		out := make([]credit, 0, len(names))
		for i, name := range names {
			id, err := artistID(name)
			if err != nil {
				return nil, err
			}
			role := "featured"
			if i == 0 {
				role = "primary"
			}
			out = append(out, credit{artistID: id, role: role, position: int64(i)})
		}
		return out, nil
	}
	writeCredits := func(tx *sql.Tx, trackID int64, cs []credit) error {
		for _, c := range cs {
			if _, e := tx.Exec(
				"INSERT OR IGNORE INTO track_artists(track_id,artist_id,role,position) VALUES(?,?,?,?)",
				trackID, c.artistID, c.role, c.position); e != nil {
				return e
			}
		}
		return nil
	}

	type pendingTrack struct {
		updateID             int64
		path                 string
		title                string
		albumID, artistID    int64
		trackNo, discNo      *int64
		duration             *float64
		genre                *string
		mtime, size, addedAt int64
		credits              []credit
	}
	var pending []pendingTrack

	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		for _, r := range pending {
			id := r.updateID
			if id != 0 {
				if _, e := tx.Exec(`UPDATE tracks SET title=?,album_id=?,artist_id=?,track_no=?,disc_no=?,duration=?,genre=?,mtime=?,size=?,credits_v=?,loudness=NULL WHERE id=?`,
					r.title, r.albumID, r.artistID, r.trackNo, r.discNo, r.duration, r.genre, r.mtime, r.size, creditsVersion, id); e != nil {
					tx.Rollback()
					return e
				}
				for _, query := range []string{"DELETE FROM search_fts WHERE kind='track' AND ref_id=?", "DELETE FROM track_artists WHERE track_id=?", "DELETE FROM track_chapters WHERE track_id=?"} {
					if _, e := tx.Exec(query, id); e != nil {
						tx.Rollback()
						return e
					}
				}
			} else {
				res, e := tx.Exec(`INSERT INTO tracks(path,title,album_id,artist_id,track_no,disc_no,duration,genre,mtime,size,added_at,credits_v) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
					r.path, r.title, r.albumID, r.artistID, r.trackNo, r.discNo, r.duration, r.genre, r.mtime, r.size, r.addedAt, creditsVersion)
				if e != nil {
					tx.Rollback()
					return e
				}
				id, _ = res.LastInsertId()
			}
			if _, e := tx.Exec("INSERT INTO search_fts(kind,ref_id,name) VALUES('track',?,?)", id, r.title); e != nil {
				tx.Rollback()
				return e
			}
			if e := writeCredits(tx, id, r.credits); e != nil {
				tx.Rollback()
				return e
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		pending = pending[:0]
		return nil
	}

	// Re-credit path: only the credit list of an existing track row is rebuilt.
	// Batched like the insert path.
	type pendingCredit struct {
		trackID int64
		credits []credit
	}
	var pendingCredits []pendingCredit

	flushCredits := func() error {
		if len(pendingCredits) == 0 {
			return nil
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		for _, r := range pendingCredits {
			if _, e := tx.Exec("DELETE FROM track_artists WHERE track_id=?", r.trackID); e != nil {
				tx.Rollback()
				return e
			}
			if e := writeCredits(tx, r.trackID, r.credits); e != nil {
				tx.Rollback()
				return e
			}
			if _, e := tx.Exec("UPDATE tracks SET credits_v=? WHERE id=?", creditsVersion, r.trackID); e != nil {
				tx.Rollback()
				return e
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		pendingCredits = pendingCredits[:0]
		return nil
	}

	insIssue, err := db.Prepare("INSERT INTO scan_issues(path,error,at) VALUES(?,?,?)")
	if err != nil {
		return 0, 0, 0, err
	}
	defer insIssue.Close()

	var added, issues, recredited int64
	for r := range results {
		if r.err != "" {
			insIssue.Exec(r.path, r.err, time.Now().UnixMilli())
			issues++
			continue
		}
		t := r.tags

		// Existing row with a stale credit list: rebuild credits only, then move on.
		if r.recreditID != 0 {
			cs, err := resolveCredits(t.artists)
			if err != nil {
				return added, issues, recredited, err
			}
			pendingCredits = append(pendingCredits, pendingCredit{trackID: r.recreditID, credits: cs})
			if len(pendingCredits) >= 200 {
				if err := flushCredits(); err != nil {
					return added, issues, recredited, err
				}
			}
			recredited++
			continue
		}

		aID, err := artistID(t.albumArtistOrArtist())
		if err != nil {
			return added, issues, recredited, err
		}
		alID, err := albumID(t.album, aID, t.year)
		if err != nil {
			return added, issues, recredited, err
		}
		if t.picture != nil && (!covered[alID] || r.updateID != 0) {
			file := filepath.Join(coversDir, strconv.FormatInt(alID, 10)+".jpg")
			if err := os.WriteFile(file, t.picture, 0o644); err == nil {
				if _, err := db.Exec("UPDATE albums SET cover_path=? WHERE id=?", file, alID); err != nil {
					return added, issues, recredited, err
				}
				covered[alID] = true
			}
		}
		trackArtistID, err := artistID(t.artist)
		if err != nil {
			return added, issues, recredited, err
		}
		trackCredits, err := resolveCredits(t.artists)
		if err != nil {
			return added, issues, recredited, err
		}

		st, err := os.Stat(r.path)
		if err != nil {
			insIssue.Exec(r.path, err.Error(), time.Now().UnixMilli())
			issues++
			continue
		}
		var genre *string
		if t.genre != "" {
			genre = &t.genre
		}
		pending = append(pending, pendingTrack{
			updateID: r.updateID, path: r.path, title: t.title, albumID: alID, artistID: trackArtistID,
			trackNo: t.trackNo, discNo: t.discNo, duration: t.duration, genre: genre,
			mtime: st.ModTime().UnixMilli(), size: st.Size(), addedAt: time.Now().UnixMilli(),
			credits: trackCredits,
		})
		if len(pending) >= 200 {
			if err := flush(); err != nil {
				return added, issues, recredited, err
			}
		}
		if r.updateID == 0 {
			added++
		}
	}
	if err := flush(); err != nil {
		return added, issues, recredited, err
	}
	if err := flushCredits(); err != nil {
		return added, issues, recredited, err
	}
	return added, issues, recredited, nil
}

// dedupe mirrors the helper in tags.ts: trim, drop blanks, collapse repeats,
// keep tag order.
func dedupe(names []string) []string {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// albumArtistOrArtist mirrors scan.ts: the album is grouped under albumArtist ??
// artist.
func (t *tags) albumArtistOrArtist() string {
	if t.albumArtist != "" {
		return t.albumArtist
	}
	return t.artist
}

// readTags mirrors tags.ts against go.senan.xyz/taglib. Multi-value fields come
// back as ordered slices: ARTIST is read in full (matching music-metadata's
// common.artists), everything else takes [0] (its common.<field>).
func readTags(path string) (*tags, error) {
	raw, err := taglib.ReadTags(path)
	if err != nil {
		return nil, err
	}
	props, err := taglib.ReadProperties(path)
	if err != nil {
		return nil, err
	}
	// music-metadata rejects files with no recognisable stream; a zero-length,
	// zero-channel read is our equivalent signal.
	if props.Length == 0 && props.SampleRate == 0 && len(raw) == 0 {
		return nil, fmt.Errorf("unrecognized audio format")
	}

	first := func(k string) string {
		if v := raw[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}

	// Every ARTIST frame, not just the first.
	artists := dedupe(raw["ARTIST"])
	if len(artists) == 0 {
		artists = []string{"Unknown Artist"}
	}

	t := &tags{
		title:       orDefault(first("TITLE"), filepath.Base(path)),
		artist:      artists[0],
		artists:     artists,
		album:       orDefault(first("ALBUM"), "Unknown Album"),
		albumArtist: first("ALBUMARTIST"),
		genre:       first("GENRE"),
	}
	t.trackNo = parseLeadingInt(first("TRACKNUMBER"))
	t.discNo = parseLeadingInt(first("DISCNUMBER"))
	t.year = parseYear(first("DATE"), first("YEAR"))
	if props.Length > 0 {
		d := props.Length.Seconds()
		t.duration = &d
	}
	if img, err := taglib.ReadImage(path); err == nil && len(img) > 0 {
		t.picture = img
	}
	return t, nil
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// parseLeadingInt handles both "3" and ID3-style "3/12".
func parseLeadingInt(s string) *int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

// parseYear pulls the leading 4-digit year from DATE ("2017-02-21") or YEAR.
func parseYear(date, year string) *int64 {
	for _, s := range []string{date, year} {
		s = strings.TrimSpace(s)
		if len(s) >= 4 {
			if n, err := strconv.ParseInt(s[:4], 10, 64); err == nil && n > 0 {
				return &n
			}
		}
	}
	return nil
}
