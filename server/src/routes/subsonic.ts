// OpenSubsonic-compatible API: a translation layer over Localhost Music's own DB so
// third-party Subsonic clients (Feishin, Symfonium, play:Sub, Amperfy) can browse
// and play. The native /api is unchanged.
import { recordPlay } from "../lib/plays.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import {
  authenticate, sendSubsonic, sendSubsonicError, SubsonicError, ERR,
  decodeId, decodePlaylistId, toChild, toAlbumID3, toArtistID3, toPlaylist,
  encodeId, iso, parseLrc,
} from "../lib/subsonic.js";
import { transcodedFile, transcodeKey } from "../lib/transcode.js";
import { thumbnail, bucketSize } from "../lib/thumbnail.js";
import { config } from "../config.js";
import { getSettings } from "../lib/settings.js";
import { similarTracks, seedTrackFor } from "../lib/similar.js";
import * as sc from "../lib/scrobble.js";
import { isAlbumArtist } from "../lib/credits.js";

// Subsonic sends repeated params (songId=a&songId=b) which the query parser turns
// into an array; a single value stays scalar. Normalise to an array of strings.
const asArray = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
const asBool = (v: unknown) => v === true || v === "true" || v === "1";

// Album SELECT with the aggregates Subsonic needs (songCount/duration/created/genre).
const ALBUM_COLS = `
  al.id, al.title, al.year, al.artist_id, ar.name AS artist,
  (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS songCount,
  (SELECT COALESCE(SUM(t.duration),0) FROM tracks t WHERE t.album_id = al.id) AS duration,
  (SELECT MIN(t.added_at) FROM tracks t WHERE t.album_id = al.id) AS created,
  (SELECT t.genre FROM tracks t WHERE t.album_id = al.id AND t.genre IS NOT NULL AND t.genre <> '' LIMIT 1) AS genre`;
const ALBUM_FROM = `FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id`;
const ALBUM_HAS_TRACKS = `EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)`;

const TRACK_COLS = `
  t.id, t.path, t.title, t.album_id, t.artist_id, t.track_no, t.disc_no,
  t.duration, t.genre, t.size, t.added_at, ar.name AS artist, al.title AS album, al.year AS year`;
const TRACK_FROM = `FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id`;

export async function subsonicRoutes(app: FastifyInstance) {
  const db = app.db;

  // Single dispatcher: Subsonic clients call /rest/<action>[.view] via GET or POST.
  app.route({
    method: ["GET", "POST"],
    url: "/rest/:action",
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const action = String((req.params as any).action).replace(/\.view$/, "");
      const q = { ...(req.body as any), ...(req.query as any) }; // query wins

      try {
        const user = await authenticate(db, q, req.ip);
        return await dispatch(app, req, reply, action, q, user);
      } catch (e) {
        if (e instanceof SubsonicError) return sendSubsonicError(req, reply, e.code, e.message);
        req.log.error(e);
        return sendSubsonicError(req, reply, ERR.GENERIC, (e as Error)?.message ?? "server error");
      }
    },
  });
}

