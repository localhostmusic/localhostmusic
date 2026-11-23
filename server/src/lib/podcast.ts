import { XMLParser } from "fast-xml-parser";
import type Database from "better-sqlite3";
import { safeFetch } from "./ssrf.js";

export interface FeedChannel {
  title: string; description?: string; imageUrl?: string; author?: string; link?: string;
}
export interface FeedEpisode {
  guid?: string; title: string; description?: string;
  audioUrl: string; audioType?: string; pubDate?: number; duration?: number; imageUrl?: string;
  transcriptUrl?: string; transcriptType?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true, processEntities: true });

// A field may be a string, { "#text" }, or an array. Normalise to the first string.
const text = (v: any): string | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return v["#text"] != null ? String(v["#text"]) : undefined;
  return String(v);
};
const arr = <T,>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// "1:02:03" / "62:03" / "3723" to seconds.
function parseDuration(v: any): number | undefined {
  const s = text(v);
  if (!s) return undefined;
  if (/^\d+$/.test(s.trim())) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
const parseDate = (v: any): number | undefined => {
  const s = text(v); if (!s) return undefined;
  const t = Date.parse(s); return Number.isFinite(t) ? t : undefined;
};
const imageOf = (node: any): string | undefined =>
  node?.["itunes:image"]?.["@_href"] || text(node?.image?.url) || text(node?.image?.["@_href"]);

export type TranscriptLine = { start?: number; text: string };

const tsToMs = (s: string): number => {
  const m = s.match(/(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/) || s.match(/(\d+):(\d{2})[.,](\d{1,3})/);
  if (!m) return 0;
  const frac = (m[m.length - 1] + "000").slice(0, 3);
  return m.length === 5
    ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +frac
    : (+m[1] * 60 + +m[2]) * 1000 + +frac;
};

const decodeEntities = (s: string) => s
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&hellip;/gi, "…").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

// Pull inline [HH:MM:SS] / [MM:SS] timestamps out of text lines (e.g. "Leo Laporte
// [00:00:18]:") so a plain transcript can sync. A timestamp carries forward to the
// following lines until the next one.
function applyInlineTimestamps(lines: string[]): TranscriptLine[] {
  let cur: number | undefined;
  const out: TranscriptLine[] = [];
  for (const text of lines) {
    const m = text.match(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/);
    if (m) cur = (m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]) * 1000;
    out.push(cur != null ? { start: cur, text } : { text });
  }
  return out;
}

// VTT/SRT cue blocks become timed lines. Plain text becomes untimed lines (paragraphs).
export function parseTranscript(body: string, type?: string): TranscriptLine[] {
  const t = (type || "").toLowerCase();
  // Some feeds point <podcast:transcript> at an HTML page. Strip tags to text.
  if (/html/.test(t) || /^\s*<(!doctype|html)/i.test(body)) {
    const lines = decodeEntities(body
      .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(p|br|div|li|h[1-6])[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""))
      .split(/\n+/).map(l => l.trim()).filter(Boolean);
    return applyInlineTimestamps(lines);
  }
  const timed = /vtt|srt|subrip/.test(t) || /^WEBVTT/.test(body.trimStart()) || /-->/.test(body.slice(0, 4000));
  if (!timed) {
    return applyInlineTimestamps(body.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
  }
  const out: TranscriptLine[] = [];
  for (const block of body.replace(/^WEBVTT.*$/m, "").split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const cueLine = lines.find(l => l.includes("-->"));
    if (!cueLine) continue;
    const start = tsToMs(cueLine.split("-->")[0].trim());
    const text = lines.filter(l => l !== cueLine && !/^\d+$/.test(l)).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) out.push({ start, text });
  }
  return out;
}

