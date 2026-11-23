import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// The JS handle for the native LhmAudio plugin (ExoPlayer, Android). Method
// shapes mirror the Java @PluginMethods; events mirror notifyListeners(...).
// Track metadata for the native lock-screen / notification.
export interface NativeMeta {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
}

export interface LhmAudioPlugin {
  load(opts: { url: string; resumeAt?: number; autoplay: boolean } & NativeMeta): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(opts: { position: number }): Promise<void>;
  setPlaybackRate(opts: { rate: number; preservePitch: boolean }): Promise<void>;
  setVolume(opts: { volume: number }): Promise<void>;
  setUpcoming(opts: { url: string | null } & NativeMeta): Promise<void>;
  goToUpcoming(opts: { url: string | null; autoplay?: boolean } & NativeMeta): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<{ currentTime?: number; duration?: number; paused?: boolean; ready?: boolean }>;
  addListener(event: string, cb: (data: any) => void): Promise<PluginListenerHandle>;
}

export const LhmAudio = registerPlugin<LhmAudioPlugin>("LhmAudio");
