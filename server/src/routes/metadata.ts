import type { FastifyInstance } from "fastify";
import { statSync } from "node:fs";
import { writeTags } from "../lib/tagwrite.js";
import { pruneEmpty } from "../lib/prune.js";

const MB = "https://musicbrainz.org/ws/2";
const UA = "LocalhostMusic/1.0 (self-hosted music server)";

// Admin tools to fix mistagged tracks: search MusicBrainz for candidate metadata
// and apply a chosen result (re-tagging the track + reindexing search).
export async function metadataRoutes(app: FastifyInstance) {
  const adminOnly = {
    preHandler: [app.authRequired, async (req: any, reply: any) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: "forbidden" });
    }],
  };

  // Escape Lucene specials for a quoted phrase (only \ and " matter inside quotes).
  const luceneQuote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").trim()}"`;

  app.get("/api/admin/metadata/search", adminOnly, async (req: any, reply) => {
    const title = String(req.query.title ?? "").trim();
    const artist = String(req.query.artist ?? "").trim();
    // Prefer a fielded query (recording:"..." AND artist:"..."). A bare query can't
    // tell which words are the title and which the artist.
    let query: string;
    if (title || artist) {
      query = [
        title && `recording:${luceneQuote(title)}`,
        artist && `artist:${luceneQuote(artist)}`,
      ].filter(Boolean).join(" AND ");
    } else {
      query = String(req.query.q ?? "").trim(); // free-text fallback
    }
    if (!query) return [];
    try {
      const r = await fetch(`${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`, {
        headers: { "User-Agent": UA },
      });
      if (!r.ok) return reply.code(502).send({ error: "musicbrainz failed" });
      const j: any = await r.json();
      const out: any[] = [];
      const seen = new Set<string>();
      for (const rec of j.recordings ?? []) {
        const ac = rec["artist-credit"] ?? [];
        const artist = ac.map((c: any) => c.name + (c.joinphrase ?? "")).join("").trim()
          || ac[0]?.artist?.name || "";
        if (!rec.title || !artist) continue;
        // One candidate per release, so different album versions (Deluxe, Reissue,
        // original) are all selectable. Dedupe by album title + year.
        const releases = (rec.releases ?? []).length ? rec.releases : [null];
        for (const rel of releases) {
          const album = rel?.title ?? "";
          const date = rel?.date ?? rec["first-release-date"] ?? "";
          const year = date ? Number(String(date).slice(0, 4)) || undefined : undefined;
          // Track position lives on the release's medium (disc).
          const medium = (rel?.media ?? [])[0] ?? {};
          const trackNo = Number((medium.track ?? [])[0]?.number) || undefined;
          const discNo = Number(medium.position) || undefined;
          const key = `${rec.title.toLowerCase()}|${artist.toLowerCase()}|${album.toLowerCase()}|${year ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ mbid: `${rec.id}:${rel?.id ?? ""}`, title: rec.title, artist, album, year, trackNo, discNo, note: rel?.disambiguation || "" });
        }
      }
      return out.slice(0, 20);
    } catch {
      return reply.code(502).send({ error: "fetch failed" });
    }
  });

  app.post("/api/admin/tracks/:id/metadata", adminOnly, async (req: any, reply) => {
    const id = Number(req.params.id);
    const { title, artist, album, year } = req.body ?? {};
    const trackNo = Number(req.body?.trackNo) || undefined;
    const discNo = Number(req.body?.discNo) || undefined;
    if (!title || !artist || !album) return reply.code(400).send({ error: "title, artist, album required" });
    const trackRow = app.db.prepare("SELECT path FROM tracks WHERE id=?").get(id) as any;
    if (!trackRow) return reply.code(404).send({ error: "track not found" });
    const db = app.db;

    const reindex = (kind: string, refId: number, name: string) => {
      db.prepare("DELETE FROM search_fts WHERE kind=? AND ref_id=?").run(kind, refId);
      db.prepare("INSERT INTO search_fts(kind,ref_id,name) VALUES(?,?,?)").run(kind, refId, name);
    };
    // Match existing artist/album case-insensitively and snap to the library's
    // stored casing, so a casing difference doesn't fork a new album.
    const artistRef = (name: string): { id: number; name: string } => {
      const row = db.prepare("SELECT id, name FROM artists WHERE name=? COLLATE NOCASE").get(name) as any;
      if (row) return { id: row.id, name: row.name };
      const newId = db.prepare("INSERT INTO artists(name) VALUES(?)").run(name).lastInsertRowid as number;
      db.prepare("INSERT INTO search_fts(kind,ref_id,name) VALUES('artist',?,?)").run(newId, name);
      return { id: newId, name };
    };
    const albumRef = (atitle: string, aId: number, y?: number): { id: number; title: string } => {
      const row = db.prepare("SELECT id, title FROM albums WHERE title=? COLLATE NOCASE AND artist_id=?").get(atitle, aId) as any;
      if (row) return { id: row.id, title: row.title };
      const newId = db.prepare("INSERT INTO albums(title,artist_id,year) VALUES(?,?,?)").run(atitle, aId, y ?? null).lastInsertRowid as number;
      db.prepare("INSERT INTO search_fts(kind,ref_id,name) VALUES('album',?,?)").run(newId, atitle);
      return { id: newId, title: atitle };
    };

    // Resolved names (library casing when merging), reused for the file tags so
    // a rescan won't re-split the track from its album.
    const { a, al } = db.transaction(() => {
      const a = artistRef(artist);
      const al = albumRef(album, a.id, year);
      // COALESCE keeps an existing track/disc number when the candidate lacks one,
      // so a free-text apply never wipes a correct position.
      db.prepare("UPDATE tracks SET title=?, artist_id=?, album_id=?, track_no=COALESCE(?,track_no), disc_no=COALESCE(?,disc_no) WHERE id=?")
        .run(title, a.id, al.id, trackNo ?? null, discNo ?? null, id);
      reindex("track", id, title);
      return { a, al };
    })();

    // Write the tags into the file too. Best-effort: if the music dir is read-only
    // or ffmpeg fails, the DB change still stands and the file status is reported.
    let fileUpdated = false;
    let fileError: string | undefined;
    try {
      await writeTags(trackRow.path, { title, artist: a.name, album: al.title, year, track: trackNo, disc: discNo });
      const st = statSync(trackRow.path);
      db.prepare("UPDATE tracks SET mtime=?, size=? WHERE id=?").run(Math.floor(st.mtimeMs), st.size, id);
      fileUpdated = true;
    } catch (e: any) {
      fileError = String(e?.message ?? e);
    }

    pruneEmpty(db); // the track may have vacated its old album/artist
    return { ok: true, fileUpdated, fileError };
  });
}
