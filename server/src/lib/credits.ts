// Artist credit SQL shared by all routes. tracks.artist_id is who a track is filed
// under (one primary artist), track_artists is everyone credited on it. Queries for
// an artist's content or tracks go through here. Display joins on tracks.artist_id
// are fine as they are.

/**
 * True when `<artist>` owns an album (is an album artist). Browse surfaces (artists
 * grid, counts, genre listings, Subsonic index) list album artists only. Guests are
 * reached from track rows and search. `<artist>` is an SQL expression for the
 * artist id in the enclosing query, e.g. "artists.id".
 * `audiobooks: "exclude"` keeps spoken-word-only authors out of the music library.
 * Subsonic passes "include" because it exposes the whole library.
 */
export const isAlbumArtist = (
  artist: string,
  audiobooks: "exclude" | "include" = "exclude",
) => {
  const notBook = audiobooks === "exclude" ? "AND COALESCE(al.is_audiobook, 0) = 0" : "";
  return `EXISTS (
    SELECT 1 FROM albums al
    WHERE al.artist_id = ${artist} ${notBook}
      AND EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = al.id)
  )`;
};

/** Every track id an artist is credited on, primary or guest. Bind: artist id. */
export const CREDITED_TRACK_IDS = `SELECT track_id FROM track_artists WHERE artist_id = ?`;

/**
 * Albums the artist appears on but does not own ("Appears On").
 * Bind: artist id, artist id.
 */
export const APPEARS_ON_ALBUMS = `
  SELECT DISTINCT al.id, al.title, al.year, al.cover_path, al.artist_id,
         ar.name AS artist
  FROM track_artists ta
  JOIN tracks t  ON t.id = ta.track_id
  JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists ar ON ar.id = al.artist_id
  WHERE ta.artist_id = ?
    AND COALESCE(al.is_audiobook, 0) = 0
    AND (al.artist_id IS NULL OR al.artist_id <> ?)
  ORDER BY al.year, al.title`;

/**
 * Full credit list for a set of tracks, in tag order.
 * Interpolate `<ids>` with placeholders; bind: the track ids.
 */
export const creditsForTracks = (ids: string) => `
  SELECT ta.track_id, ta.artist_id AS id, ar.name, ta.role
  FROM track_artists ta
  JOIN artists ar ON ar.id = ta.artist_id
  WHERE ta.track_id IN (${ids})
  ORDER BY ta.track_id, ta.position`;

export interface Credit { id: number; name: string; role: string; }

/** Group the rows of `creditsForTracks` into a track id to credits lookup. */
export function groupCredits(rows: { track_id: number; id: number; name: string; role: string }[]) {
  const by = new Map<number, Credit[]>();
  for (const r of rows) {
    let list = by.get(r.track_id);
    if (!list) by.set(r.track_id, (list = []));
    list.push({ id: r.id, name: r.name, role: r.role });
  }
  return by;
}
