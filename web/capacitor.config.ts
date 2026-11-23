import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor shell. The WebView loads the Localhost Music server directly, not a bundled copy:
// the web app has to be same-origin with its API (relative /api, cookie auth,
// WebSocket on location.host, service worker). Playback goes through the native
// audio plugin (ExoPlayer).
//
// No server.url here: the address is asked for on first run and applied in
// MainActivity (see ServerSetupActivity).
const config: CapacitorConfig = {
  appId: "io.github.localhostmusic",
  appName: "Localhost Music",
  webDir: "dist",
};

export default config;
