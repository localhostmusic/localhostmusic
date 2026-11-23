package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestRescanUpdatesFileAndPreservesTrackID(t *testing.T) {
	root := t.TempDir()
	music := filepath.Join(root, "music")
	if err := os.Mkdir(music, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(music, "song.mp3")
	copySong := func(name string) {
		data, err := os.ReadFile(filepath.Join("..", "test", "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	copySong("song-a.mp3")
	dbPath := filepath.Join(root, "lhm.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema, err := os.ReadFile(filepath.Join("..", "src", "db", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`ALTER TABLE tracks ADD COLUMN credits_v INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE track_artists(track_id INTEGER,artist_id INTEGER,role TEXT,position INTEGER,PRIMARY KEY(track_id,artist_id));`); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = run(music, root, dbPath, 2); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err = db.QueryRow("SELECT id FROM tracks").Scan(&id); err != nil {
		t.Fatal(err)
	}
	copySong("song-b.mp3")
	tags, err := readTags(path)
	if err != nil {
		t.Fatal(err)
	}
	added, issues, _, err := run(music, root, dbPath, 2)
	if err != nil || added != 0 || issues != 0 {
		t.Fatalf("rescan: added=%d issues=%d err=%v", added, issues, err)
	}
	var actualID int64
	var title string
	if err = db.QueryRow("SELECT id,title FROM tracks").Scan(&actualID, &title); err != nil {
		t.Fatal(err)
	}
	if actualID != id || title != tags.title {
		t.Fatalf("got id=%d title=%q; want id=%d title=%q", actualID, title, id, tags.title)
	}
	var matches int
	if err = db.QueryRow("SELECT COUNT(*) FROM search_fts WHERE kind='track' AND ref_id=? AND name=?", id, title).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("stale or duplicate FTS entries: %d", matches)
	}
}
