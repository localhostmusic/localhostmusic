-- Frozen v1 baseline of the schema (PRAGMA user_version = 1).
-- Do not add tables or columns here: existing databases never re-run this file.
-- Every schema change is a new numbered migration in server/src/db/migrate.ts.

CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id INTEGER REFERENCES artists(id),
  year INTEGER,
  cover_path TEXT,
  UNIQUE(title, artist_id)
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  album_id INTEGER REFERENCES albums(id),
  artist_id INTEGER REFERENCES artists(id),
  track_no INTEGER,
  disc_no INTEGER,
  duration REAL,
  genre TEXT,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  added_at INTEGER,
  loudness REAL  -- integrated EBU R128 loudness (LUFS) for volume normalization; NULL = unmeasured
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0
);
-- "Admin" and "admin" can't coexist (login lookup is case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  dedicated_to TEXT,
  mood TEXT,
  cover_path TEXT
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  PRIMARY KEY (user_id, track_id)
);
CREATE TABLE IF NOT EXISTS scan_issues (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  error TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS play_counts (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  subject TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artist_images (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  source TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS track_lyrics (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  synced TEXT,
  plain TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE TABLE IF NOT EXISTS artist_info (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  bio TEXT,
  type TEXT,
  area TEXT,
  begin TEXT,
  ended TEXT,
  genres TEXT,
  mbid TEXT,
  fetched_at INTEGER NOT NULL
);
-- Cached MusicBrainz release-group list per artist (full discography, incl.
-- albums not in the library). JSON array.
CREATE TABLE IF NOT EXISTS artist_discography (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
-- Discography cache keyed by MusicBrainz id, for artists not in the library.
CREATE TABLE IF NOT EXISTS discography_cache (
  mbid TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
-- Personalized Discover feed per user (recommendations + new releases), cached.
CREATE TABLE IF NOT EXISTS discover_feed (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
-- Shared playback session per user (Connect). Now-playing state as JSON,
-- so it survives restarts and seeds new devices.
CREATE TABLE IF NOT EXISTS player_sessions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind, ref_id UNINDEXED, name
);

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  updated_at INTEGER
);

-- In-app notifications (e.g. "your album request was acquired").
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);

-- Most list endpoints join or subquery on these columns.
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
CREATE INDEX IF NOT EXISTS idx_play_counts_last_played ON play_counts(last_played);

-- Admin-editable app settings. One row per key, JSON-encoded value. Absent keys
-- fall back to env/config defaults.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-user connection to a scrobble service. No row = not connected, nothing is
-- sent. `token` is the ListenBrainz user token or the Last.fm session key.
CREATE TABLE IF NOT EXISTS scrobble_accounts (
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,        -- 'listenbrainz' | 'lastfm'
  token TEXT NOT NULL,
  username TEXT,                 -- the service username, for display
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Genre browse index: one row per (artist, genre), from MusicBrainz / Last.fm
-- artist tags rather than the audio files' genre tags.
CREATE TABLE IF NOT EXISTS artist_genres (
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  genre TEXT NOT NULL,
  PRIMARY KEY (artist_id, genre)
);
CREATE INDEX IF NOT EXISTS idx_artist_genres_genre ON artist_genres(genre);

-- Persisted "For You" recommendations cache (mirrors discover_feed).
CREATE TABLE IF NOT EXISTS discover_foryou (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Per-user Subsonic app password. Stored recoverable (not argon2) because the
-- Subsonic token scheme (t = md5(secret + salt)) needs the secret to verify.
CREATE TABLE IF NOT EXISTS subsonic_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Album/artist stars. Track stars live in `favorites`. kind IN ('album','artist').
CREATE TABLE IF NOT EXISTS subsonic_stars (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);

-- Per-user 0 to 5 ratings (Subsonic setRating). kind IN ('track','album').
CREATE TABLE IF NOT EXISTS subsonic_ratings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);

-- Cross-device play queue (Subsonic save/getPlayQueue). One saved queue per user;
-- `ids` is a JSON array of track ids in order.
CREATE TABLE IF NOT EXISTS play_queues (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ids TEXT NOT NULL,
  current INTEGER,
  position INTEGER,
  changed INTEGER NOT NULL,
  changed_by TEXT
);

-- Per-user, per-track resume position (Subsonic bookmarks), used for long-form
-- audio. `position` is milliseconds into the track. Re-creating overwrites.
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  comment TEXT,
  created INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

-- Chapters from a chaptered file (e.g. a single-file .m4b audiobook), cached
-- from ffprobe. start_ms/end_ms are offsets into the track.
CREATE TABLE IF NOT EXISTS track_chapters (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  PRIMARY KEY (track_id, idx)
);

-- Podcasts: subscribed feeds and their episodes, per user. `position` (ms) and
-- `played` hold resume state, since episodes aren't library tracks.
CREATE TABLE IF NOT EXISTS podcast_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image_url TEXT,
  author TEXT,
  link TEXT,
  added_at INTEGER NOT NULL,
  last_refreshed INTEGER,
  UNIQUE(user_id, feed_url)
);
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES podcast_channels(id) ON DELETE CASCADE,
  guid TEXT,
  title TEXT,
  description TEXT,
  audio_url TEXT NOT NULL,
  audio_type TEXT,
  pub_date INTEGER,
  duration INTEGER,
  image_url TEXT,
  played INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  transcript_url TEXT,
  transcript_type TEXT,
  local_path TEXT,
  UNIQUE(channel_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel ON podcast_episodes(channel_id, pub_date DESC);

-- Per-user internet radio stations (Subsonic internet radio). A saved list of
-- stream URLs. The client plays the stream directly.
CREATE TABLE IF NOT EXISTS internet_radio_stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  homepage_url TEXT,
  created INTEGER NOT NULL
);