// Fetch + parse an RSS 2.0 (or basic Atom) podcast feed into channel + episodes.
export async function fetchFeed(url: string): Promise<{ channel: FeedChannel; episodes: FeedEpisode[] }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let xml: string;
  try {
    const res = await safeFetch(url, { signal: ac.signal, headers: { "User-Agent": "LocalhostMusic Podcasts" } });
    if (res.status === 404 || res.status === 410) throw new Error("This feed is no longer available. The directory listing is stale.");
    if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
    xml = await res.text();
  } finally { clearTimeout(timer); }

  const doc = parser.parse(xml);
  const ch = doc?.rss?.channel;
  if (!ch) throw new Error("Not an RSS podcast feed.");

  const channel: FeedChannel = {
    title: text(ch.title) || "Untitled podcast",
    description: text(ch.description) || text(ch["itunes:summary"]),
    imageUrl: imageOf(ch),
    author: text(ch["itunes:author"]) || text(ch.managingEditor),
    link: text(ch.link),
  };

  const episodes: FeedEpisode[] = [];
  for (const item of arr<any>(ch.item)) {
    // Enclosure is the audio; some feeds use media:content. Prefer an audio type.
    const encs = arr<any>(item.enclosure).concat(arr<any>(item["media:content"]));
    const enc = encs.find(e => String(e?.["@_type"] || "").startsWith("audio")) || encs[0];
    const audioUrl = enc?.["@_url"];
    if (!audioUrl) continue; // no playable media, skip
    // podcast:transcript: prefer the formats we can render (vtt/srt/plain) over json/html.
    const trs = arr<any>(item["podcast:transcript"]);
    const tr = trs.find(t => /vtt/i.test(t?.["@_type"] || "")) || trs.find(t => /srt|subrip/i.test(t?.["@_type"] || ""))
      || trs.find(t => /plain|text\/plain/i.test(t?.["@_type"] || "")) || trs[0];
    episodes.push({
      guid: text(item.guid) || audioUrl,
      title: text(item.title) || "Untitled episode",
      description: text(item.description) || text(item["itunes:summary"]) || text(item["content:encoded"]),
      audioUrl: String(audioUrl),
      audioType: enc?.["@_type"] ? String(enc["@_type"]) : undefined,
      pubDate: parseDate(item.pubDate),
      duration: parseDuration(item["itunes:duration"]),
      imageUrl: imageOf(item) || undefined,
      transcriptUrl: tr?.["@_url"] ? String(tr["@_url"]) : undefined,
      transcriptType: tr?.["@_type"] ? String(tr["@_type"]) : undefined,
    });
  }
  return { channel, episodes };
}

// DB sync, shared by the routes and the auto-refresh scheduler.

export function syncEpisodes(db: Database.Database, channelId: number, eps: FeedEpisode[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO podcast_episodes
       (channel_id, guid, title, description, audio_url, audio_type, pub_date, duration, image_url, transcript_url, transcript_type)
     VALUES (@channel_id, @guid, @title, @description, @audio_url, @audio_type, @pub_date, @duration, @image_url, @transcript_url, @transcript_type)`);
  let added = 0;
  db.transaction((rows: FeedEpisode[]) => {
    for (const e of rows) {
      added += ins.run({
        channel_id: channelId, guid: e.guid ?? e.audioUrl, title: e.title, description: e.description ?? null,
        audio_url: e.audioUrl, audio_type: e.audioType ?? null, pub_date: e.pubDate ?? null,
        duration: e.duration ?? null, image_url: e.imageUrl ?? null,
        transcript_url: e.transcriptUrl ?? null, transcript_type: e.transcriptType ?? null,
      }).changes;
    }
  })(eps);
  return added;
}

// Re-fetch every subscribed feed, add new episodes. Broken feeds are skipped.
// Returns how many new episodes appeared across all channels.
export async function refreshAllChannels(db: Database.Database): Promise<number> {
  const chans = db.prepare("SELECT id, feed_url FROM podcast_channels").all() as any[];
  let total = 0;
  for (const c of chans) {
    try {
      const feed = await fetchFeed(c.feed_url);
      total += syncEpisodes(db, c.id, feed.episodes);
      db.prepare("UPDATE podcast_channels SET last_refreshed=?, title=?, image_url=? WHERE id=?")
        .run(Date.now(), feed.channel.title, feed.channel.imageUrl ?? null, c.id);
    } catch { /* skip a feed that's down / malformed */ }
  }
  return total;
}
