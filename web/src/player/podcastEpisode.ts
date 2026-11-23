import type { Track } from "./PlayerProvider";

export type Episode = {
  id: number; title: string; description?: string; audioUrl: string; audioType?: string;
  pubDate?: number; duration?: number; imageUrl?: string; played?: number; position?: number;
  hasTranscript?: number | boolean; downloaded?: number | boolean; isVideo?: number | boolean;
};

// A podcast episode plays as a synthetic Track through the Localhost Music proxy (same-origin,
// Range-forwarded so it's seekable). Distinct id range from radio.
export const PODCAST_ID_BASE = -2_000_000;
export const episodeTrack = (ep: Episode, channelTitle: string, channelImage?: string, channelId?: number): Track => ({
  id: PODCAST_ID_BASE - ep.id,
  title: ep.title,
  artist: channelTitle,
  album: channelTitle,
  duration: ep.duration,
  streamUrl: `/api/podcasts/episodes/${ep.id}/stream`,
  isPodcast: true,
  podcastEpisodeId: ep.id,
  podcastChannelId: channelId,
  hasTranscript: !!ep.hasTranscript,
  isVideo: !!ep.isVideo,
  artUrl: ep.imageUrl || channelImage,
});
