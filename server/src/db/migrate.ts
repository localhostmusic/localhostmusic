import type Database from "better-sqlite3";

// Schema migrations, keyed off SQLite's `PRAGMA user_version`.
// Append-only: never edit, renumber, reorder or delete a shipped migration, and
// never add to schema.sql (the frozen v1 baseline). Only migration 1 is idempotent.
// `PRAGMA foreign_keys` is a no-op inside a transaction, so a table rebuild that
// needs it off has to toggle it in openDb, outside runMigrations.

export interface Migration {
  version: number;
  name: string;
  // `schemaSql` is only meaningful to the baseline; later migrations ignore it.
  up(db: Database.Database, schemaSql: string): void;
}

// Columns added by ALTER before migrations existed. Idempotent because a
// database may already have some or all of them. Frozen, never append here.
function legacyColumns(db: Database.Database) {
  const add = (table: string, col: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already exists */ }
  };
  for (const col of ["description TEXT", "dedicated_to TEXT", "mood TEXT", "cover_path TEXT"]) add("playlists", col);
  add("tracks", "added_at INTEGER");
  add("favorites", "created_at INTEGER");
  add("playlists", "created_at INTEGER");
  add("users", "share_activity INTEGER NOT NULL DEFAULT 1");
  add("albums", "is_audiobook INTEGER NOT NULL DEFAULT 0");
  for (const col of ["transcript_url TEXT", "transcript_type TEXT", "local_path TEXT"]) add("podcast_episodes", col);
  add("internet_radio_stations", "favicon TEXT");
  add("playlists", "rules TEXT");
  add("playlists", "refreshed_at INTEGER");
  add("track_lyrics", "published_at INTEGER");
  add("tracks", "loudness REAL");
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up(db, schemaSql) {
      db.exec(schemaSql);
      legacyColumns(db);
    },
  },

  {
    version: 2,
    name: "track-artists",
    up(db) {
      // track_artists is the full credit list for a track. tracks.artist_id
      // stays as the denormalized primary artist that display joins read.
      // position is the tag's ARTIST frame order: 0 is 'primary', the rest
      // 'featured'. Titles ("feat. X & Y") are never parsed.
      db.exec(`
        CREATE TABLE track_artists (
          track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          artist_id INTEGER NOT NULL REFERENCES artists(id),
          role      TEXT    NOT NULL DEFAULT 'primary',
          position  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (track_id, artist_id)
        );
        CREATE INDEX idx_track_artists_artist ON track_artists(artist_id);
      `);

      // Backfill the primary credit. Guest credits appear once the scanner
      // re-reads tags.
      db.exec(`
        INSERT INTO track_artists(track_id, artist_id, role, position)
        SELECT id, artist_id, 'primary', 0 FROM tracks WHERE artist_id IS NOT NULL
      `);

      // The scanner skips unchanged files, so credits_v marks tracks whose tags
      // need re-reading: 0 = predates track_artists, 1 = full ARTIST frame list.
      db.exec(`ALTER TABLE tracks ADD COLUMN credits_v INTEGER NOT NULL DEFAULT 0`);
    },
  },

  {
    version: 3,
    name: "discover-dismissals",
    up(db) {
      // Per-user Discover dismissals. `key` is a content key the feed can
      // recompute on any rebuild: "artist:<name-key>" or "rg:<musicbrainz-id>".
      db.exec(`
        CREATE TABLE discover_dismissed (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key     TEXT    NOT NULL,
          at      INTEGER NOT NULL,
          PRIMARY KEY (user_id, key)
        );
      `);

      // How far Refresh has rotated through the user's top artists as feed seeds.
      db.exec(`ALTER TABLE discover_feed ADD COLUMN rot INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 4,
    name: "playback-integrity",
    up(db) {
      db.exec(`ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE revoked_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE scrobble_receipts (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id INTEGER NOT NULL, listened_at INTEGER NOT NULL, provider TEXT NOT NULL,
          PRIMARY KEY(user_id, track_id, listened_at, provider));
        INSERT OR IGNORE INTO app_settings(key,value) VALUES('_library_revision','0');
        CREATE TRIGGER tracks_revision_insert AFTER INSERT ON tracks BEGIN
          UPDATE app_settings SET value=CAST(value AS INTEGER)+1 WHERE key='_library_revision'; END;
        CREATE TRIGGER tracks_revision_update AFTER UPDATE OF mtime,size ON tracks BEGIN
          UPDATE app_settings SET value=CAST(value AS INTEGER)+1 WHERE key='_library_revision'; END;
        CREATE TRIGGER tracks_revision_delete AFTER DELETE ON tracks BEGIN
          UPDATE app_settings SET value=CAST(value AS INTEGER)+1 WHERE key='_library_revision'; END;`);
    },
  },
  {
    version: 5,
    name: "per-user-listens",
    // play_counts is server-wide. Home needs per-user history.
    up(db) {
      db.exec(`CREATE TABLE listens (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          played_at INTEGER NOT NULL);
        CREATE INDEX listens_user_time ON listens(user_id, played_at);`);
    },
  },
];

// Credit-list generation the current scanner writes. A track below this gets its
// tags re-read on the next scan even if the file itself hasn't changed.
export const CREDITS_VERSION = 1;

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[]; // "1:baseline"
}

/**
 * Bring `db` up to LATEST_VERSION. Each migration runs in one transaction with its
 * `user_version` bump, so a failure leaves the last fully applied version.
 */
export function runMigrations(db: Database.Database, schemaSql: string): MigrationResult {
  const from = db.pragma("user_version", { simple: true }) as number;

  // Refuse a database written by a newer build: its schema may not match our queries.
  if (from > LATEST_VERSION) {
    throw new Error(
      `database schema v${from} is newer than this build understands (v${LATEST_VERSION}). ` +
      `Upgrade Localhost Music, or restore a backup taken before the upgrade.`
    );
  }

  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const tx = db.transaction(() => {
      m.up(db, schemaSql);
      // user_version is transactional, so it commits with the migration.
      db.pragma(`user_version = ${m.version}`);
    });
    try {
      tx();
    } catch (cause) {
      throw new Error(`migration ${m.version} (${m.name}) failed; database left at v${db.pragma("user_version", { simple: true })}`, { cause });
    }
    applied.push(`${m.version}:${m.name}`);
  }
  return { from, to: LATEST_VERSION, applied };
}