async function dispatch(
  app: FastifyInstance, req: FastifyRequest, reply: FastifyReply,
  action: string, q: any, user: { id: number; username: string; isAdmin: boolean }
) {
  const db = app.db;
  const S = (p: Record<string, unknown>) => sendSubsonic(req, reply, p);

  // Lazy per-request lookups for per-user starred/rating markers (each loaded once).
  const memo: Record<string, Map<number, number>> = {};
  const load = (key: string, sql: string, kv: (r: any) => [number, number]) =>
    (memo[key] ??= new Map((db.prepare(sql).all(user.id) as any[]).map(kv)));
  const favTracks = () => load("favT", "SELECT track_id, created_at FROM favorites WHERE user_id=?", (r) => [r.track_id, r.created_at ?? Date.now()]);
  const starAlbums = () => load("stA", "SELECT ref_id, created_at FROM subsonic_stars WHERE user_id=? AND kind='album'", (r) => [r.ref_id, r.created_at]);
  const starArtists = () => load("stAr", "SELECT ref_id, created_at FROM subsonic_stars WHERE user_id=? AND kind='artist'", (r) => [r.ref_id, r.created_at]);
  const rateTracks = () => load("rtT", "SELECT ref_id, rating FROM subsonic_ratings WHERE user_id=? AND kind='track'", (r) => [r.ref_id, r.rating]);
  const rateAlbums = () => load("rtA", "SELECT ref_id, rating FROM subsonic_ratings WHERE user_id=? AND kind='album'", (r) => [r.ref_id, r.rating]);
  const song = (t: any) => toChild(t, { starred: favTracks().get(t.id), rating: rateTracks().get(t.id) });
  const album = (a: any) => toAlbumID3(a, { starred: starAlbums().get(a.id), rating: rateAlbums().get(a.id) });
  const artist = (a: any) => toArtistID3(a, { starred: starArtists().get(a.id) });

  switch (action) {
    case "ping":
      return S({});

    case "getLicense":
      return S({ license: { valid: true } });

    case "getOpenSubsonicExtensions":
      return S({ openSubsonicExtensions: [] });

    case "getMusicFolders":
      return S({ musicFolders: { musicFolder: [{ id: 0, name: "Music" }] } });

    case "getUser":
      return S({
        user: {
          username: user.username, adminRole: user.isAdmin, streamRole: true,
          downloadRole: true, scrobblingEnabled: true, playlistRole: true, coverArtRole: true,
        },
      });

    case "getArtists":
    case "getIndexes": {
      const rows = db.prepare(`
        SELECT ar.id, ar.name,
          (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id
             AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS albumCount
        FROM artists ar
        WHERE ${isAlbumArtist("ar.id", "include")}
        ORDER BY ar.name COLLATE NOCASE`).all() as any[];
      const buckets = new Map<string, any[]>();
      for (const r of rows) {
        const c = (r.name?.[0] ?? "#").toUpperCase();
        const key = /[A-Z]/.test(c) ? c : "#";
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(artist(r));
      }
      const index = [...buckets.entries()].map(([name, artist]) => ({ name, artist }));
      const wrapper = action === "getArtists"
        ? { artists: { ignoredArticles: "", index } }
        : { indexes: { ignoredArticles: "", lastModified: Date.now(), index } };
      return S(wrapper);
    }

    case "getArtist": {
      const dec = decodeId(q.id);
      if (!dec || dec.kind !== "artist") throw new SubsonicError(ERR.NOT_FOUND, "Artist not found.");
      const ar = db.prepare(`
        SELECT ar.id, ar.name,
          (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id
             AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS albumCount
        FROM artists ar WHERE ar.id = ?`).get(dec.num) as any;
      if (!ar) throw new SubsonicError(ERR.NOT_FOUND, "Artist not found.");
      // Albums they own, plus albums they're only credited on (a guest artist owns nothing).
      const albums = db.prepare(
        `SELECT ${ALBUM_COLS} ${ALBUM_FROM}
         WHERE (al.artist_id = ?
                OR EXISTS (SELECT 1 FROM track_artists ta JOIN tracks t2 ON t2.id = ta.track_id
                           WHERE ta.artist_id = ? AND t2.album_id = al.id))
           AND ${ALBUM_HAS_TRACKS}
         ORDER BY al.year, al.title COLLATE NOCASE`).all(dec.num, dec.num) as any[];
      return S({ artist: { ...artist(ar), album: albums.map(album) } });
    }

    case "getAlbumList2":
    case "getAlbumList": {
      const size = Math.min(500, Math.max(1, Number(q.size) || 10));
      const offset = Math.max(0, Number(q.offset) || 0);
      const type = String(q.type);
      const where = [ALBUM_HAS_TRACKS];
      const params: any[] = [];
      let order = "created DESC";
      if (type === "alphabeticalByName") order = "al.title COLLATE NOCASE";
      else if (type === "alphabeticalByArtist") order = "ar.name COLLATE NOCASE, al.year";
      else if (type === "random") order = "RANDOM()";
      else if (type === "byGenre") {
        where.push("EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.genre = ? COLLATE NOCASE)");
        params.push(String(q.genre ?? ""));
        order = "al.title COLLATE NOCASE";
      } else if (type === "byYear") {
        const from = Number(q.fromYear), to = Number(q.toYear);
        if (Number.isFinite(from) && Number.isFinite(to)) {
          where.push("al.year BETWEEN ? AND ?");
          params.push(Math.min(from, to), Math.max(from, to));
          order = from <= to ? "al.year" : "al.year DESC"; // from>to = descending range
        } else order = "al.year";
      } else if (type === "recent" || type === "frequent") {
        // recent = most recently played, frequent = most played. play_counts is
        // per-track and global, so aggregate over each album's tracks. Only albums
        // that have been played are returned.
        const agg = type === "recent" ? "MAX(pc.last_played)" : "SUM(pc.count)";
        const j = "play_counts pc JOIN tracks t ON t.id = pc.track_id WHERE t.album_id = al.id";
        where.push(`EXISTS (SELECT 1 FROM ${j})`);
        order = `(SELECT ${agg} FROM ${j}) DESC`;
      } else if (type === "starred") {
        // This user's starred albums, most recently starred first. user.id is a
        // trusted integer (authenticated), inlined to keep this branch out of the
        // positional-param sequence below.
        const c = `subsonic_stars s WHERE s.user_id = ${Number(user.id)} AND s.kind = 'album' AND s.ref_id = al.id`;
        where.push(`EXISTS (SELECT 1 FROM ${c})`);
        order = `(SELECT s.created_at FROM ${c}) DESC`;
      } else if (type === "highest") {
        // This user's highest-rated albums.
        const c = `subsonic_ratings r WHERE r.user_id = ${Number(user.id)} AND r.kind = 'album' AND r.ref_id = al.id`;
        where.push(`EXISTS (SELECT 1 FROM ${c})`);
        order = `(SELECT r.rating FROM ${c}) DESC`;
      }
      params.push(size, offset);
      const albums = db.prepare(
        `SELECT ${ALBUM_COLS} ${ALBUM_FROM} WHERE ${where.join(" AND ")}
         ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params) as any[];
      // getAlbumList (v1) uses <album> Child entries; getAlbumList2 uses AlbumID3.
      const key = action === "getAlbumList2" ? "albumList2" : "albumList";
      return S({ [key]: { album: albums.map(album) } });
    }

    case "getAlbum": {
      const dec = decodeId(q.id);
      if (!dec || dec.kind !== "album") throw new SubsonicError(ERR.NOT_FOUND, "Album not found.");
      const al = db.prepare(
        `SELECT ${ALBUM_COLS} ${ALBUM_FROM} WHERE al.id = ?`).get(dec.num) as any;
      if (!al) throw new SubsonicError(ERR.NOT_FOUND, "Album not found.");
      const songs = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.album_id = ?
         ORDER BY t.disc_no, t.track_no, t.title COLLATE NOCASE`).all(dec.num) as any[];
      return S({ album: { ...album(al), song: songs.map(song) } });
    }

    case "getSong": {
      const dec = decodeId(q.id);
      if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");
      const t = db.prepare(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id = ?`).get(dec.num) as any;
      if (!t) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");
      return S({ song: song(t) });
    }

    case "search3":
    case "search2": {
      const query = String(q.query ?? "").trim();
      const like = `%${query.replace(/[%_]/g, (m) => "\\" + m)}%`;
      const artistCount = Number(q.artistCount) || 20;
      const albumCount = Number(q.albumCount) || 20;
      const songCount = Number(q.songCount) || 20;
      const all = query === ""; // some clients send an empty query to list everything

      const artists = db.prepare(`
        SELECT ar.id, ar.name,
          (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id
             AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS albumCount
        FROM artists ar
        WHERE ${isAlbumArtist("ar.id", "include")}
          AND (${all ? "1" : "ar.name LIKE ? ESCAPE '\\'"})
        ORDER BY ar.name COLLATE NOCASE LIMIT ?`).all(...(all ? [] : [like]), artistCount) as any[];
      const albums = db.prepare(
        `SELECT ${ALBUM_COLS} ${ALBUM_FROM}
         WHERE ${ALBUM_HAS_TRACKS} AND (${all ? "1" : "al.title LIKE ? ESCAPE '\\'"})
         ORDER BY al.title COLLATE NOCASE LIMIT ?`).all(...(all ? [] : [like]), albumCount) as any[];
      const songs = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM}
         WHERE (${all ? "1" : "t.title LIKE ? ESCAPE '\\'"})
         ORDER BY t.title COLLATE NOCASE LIMIT ?`).all(...(all ? [] : [like]), songCount) as any[];

      const key = action === "search3" ? "searchResult3" : "searchResult2";
      return S({
        [key]: {
          artist: artists.map(artist),
          album: albums.map(album),
          song: songs.map(song),
        },
      });
    }

    case "stream":
    case "download": {
      const dec = decodeId(q.id);
      if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");
      const t = db.prepare("SELECT path FROM tracks WHERE id = ?").get(dec.num) as any;
      if (!t || !existsSync(t.path)) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");

      // download and format=raw always serve the original. Otherwise honour
      // maxBitRate by transcoding to mp3 at that cap (cached, range-seekable).
      const maxBitRate = Number(q.maxBitRate) || 0;
      const raw = action === "download" || String(q.format ?? "").toLowerCase() === "raw";
      let path = t.path, contentType = audioContentType(t.path);
      if (!raw && maxBitRate > 0) {
        try {
          const dir = getSettings(db).transcodeDir;
          path = await transcodedFile(transcodeKey(t.path, maxBitRate), t.path, maxBitRate, dir, "mp3");
          contentType = "audio/mpeg";
        } catch (e) {
          throw new SubsonicError(ERR.GENERIC, `transcode failed: ${(e as Error)?.message ?? e}`);
        }
      }
      return sendFileWithRange(req, reply, path, contentType);
    }

    case "getCoverArt": {
      const id = String(q.id ?? "");
      let coverPath: string | undefined;
      if (id.startsWith("pl-")) {
        coverPath = (db.prepare("SELECT cover_path FROM playlists WHERE id = ?").get(decodePlaylistId(id)) as any)?.cover_path;
      } else {
        const dec = decodeId(id);
        if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Cover not found.");
        if (dec.kind === "artist") {
          coverPath = (db.prepare("SELECT path FROM artist_images WHERE artist_id = ?").get(dec.num) as any)?.path;
        } else {
          // Album cover; a track id resolves to its album's cover.
          const albumNum = dec.kind === "track"
            ? (db.prepare("SELECT album_id FROM tracks WHERE id = ?").get(dec.num) as any)?.album_id
            : dec.num;
          coverPath = albumNum != null
            ? (db.prepare("SELECT cover_path FROM albums WHERE id = ?").get(albumNum) as any)?.cover_path
            : undefined;
        }
      }
      if (!coverPath || !existsSync(coverPath)) throw new SubsonicError(ERR.NOT_FOUND, "Cover not found.");
      // ?size=N serves a cached square JPEG thumbnail (snapped to a bucket), same
      // pipeline as the native API.
      const size = bucketSize(q.size);
      if (size) {
        try {
          const thumb = await thumbnail(coverPath, size, join(config.dataDir, "thumb-cache"));
          return sendFileWithRange(req, reply, thumb, "image/jpeg");
        } catch { /* resize failed, fall through to the original */ }
      }
      const ct = extname(coverPath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
      return sendFileWithRange(req, reply, coverPath, ct);
    }

    case "scrobble": {
      // submission=false is a "now playing" ping. true (default) is a completed play:
      // bump play_counts and forward to the user's scrobble services (best-effort).
      const submission = q.submission === undefined ? true : asBool(q.submission);
      for (const rawId of asArray(q.id)) {
        const dec = decodeId(rawId);
        if (!dec) continue;
        const meta = db.prepare(
          `SELECT t.title AS track, ar.name AS artist, al.title AS album
           FROM tracks t LEFT JOIN artists ar ON ar.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id
           WHERE t.id=?`).get(dec.num) as any;
        if (!meta?.track || !meta?.artist) continue;
        const np: sc.NowPlaying = { artist: meta.artist, track: meta.track, album: meta.album || undefined };
        const accounts = db.prepare(
          "SELECT provider, token FROM scrobble_accounts WHERE user_id=?").all(user.id) as any[];
        if (submission) {
          recordPlay(db, user.id, dec.num, Number(q.time) || Date.now());
          const listenedAt = Math.floor((Number(q.time) || Date.now()) / 1000);
          for (const a of accounts) {
            if (a.provider === "listenbrainz") sc.lbListen(a.token, { ...np, listenedAt }).catch(() => {});
            else if (a.provider === "lastfm") sc.lfmScrobble(a.token, { ...np, listenedAt }).catch(() => {});
          }
        } else {
          for (const a of accounts) {
            if (a.provider === "listenbrainz") sc.lbNowPlaying(a.token, np).catch(() => {});
            else if (a.provider === "lastfm") sc.lfmNowPlaying(a.token, np).catch(() => {});
          }
        }
      }
      return S({});
    }

    case "star":
    case "unstar": {
      // Tracks go to the native `favorites` table (so Localhost Music's own UI stays in sync),
      // albums/artists to `subsonic_stars`. Ids arrive via id / albumId / artistId.
      const starring = action === "star", now = Date.now();
      const tracks: number[] = [], albums: number[] = [], artists: number[] = [];
      for (const raw of asArray(q.id)) {
        const d = decodeId(raw);
        if (d?.kind === "track") tracks.push(d.num);
        else if (d?.kind === "album") albums.push(d.num);
        else if (d?.kind === "artist") artists.push(d.num);
      }
      for (const raw of asArray(q.albumId)) { const d = decodeId(raw); if (d) albums.push(d.num); }
      for (const raw of asArray(q.artistId)) { const d = decodeId(raw); if (d) artists.push(d.num); }

      const favIns = db.prepare("INSERT OR IGNORE INTO favorites(user_id, track_id, created_at) VALUES(?,?,?)");
      const favDel = db.prepare("DELETE FROM favorites WHERE user_id=? AND track_id=?");
      const stIns = db.prepare("INSERT OR IGNORE INTO subsonic_stars(user_id, kind, ref_id, created_at) VALUES(?,?,?,?)");
      const stDel = db.prepare("DELETE FROM subsonic_stars WHERE user_id=? AND kind=? AND ref_id=?");
      db.transaction(() => {
        for (const id of tracks) { if (starring) favIns.run(user.id, id, now); else favDel.run(user.id, id); }
        for (const id of albums) { if (starring) stIns.run(user.id, "album", id, now); else stDel.run(user.id, "album", id); }
        for (const id of artists) { if (starring) stIns.run(user.id, "artist", id, now); else stDel.run(user.id, "artist", id); }
      })();
      return S({});
    }

    case "setRating": {
      const dec = decodeId(q.id);
      const rating = Number(q.rating);
      if (!dec || !Number.isFinite(rating) || rating < 0 || rating > 5) {
        throw new SubsonicError(ERR.MISSING_PARAM, "id and rating (0-5) are required.");
      }
      const kind = dec.kind === "album" ? "album" : dec.kind === "track" ? "track" : null;
      if (!kind) throw new SubsonicError(ERR.GENERIC, "Rating is only supported on songs and albums.");
      if (rating === 0) db.prepare("DELETE FROM subsonic_ratings WHERE user_id=? AND kind=? AND ref_id=?").run(user.id, kind, dec.num);
      else db.prepare("INSERT OR REPLACE INTO subsonic_ratings(user_id, kind, ref_id, rating) VALUES(?,?,?,?)").run(user.id, kind, dec.num, rating);
      return S({});
    }

    case "getStarred2":
    case "getStarred": {
      const songs = (db.prepare(
        `SELECT ${TRACK_COLS}, f.created_at AS starred_at ${TRACK_FROM}
         JOIN favorites f ON f.track_id = t.id AND f.user_id = ?
         ORDER BY f.created_at DESC, t.title COLLATE NOCASE`).all(user.id) as any[])
        .map((t) => toChild(t, { starred: t.starred_at ?? Date.now(), rating: rateTracks().get(t.id) }));
      const albums = (db.prepare(
        `SELECT ${ALBUM_COLS}, s.created_at AS starred_at ${ALBUM_FROM}
         JOIN subsonic_stars s ON s.ref_id = al.id AND s.user_id = ? AND s.kind = 'album'
         ORDER BY s.created_at DESC`).all(user.id) as any[])
        .map((a) => toAlbumID3(a, { starred: a.starred_at, rating: rateAlbums().get(a.id) }));
      const artists = (db.prepare(
        `SELECT ar.id, ar.name, s.created_at AS starred_at,
           (SELECT COUNT(*) FROM albums al WHERE al.artist_id = ar.id
              AND EXISTS(SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS albumCount
         FROM artists ar JOIN subsonic_stars s ON s.ref_id = ar.id AND s.user_id = ? AND s.kind = 'artist'
         ORDER BY s.created_at DESC`).all(user.id) as any[])
        .map((a) => toArtistID3(a, { starred: a.starred_at }));
      const key = action === "getStarred2" ? "starred2" : "starred";
      return S({ [key]: { song: songs, album: albums, artist: artists } });
    }

    case "getPlaylists": {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.description, p.cover_path, p.created_at, ? AS owner,
          (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS songCount,
          (SELECT COALESCE(SUM(t.duration),0) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = p.id) AS duration
        FROM playlists p WHERE p.user_id = ? ORDER BY p.name COLLATE NOCASE`).all(user.username, user.id) as any[];
      return S({ playlists: { playlist: rows.map(toPlaylist) } });
    }

    case "getPlaylist": {
      const plId = decodePlaylistId(q.id);
      const pl = playlistWithMeta(db, plId, user);
      if (!pl) throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found.");
      const entries = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM}
         JOIN playlist_tracks pt ON pt.track_id = t.id
         WHERE pt.playlist_id = ? ORDER BY pt.position`).all(plId) as any[];
      return S({ playlist: { ...toPlaylist(pl), entry: entries.map(song) } });
    }

    case "createPlaylist": {
      // With playlistId, replace that playlist's contents; else create a new one.
      const existingId = q.playlistId ? decodePlaylistId(q.playlistId) : null;
      const songIds = asArray(q.songId).map((s) => decodeId(s)?.num).filter((n): n is number => !!n);
      let plId: number;
      if (existingId != null) {
        if (!db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(existingId, user.id))
          throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found.");
        plId = existingId;
        db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=?").run(plId);
        if (q.name) db.prepare("UPDATE playlists SET name=? WHERE id=?").run(String(q.name), plId);
      } else {
        const name = String(q.name ?? "").trim() || "Playlist";
        plId = db.prepare("INSERT INTO playlists(user_id, name, created_at) VALUES(?,?,?)")
          .run(user.id, name, Date.now()).lastInsertRowid as number;
      }
      insertPlaylistTracks(db, plId, songIds);
      const pl = playlistWithMeta(db, plId, user)!;
      const entries = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM} JOIN playlist_tracks pt ON pt.track_id = t.id
         WHERE pt.playlist_id = ? ORDER BY pt.position`).all(plId) as any[];
      return S({ playlist: { ...toPlaylist(pl), entry: entries.map(song) } });
    }

    case "updatePlaylist": {
      const plId = decodePlaylistId(q.playlistId);
      if (!db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(plId, user.id))
        throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found.");
      if (q.name !== undefined) db.prepare("UPDATE playlists SET name=? WHERE id=?").run(String(q.name), plId);
      if (q.comment !== undefined) db.prepare("UPDATE playlists SET description=? WHERE id=?").run(String(q.comment) || null, plId);
      const toAdd = asArray(q.songIdToAdd).map((s) => decodeId(s)?.num).filter((n): n is number => !!n);
      if (toAdd.length) insertPlaylistTracks(db, plId, toAdd);
      // songIndexToRemove is 0-based positions into the current ordered list.
      const toRemove = asArray(q.songIndexToRemove).map(Number).filter(Number.isFinite);
      if (toRemove.length) {
        const ordered = db.prepare("SELECT track_id, position FROM playlist_tracks WHERE playlist_id=? ORDER BY position").all(plId) as any[];
        const rm = new Set(toRemove);
        const del = db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=? AND position=?");
        db.transaction(() => { ordered.forEach((r, i) => { if (rm.has(i)) del.run(plId, r.position); }); })();
      }
      return S({});
    }

    case "deletePlaylist": {
      const plId = decodePlaylistId(q.id);
      if (!db.prepare("SELECT 1 FROM playlists WHERE id=? AND user_id=?").get(plId, user.id))
        throw new SubsonicError(ERR.NOT_FOUND, "Playlist not found.");
      db.prepare("DELETE FROM playlist_tracks WHERE playlist_id=?").run(plId);
      db.prepare("DELETE FROM playlists WHERE id=?").run(plId);
      return S({});
    }

    case "getLyricsBySongId": {
      const dec = decodeId(q.id);
      const row = dec ? db.prepare("SELECT synced, plain FROM track_lyrics WHERE track_id=?").get(dec.num) as any : null;
      const structured: any[] = [];
      if (row?.synced) {
        const lines = parseLrc(row.synced);
        if (lines) structured.push({ lang: "und", synced: true, line: lines.map((l) => ({ start: l.start, value: l.value })) });
      }
      if (!structured.length && row?.plain) {
        const line = String(row.plain).split(/\r?\n/).map((value: string) => ({ value }));
        structured.push({ lang: "und", synced: false, line });
      }
      return S({ lyricsList: { structuredLyrics: structured } });
    }

    case "getLyrics": {
      // Legacy: match a track by artist + title, return its plain text.
      const t = db.prepare(
        `SELECT t.id FROM tracks t LEFT JOIN artists ar ON ar.id=t.artist_id
         WHERE t.title = ? COLLATE NOCASE AND (? = '' OR ar.name = ? COLLATE NOCASE) LIMIT 1`
      ).get(String(q.title ?? ""), String(q.artist ?? ""), String(q.artist ?? "")) as any;
      const row = t ? db.prepare("SELECT synced, plain FROM track_lyrics WHERE track_id=?").get(t.id) as any : null;
      let value = row?.plain ?? "";
      if (!value && row?.synced) value = String(row.synced).replace(/\[[^\]]*\]/g, "").trim();
      return S({ lyrics: { artist: q.artist, title: q.title, value } });
    }

    case "getGenres": {
      const rows = db.prepare(`
        SELECT t.genre AS value, COUNT(*) AS songCount, COUNT(DISTINCT t.album_id) AS albumCount
        FROM tracks t WHERE t.genre IS NOT NULL AND t.genre <> ''
        GROUP BY t.genre COLLATE NOCASE ORDER BY t.genre COLLATE NOCASE`).all() as any[];
      return S({ genres: { genre: rows } });
    }

    case "getRandomSongs": {
      const size = Math.min(500, Math.max(1, Number(q.size) || 10));
      const where: string[] = [], params: any[] = [];
      if (q.genre) { where.push("t.genre = ? COLLATE NOCASE"); params.push(String(q.genre)); }
      if (q.fromYear) { where.push("al.year >= ?"); params.push(Number(q.fromYear)); }
      if (q.toYear) { where.push("al.year <= ?"); params.push(Number(q.toYear)); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const rows = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM} ${w} ORDER BY RANDOM() LIMIT ?`).all(...params, size) as any[];
      return S({ randomSongs: { song: rows.map(song) } });
    }

    case "getSongsByGenre": {
      const count = Math.min(500, Math.max(1, Number(q.count) || 10));
      const offset = Math.max(0, Number(q.offset) || 0);
      const rows = db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.genre = ? COLLATE NOCASE
         ORDER BY t.title COLLATE NOCASE LIMIT ? OFFSET ?`).all(String(q.genre ?? ""), count, offset) as any[];
      return S({ songsByGenre: { song: rows.map(song) } });
    }

    case "getSimilarSongs":
    case "getSimilarSongs2": {
      // Last.fm similar-artists (matched to this library) with local fallbacks,
      // see lib/similar.ts.
      const dec = decodeId(q.id);
      if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Not found.");
      const count = Math.min(500, Math.max(1, Number(q.count) || 50));
      const seedTrack = seedTrackFor(db, dec.kind, dec.num);
      const rows = seedTrack != null ? await similarTracks(db, seedTrack, count) : [];
      const key = action === "getSimilarSongs2" ? "similarSongs2" : "similarSongs";
      return S({ [key]: { song: rows.map(song) } });
    }

    case "getArtistInfo2":
    case "getArtistInfo": {
      const dec = decodeId(q.id);
      if (!dec || dec.kind !== "artist") throw new SubsonicError(ERR.NOT_FOUND, "Artist not found.");
      const info = db.prepare("SELECT bio, mbid FROM artist_info WHERE artist_id=?").get(dec.num) as any;
      const hasImg = !!db.prepare("SELECT 1 FROM artist_images WHERE artist_id=?").get(dec.num);
      const img = hasImg ? coverArtUrl(req, q, encodeId.artist(dec.num)) : undefined;
      const key = action === "getArtistInfo2" ? "artistInfo2" : "artistInfo";
      return S({ [key]: {
        biography: info?.bio || undefined,
        musicBrainzId: info?.mbid || undefined,
        smallImageUrl: img, mediumImageUrl: img, largeImageUrl: img,
      } });
    }

    case "getAlbumInfo2":
    case "getAlbumInfo": {
      const dec = decodeId(q.id);
      if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Album not found.");
      const albumNum = dec.kind === "track"
        ? (db.prepare("SELECT album_id FROM tracks WHERE id=?").get(dec.num) as any)?.album_id
        : dec.num;
      // Localhost Music keeps no album notes; return the cover so clients still get art.
      const img = albumNum != null ? coverArtUrl(req, q, encodeId.album(albumNum)) : undefined;
      return S({ albumInfo: { smallImageUrl: img, mediumImageUrl: img, largeImageUrl: img } });
    }

    case "getNowPlaying": {
      // Derived from saved player sessions: each user actively playing something,
      // respecting their share-activity toggle.
      const rows = db.prepare(
        `SELECT ps.user_id, ps.state, ps.updated_at, u.username, u.share_activity
         FROM player_sessions ps JOIN users u ON u.id = ps.user_id`).all() as any[];
      const now = Date.now();
      const entry: any[] = [];
      for (const r of rows) {
        if (r.user_id !== user.id && !r.share_activity) continue; // hidden users invisible to others
        let st: any; try { st = JSON.parse(r.state); } catch { continue; }
        const ct = st?.queue?.[st?.order?.[st?.pos]];
        if (!ct?.id || !st.isPlaying) continue; // only surface active playback
        const t = db.prepare(`SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id = ?`).get(ct.id) as any;
        if (!t) continue;
        entry.push({ ...song(t), username: r.username, playerId: 0,
          minutesAgo: Math.max(0, Math.round((now - r.updated_at) / 60000)) });
      }
      return S({ nowPlaying: { entry } });
    }

    // Features Localhost Music doesn't have, stubbed empty but valid so clients don't error
    // on their initial sync.
    case "getScanStatus":
      return S({ scanStatus: { scanning: false, count: (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as any).n } });
    case "savePlayQueue": {
      const ids = asArray(q.id).map((s) => decodeId(s)?.num).filter((n): n is number => !!n);
      if (!ids.length) { db.prepare("DELETE FROM play_queues WHERE user_id=?").run(user.id); return S({}); }
      const current = q.current !== undefined ? decodeId(q.current)?.num ?? null : null;
      db.prepare(
        `INSERT OR REPLACE INTO play_queues(user_id, ids, current, position, changed, changed_by)
         VALUES(?,?,?,?,?,?)`).run(user.id, JSON.stringify(ids), current, Number(q.position) || 0, Date.now(), String(q.c ?? ""));
      return S({});
    }

    case "getPlayQueue": {
      const row = db.prepare("SELECT ids, current, position, changed, changed_by FROM play_queues WHERE user_id=?").get(user.id) as any;
      if (!row) return S({}); // nothing saved: OK with no playQueue
      const ids: number[] = JSON.parse(row.ids);
      const byId = new Map((db.prepare(
        `SELECT ${TRACK_COLS} ${TRACK_FROM} WHERE t.id IN (${ids.map(() => "?").join(",") || "NULL"})`)
        .all(...ids) as any[]).map((t) => [t.id, t]));
      const entry = ids.map((id) => byId.get(id)).filter(Boolean).map(song); // preserve order
      return S({ playQueue: {
        current: row.current != null ? encodeId.track(row.current) : undefined,
        position: row.position ?? 0,
        changed: iso(row.changed),
        changedBy: row.changed_by || undefined,
        username: user.username,
        entry,
      } });
    }
    case "getBookmarks": {
      const rows = db.prepare(
        `SELECT ${TRACK_COLS}, b.position AS bm_position, b.comment AS bm_comment,
                b.created AS bm_created, b.changed AS bm_changed
         ${TRACK_FROM} JOIN bookmarks b ON b.track_id = t.id
         WHERE b.user_id = ? ORDER BY b.changed DESC`).all(user.id) as any[];
      return S({ bookmarks: { bookmark: rows.map((r) => ({
        position: r.bm_position,
        username: user.username,
        comment: r.bm_comment || undefined,
        created: iso(r.bm_created),
        changed: iso(r.bm_changed),
        entry: song(r),
      })) } });
    }
    case "createBookmark": {
      const dec = decodeId(q.id);
      if (!dec || dec.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "Bookmark target must be a song.");
      if (!db.prepare("SELECT 1 FROM tracks WHERE id = ?").get(dec.num)) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");
      const pos = Math.max(0, Math.round(Number(q.position) || 0));
      const now = Date.now();
      db.prepare(
        `INSERT INTO bookmarks(user_id, track_id, position, comment, created, changed)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(user_id, track_id) DO UPDATE SET
           position = excluded.position, comment = excluded.comment, changed = excluded.changed`
      ).run(user.id, dec.num, pos, q.comment != null ? String(q.comment) : null, now, now);
      return S({});
    }
    case "deleteBookmark": {
      const dec = decodeId(q.id);
      if (!dec) throw new SubsonicError(ERR.NOT_FOUND, "Song not found.");
      db.prepare("DELETE FROM bookmarks WHERE user_id = ? AND track_id = ?").run(user.id, dec.num);
      return S({});
    }
    case "getShares": return S({ shares: {} });
    case "getInternetRadioStations": {
      const rows = db.prepare(
        `SELECT id, name, stream_url, homepage_url FROM internet_radio_stations
         WHERE user_id = ? ORDER BY name COLLATE NOCASE`).all(user.id) as any[];
      return S({ internetRadioStations: { internetRadioStation: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        streamUrl: r.stream_url,
        homePageUrl: r.homepage_url || undefined,
      })) } });
    }
    case "createInternetRadioStation": {
      const name = String(q.name ?? "").trim();
      const streamUrl = String(q.streamUrl ?? "").trim();
      if (!name || !streamUrl) throw new SubsonicError(ERR.MISSING_PARAM, "createInternetRadioStation needs 'name' and 'streamUrl'.");
      db.prepare(
        `INSERT INTO internet_radio_stations(user_id, name, stream_url, homepage_url, created)
         VALUES(?,?,?,?,?)`).run(user.id, name, streamUrl, q.homepageUrl ? String(q.homepageUrl) : null, Date.now());
      return S({});
    }
    case "updateInternetRadioStation": {
      const id = Number(q.id);
      const name = String(q.name ?? "").trim();
      const streamUrl = String(q.streamUrl ?? "").trim();
      if (!id || !name || !streamUrl) throw new SubsonicError(ERR.MISSING_PARAM, "updateInternetRadioStation needs 'id', 'name', and 'streamUrl'.");
      const r = db.prepare(
        `UPDATE internet_radio_stations SET name=?, stream_url=?, homepage_url=?
         WHERE id=? AND user_id=?`).run(name, streamUrl, q.homepageUrl ? String(q.homepageUrl) : null, id, user.id);
      if (!r.changes) throw new SubsonicError(ERR.NOT_FOUND, "Station not found.");
      return S({});
    }
    case "deleteInternetRadioStation": {
      const id = Number(q.id);
      db.prepare("DELETE FROM internet_radio_stations WHERE id=? AND user_id=?").run(id, user.id);
      return S({});
    }
    case "getPodcasts": return S({ podcasts: {} });
    case "getNewestPodcasts": return S({ newestPodcasts: {} });

    default:
      throw new SubsonicError(ERR.GENERIC, `Unsupported operation: ${action}`);
  }
}

// Fetch a playlist the user owns, with the songCount/duration aggregates + owner
// that toPlaylist needs. Returns null if missing or not owned.
function playlistWithMeta(db: any, plId: number, user: { id: number; username: string }): any {
  return db.prepare(`
    SELECT p.id, p.name, p.description, p.cover_path, p.created_at, ? AS owner,
      (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS songCount,
      (SELECT COALESCE(SUM(t.duration),0) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = p.id) AS duration
    FROM playlists p WHERE p.id = ? AND p.user_id = ?`).get(user.username, plId, user.id);
}

// Append tracks to a playlist after its current max position (skips ids that
// aren't real tracks, so a bad id can't break the batch).
function insertPlaylistTracks(db: any, plId: number, trackIds: number[]) {
  let next = (db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS p FROM playlist_tracks WHERE playlist_id=?").get(plId) as any).p;
  const exists = db.prepare("SELECT 1 FROM tracks WHERE id=?");
  const ins = db.prepare("INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES(?,?,?)");
  db.transaction(() => { for (const id of trackIds) if (exists.get(id)) ins.run(plId, id, next++); })();
}

// Build an absolute getCoverArt URL, echoing the caller's own auth params so the
// client can fetch it with the same credentials.
function coverArtUrl(req: FastifyRequest, q: any, id: string): string {
  const proto = String((req.headers["x-forwarded-proto"] as string) || req.protocol || "http").split(",")[0];
  const host = req.headers.host ?? "localhost";
  const p = new URLSearchParams({ id });
  for (const k of ["u", "p", "t", "s", "c", "v"]) if (q[k] !== undefined) p.set(k, String(q[k]));
  return `${proto}://${host}/rest/getCoverArt.view?${p.toString()}`;
}

function audioContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".m4a": case ".m4b": case ".mp4": case ".aac": return "audio/mp4";
    case ".flac": return "audio/flac";
    case ".wav": return "audio/wav";
    case ".ogg": case ".oga": case ".opus": return "audio/ogg";
    case ".aif": case ".aiff": return "audio/aiff";
    default: return "audio/mpeg";
  }
}

// Range-capable file send (streaming + cover art). Mirrors the native stream
// route's range handling so Subsonic clients can seek.
function sendFileWithRange(req: FastifyRequest, reply: FastifyReply, path: string, contentType: string) {
  const size = statSync(path).size;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = NaN, end = NaN;
    if (m && m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else if (m && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    if (!Number.isFinite(start) || start < 0 || start >= size || start > end) {
      return reply.code(416).header("content-range", `bytes */${size}`).send();
    }
    reply.code(206)
      .header("content-range", `bytes ${start}-${end}/${size}`)
      .header("accept-ranges", "bytes")
      .header("content-length", end - start + 1)
      .type(contentType);
    return createReadStream(path, { start, end });
  }
  reply.header("accept-ranges", "bytes").header("content-length", size).type(contentType);
  return createReadStream(path);
}
