import type { FastifyInstance } from "fastify";

// Admin "library health" tools: find duplicate tracks and albums that look
// incomplete (gaps in track numbering). All local, no external calls.
export async function healthRoutes(app: FastifyInstance) {
  const adminOnly = {
    preHandler: [app.authRequired, async (req: any, reply: any) => {
      if (!req.user?.isAdmin) return reply.code(403).send({ error: "forbidden" });
    }],
  };

  // Tracks sharing the same title + artist within the same album. The same song
  // across different albums is intentional, so album_id is part of the key.
  app.get("/api/admin/duplicates", adminOnly, async () => {
    const keys = app.db.prepare(
      `SELECT LOWER(title) AS k, artist_id AS a, album_id AS al, COUNT(*) AS n
       FROM tracks WHERE artist_id IS NOT NULL AND album_id IS NOT NULL
       GROUP BY LOWER(title), artist_id, album_id HAVING n > 1 ORDER BY n DESC LIMIT 100`
    ).all() as any[];
    const groups = keys.map(({ k, a, al }) => {
      const tracks = app.db.prepare(
        `SELECT t.id, t.title, t.path, t.size, t.duration, al.title AS album, ar.name AS artist
         FROM tracks t LEFT JOIN albums al ON al.id = t.album_id LEFT JOIN artists ar ON ar.id = t.artist_id
         WHERE LOWER(t.title) = ? AND t.artist_id = ? AND t.album_id = ? ORDER BY t.size DESC`
      ).all(k, a, al) as any[];
      return { title: tracks[0]?.title, artist: tracks[0]?.artist, tracks };
    });
    return { groups };
  });

  // Albums whose track numbering has gaps (fewer tracks than the highest track number).
  app.get("/api/admin/incomplete", adminOnly, async () => {
    const albums = app.db.prepare(
      `SELECT al.id, al.title, ar.name AS artist
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
       WHERE EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)`
    ).all() as any[];

    // One pass over all tracks instead of one query per album (N+1).
    const byAlbum = new Map<number, { track_no: number | null; disc_no: number | null }[]>();
    for (const r of app.db.prepare("SELECT album_id, track_no, disc_no FROM tracks WHERE album_id IS NOT NULL").all() as any[]) {
      let list = byAlbum.get(r.album_id);
      if (!list) byAlbum.set(r.album_id, (list = []));
      list.push(r);
    }

    const out: any[] = [];
    for (const al of albums) {
      const rows = byAlbum.get(al.id) ?? [];
      // group track numbers per disc
      const discs = new Map<number, Set<number>>();
      let owned = 0, hasNumbers = false;
      for (const r of rows) {
        owned++;
        if (r.track_no == null) continue;
        hasNumbers = true;
        const d = r.disc_no ?? 1;
        if (!discs.has(d)) discs.set(d, new Set());
        discs.get(d)!.add(r.track_no);
      }
      if (!hasNumbers) continue;
      let missing = 0;
      for (const nums of discs.values()) {
        const ownedD = nums.size;
        const max = Math.max(...nums);
        const gap = max - ownedD;
        if (gap <= 0) continue;
        // Skip discs whose numbering looks unreliable (a stray high track number).
        // Only trust gaps where the highest number is close to the owned count.
        if (max > ownedD * 1.5) continue;
        missing += gap;
      }
      if (missing > 0) out.push({ id: al.id, title: al.title, artist: al.artist, owned, missing });
    }
    out.sort((a, b) => b.missing - a.missing);
    return { albums: out.slice(0, 100) };
  });
}
