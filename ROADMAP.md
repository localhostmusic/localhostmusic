# Roadmap

Rough order within each section. Nothing here has a date.

## Playback
- Equalizer on desktop (bands and presets).
- Sleep timer: stop after N minutes or at the end of a chapter.
- Album-mode loudness normalization and a configurable target level.
- Sample-accurate gapless. This needs native audio; the browser path uses two audio
  elements and gets close but not to zero.

## Lyrics
- Word-level timing in the sync tool, for karaoke-style highlighting.
- More editing in the review step.

## Large libraries
Tested with 100,000 tracks. Known limits:
- Albums and Artists keep every card you have scrolled past mounted. Needs windowing.
- No sort, filter or A-Z jump on the Albums page.
- A rescan walks the disk synchronously, which can stall the server on a slow NAS.
- The albums list is one response. It will need paging somewhere past 30k albums.

## Apps
- iOS shell with native audio (needs a Mac to build).
- Auto-download favorites for offline use.
- A way to change server from inside the Android app, not only from the launcher shortcut.

## Docs
- Deployment guide: LAN only, Tailscale, reverse proxy on a VPS, Cloudflare Tunnel.
- A docs site with a demo instance running on Creative Commons music.

## Small things
- User avatars in the admin Users list.
- Fewer duplicate links on the desktop Account page.
