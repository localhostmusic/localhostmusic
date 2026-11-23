import type Database from "better-sqlite3";

const MB = "https://musicbrainz.org/ws/2";
const UA = "LocalhostMusic/1.0 (self-hosted music server)";

export async function mbjget(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Loose title key: case, punctuation and accents don't affect the library to
// MusicBrainz comparison.
export function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// Keep Albums/EPs/Singles, including Live ones. Drop noisy secondary types
// (compilations, remixes, soundtracks, demos).
const PRI: Record<string, number> = { Album: 3, EP: 2, Live: 2, Single: 1 };
const DROP_SECONDARY = new Set([
  "Compilation", "Remix", "DJ-mix", "Mixtape/Street", "Demo", "Soundtrack",
  "Interview", "Audiobook", "Audio drama", "Spokenword", "Field recording",
]);
function keep(rg: any): boolean {
  const primary = rg["primary-type"];
  if (primary !== "Album" && primary !== "EP" && primary !== "Single") return false;
  const secondary: string[] = rg["secondary-types"] ?? [];
  return !secondary.some(s => DROP_SECONDARY.has(s));
}
// Display type: Live is its own bucket; otherwise the primary type.
function displayType(rg: any): string {
  return (rg["secondary-types"] ?? []).includes("Live") ? "Live" : rg["primary-type"];
}

// Browse an artist's release groups (paginated), filter, dedupe by title keeping
// the highest type (Album > EP > Single), then the earliest release. `year` is
// the original first-release-date, so reissues keep their real year.
export async function fetchReleaseGroups(mbid: string): Promise<any[]> {
  const raw: any[] = [];
  let offset = 0;
  for (let page = 0; page < 4; page++) {
    const d = await mbjget(`${MB}/release-group?artist=${mbid}&limit=100&offset=${offset}&fmt=json`);
    raw.push(...(d["release-groups"] ?? []));
    const total = d["release-group-count"] ?? raw.length;
    offset += 100;
    if (offset >= total) break;
  }
  const byTitle = new Map<string, any>();
  for (const rg of raw) {
    if (!keep(rg)) continue;
    const date: string = rg["first-release-date"] || "";
    const item = { rgid: rg.id, title: rg.title, type: displayType(rg), year: date ? Number(date.slice(0, 4)) || null : null, date: date || null };
    const k = norm(rg.title);
    const prev = byTitle.get(k);
    const better = !prev || PRI[item.type] > PRI[prev.type] ||
      (PRI[item.type] === PRI[prev.type] && item.year && (!prev.year || item.year < prev.year));
    if (better) byTitle.set(k, item);
  }
  return [...byTitle.values()];
}

// norm() strips everything outside [a-z0-9], so a fully non-Latin name would
// normalize to "" and match every other one. Fall back to the raw lowercased name.
export function nameKey(s: string): string {
  return norm(s) || (s || "").trim().toLowerCase();
}

// True if the candidate has the searched name as its name or an alias. Localized
// artists are often filed under a romanization that only appears in aliases.
function matchesName(cand: any, key: string): boolean {
  if (nameKey(cand?.name ?? "") === key) return true;
  return (cand?.aliases ?? []).some((a: any) => nameKey(a?.name ?? "") === key);
}

// Resolve a MusicBrainz id from a name alone. The name must equal the candidate's
// name or an alias, otherwise return null: MB's top hit can be a different artist
// ("Napalm Death" outscores "Death"). Callers that know the library's albums
// should use resolveArtistMbid.
export async function mbidByName(name: string): Promise<string | null> {
  try {
    const q = `artist:"${name}" OR alias:"${name}"`;
    const s = await mbjget(`${MB}/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=8`);
    const key = nameKey(name);
    const exact = (s.artists ?? []).filter((c: any) => matchesName(c, key));
    if (!exact.length) return null;
    // MB's score breaks ties among exact matches.
    exact.sort((a: any, b: any) => (Number(b.score) || 0) - (Number(a.score) || 0));
    return exact[0].id;
  } catch { return null; }
}

const MB_TTL = 1000 * 60 * 60 * 24 * 30;

// The artist's name plus every alias, as comparison keys. Release groups have no
// aliases in MusicBrainz, so a self-titled album in another script can only be
// matched to a romanized library title through these. Memoized per process.
const nameKeyCache = new Map<string, { keys: Set<string>; at: number }>();
export async function artistNameKeys(mbid: string): Promise<Set<string>> {
  const hit = nameKeyCache.get(mbid);
  if (hit && Date.now() - hit.at < MB_TTL) return hit.keys;
  const keys = new Set<string>();
  try {
    const a = await mbjget(`${MB}/artist/${mbid}?inc=aliases&fmt=json`);
    for (const n of [a?.name, a?.["sort-name"], ...((a?.aliases ?? []).map((x: any) => x?.name))]) {
      if (n) keys.add(nameKey(String(n)));
    }
  } catch { /* no aliases, the caller still matches on title */ }
  nameKeyCache.set(mbid, { keys, at: Date.now() });
  return keys;
}

// Several MusicBrainz artists can share a name. Pick the one whose discography
// best overlaps the owned albums.
export async function resolveArtistMbid(db: Database.Database, ownedTitles: Set<string>, name: string): Promise<string | null> {
  let cands: any[] = [];
  try {
    // Search names and aliases: `artist:"X"` alone misses artists filed under a
    // romanized alias. limit 25 because alias search adds many partial matches
    // that can outrank the exact one.
    const q = `artist:"${name}" OR alias:"${name}"`;
    const s = await mbjget(`${MB}/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
    cands = s.artists ?? [];
  } catch { return null; }
  if (!cands.length) return null;

  // If any candidate has this exact name or alias, only those are considered.
  const key = nameKey(name);
  const exact = cands.filter((c: any) => matchesName(c, key));
  const pool = (exact.length ? exact : cands).slice(0, 5);
  if (pool.length === 1) return pool[0].id;

  const ranked = pool.map((c: any) => ({ c, score: Number(c.score) || 0, overlap: 0, releases: 0 }));

  // Overlap costs one discography request per candidate, so skip it when no
  // albums are owned.
  if (ownedTitles.size) {
    for (const r of ranked) {
      let rgs: any[];
      try { rgs = await getReleaseGroups(db, r.c.id, MB_TTL); } catch { continue; }
      r.releases = rgs.length;
      const titles = new Set(rgs.map(x => norm(x.title)));
      for (const t of ownedTitles) if (titles.has(t)) r.overlap++;
    }
  }

  // Owned-album overlap first, then having any discography. MB's score only breaks
  // ties, since it can rank a fuzzy hit above an exact one.
  ranked.sort((a, b) =>
    b.overlap - a.overlap ||
    Math.sign(b.releases) - Math.sign(a.releases) ||
    b.score - a.score);
  return ranked[0].c.id;
}

// Release-groups for an mbid, cached in discography_cache (shared by the
// discography view and the Discover feed). Falls back to stale cache on failure.
export async function getReleaseGroups(db: Database.Database, mbid: string, ttl: number): Promise<any[]> {
  const row = db.prepare("SELECT json, fetched_at FROM discography_cache WHERE mbid=?").get(mbid) as any;
  if (row && Date.now() - row.fetched_at < ttl) {
    try {
      const parsed = JSON.parse(row.json);
      // Serve cache unless it predates the `date` field (then refetch to upgrade).
      if (!parsed.length || parsed[0].date !== undefined) return parsed;
    } catch { /* refetch */ }
  }
  try {
    const list = await fetchReleaseGroups(mbid);
    db.prepare("INSERT OR REPLACE INTO discography_cache(mbid,json,fetched_at) VALUES(?,?,?)")
      .run(mbid, JSON.stringify(list), Date.now());
    return list;
  } catch (e) {
    if (row) { try { return JSON.parse(row.json); } catch { /* fall through */ } }
    throw e;
  }
}
