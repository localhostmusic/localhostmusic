import { parseFile } from "music-metadata";
import { basename } from "node:path";

export interface TrackTags {
  title: string;
  /** Primary artist, the first ARTIST frame. Denormalized onto tracks.artist_id. */
  artist: string;
  /** Every ARTIST frame, in tag order. artists[0] === artist. */
  artists: string[];
  album: string;
  albumArtist?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  genre?: string;
  duration?: number;
  picture?: Buffer;
}

/** Trim, drop blanks, and collapse repeats while keeping tag order. */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function readTags(path: string): Promise<TrackTags> {
  const meta = await parseFile(path);
  if (!meta.format.container && !meta.format.codec) {
    throw new Error("unrecognized audio format");
  }
  const c = meta.common;
  // c.artists holds every ARTIST frame, c.artist only the first.
  const artists = dedupe(c.artists?.length ? c.artists : c.artist ? [c.artist] : []);
  return {
    title: c.title ?? basename(path),
    artist: artists[0] ?? "Unknown Artist",
    artists: artists.length ? artists : ["Unknown Artist"],
    album: c.album ?? "Unknown Album",
    albumArtist: c.albumartist,
    trackNo: c.track?.no ?? undefined,
    discNo: c.disk?.no ?? undefined,
    year: c.year,
    genre: c.genre?.[0],
    duration: meta.format.duration,
    picture: c.picture?.[0]?.data ? Buffer.from(c.picture[0].data) : undefined,
  };
}
