import type { Track } from "./PlayerProvider";

export type Station = { id: number; name: string; streamUrl: string; homepageUrl?: string; favicon?: string };

// A station plays as a synthetic (non-library) Track through the Localhost Music proxy:
// same-origin, so the visualizer isn't tainted, and it carries ICY metadata.
// The id is far negative so it never collides with a real track id.
export const RADIO_ID_BASE = -1_000_000;
export const stationTrack = (s: Station): Track => ({
  id: RADIO_ID_BASE - s.id, title: s.name, artist: "Internet radio",
  streamUrl: `/api/radio/${s.id}/stream`, isRadio: true, radioStationId: s.id,
  artUrl: s.favicon || undefined,
});
