import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../src/player/engine/WebAudioEngine';
import { StallRecovery } from '../src/player/engine/recovery';
import { resolveTrackSource } from '../src/player/engine/source';

vi.mock('../src/player/engine/source', () => ({
  resolveTrackSource: vi.fn(),
  pinnedSrc: vi.fn(async (url: string) => url),
}));

const engines: WebAudioEngine[] = [];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const property = (el: object, key: string, value: unknown) =>
  Object.defineProperty(el, key, { value, configurable: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(resolveTrackSource).mockReset();
  vi.mocked(resolveTrackSource).mockImplementation(async id => ({ src: `/api/stream/${id}`, blob: false }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function engineSetup() {
  let wants = true;
  const engine = new WebAudioEngine({ getLiveStreamUrl: id => `/api/stream/${id}`, wantsToPlay: () => wants });
  engines.push(engine);
  engine.attach();
  // The fixture controls media readiness; jsdom cannot decode or output audio.
  const internals = engine as any;
  internals.audioUnlocked = true;
  const [active, idle] = internals.elems as HTMLAudioElement[];
  property(active, 'readyState', 4);
  property(idle, 'readyState', 4);
  return { engine, internals, active, idle, dropIntent: () => { wants = false; } };
}

it('P01: stop invalidates a pending source resolution', async () => {
  const { engine, internals, active, dropIntent } = engineSetup();
  internals.audioUnlocked = false; // the first user-started load of this session
  property(active, 'readyState', 0);
  let resolve!: (v: { src: string; blob: boolean }) => void;
  vi.mocked(resolveTrackSource).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  engine.load({ trackId: 1 }, { autoplay: true });
  dropIntent();
  engine.stop();
  vi.mocked(active.play).mockClear();
  resolve({ src: '/api/stream/1', blob: false });
  await flush();
  expect(active.play).not.toHaveBeenCalled();
});

it('P01: pause during source lookup overrides captured autoplay', async () => {
  const { engine, internals, active, dropIntent } = engineSetup();
  internals.audioUnlocked = false;
  property(active, 'readyState', 0);
  let resolve!: (v: { src: string; blob: boolean }) => void;
  vi.mocked(resolveTrackSource).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  engine.load({ trackId: 1 }, { autoplay: true });
  dropIntent();
  engine.pause();
  vi.mocked(active.play).mockClear();
  resolve({ src: '/api/stream/1', blob: false });
  await flush();
  expect(active.play).not.toHaveBeenCalled();
});

it('P02: unresolved new preload cannot promote bytes from the previous track', async () => {
  const { engine, idle } = engineSetup();
  engine.setUpcoming({ trackId: 2 });
  await flush();
  expect(idle.src).toContain('/api/stream/2');
  vi.mocked(resolveTrackSource).mockReturnValueOnce(new Promise(() => {}));
  engine.setUpcoming({ trackId: 3 });
  engine.goToUpcoming({ trackId: 3 });
  // Must load 3 rather than deciding that the old, ready element contains 3.
  expect(resolveTrackSource).toHaveBeenCalledTimes(3);
});

it('P03: a stalled unpaused element still retries when connectivity returns', () => {
  const reload = vi.fn();
  const el = { src: '/api/stream/1', paused: false, seeking: false, error: null } as HTMLMediaElement;
  const recovery = new StallRecovery({ active: () => el, wantsToPlay: () => true, reload, setReconnecting: () => {} });
  recovery.onStall();
  recovery.onOnline();
  vi.advanceTimersByTime(60_000);
  expect(reload).toHaveBeenCalled();
});

it('P04: a reload that hangs without further media events must retry', () => {
  const reload = vi.fn();
  const el = { src: '/api/stream/1', paused: true, seeking: false, error: null } as HTMLMediaElement;
  const recovery = new StallRecovery({ active: () => el, wantsToPlay: () => true, reload, setReconnecting: () => {} });
  recovery.onStall();
  vi.advanceTimersByTime(60_000);
  expect(reload.mock.calls.length).toBeGreaterThan(1);
});

it('P05: timeupdate without clock progress must not cancel recovery', () => {
  const { engine, active } = engineSetup();
  active.src = '/api/stream/1';
  active.currentTime = 12;
  active.dispatchEvent(new Event('error'));
  active.dispatchEvent(new Event('timeupdate'));
  vi.advanceTimersByTime(20_000);
  expect(active.load).toHaveBeenCalled();
});

it('P06: direct radio recovery restarts playback after load', () => {
  const { engine, active } = engineSetup();
  engine.load({ trackId: -1, url: '/api/radio/1/stream', isLive: true }, { autoplay: true });
  vi.mocked(active.play).mockClear();
  active.dispatchEvent(new Event('error'));
  vi.advanceTimersByTime(700);
  expect(active.load).toHaveBeenCalled();
  expect(active.play).toHaveBeenCalled();
});

it('P07: unavailable crossfade must preserve the end of the outgoing song', () => {
  const { engine, internals, active, idle } = engineSetup();
  internals.graph.ensure = () => false;
  engine.setCrossfade(5);
  internals.upcomingSpec = { trackId: 2 };
  internals.preloaded = { trackId: 2, idx: 1 };
  property(active, 'duration', 100);
  active.currentTime = 96;
  active.dispatchEvent(new Event('timeupdate'));
  expect(idle.play).not.toHaveBeenCalled();
});

it('P08: direct upcoming URLs must not resolve as library IDs', async () => {
  const { engine } = engineSetup();
  engine.setUpcoming({ trackId: -2000001, url: '/api/podcasts/episodes/1/stream' });
  await flush();
  expect(resolveTrackSource).not.toHaveBeenCalled();
});

it('P09: loading a video paused must pause an already playing video', () => {
  const { engine } = engineSetup();
  engine.load({ trackId: -1, url: '/episode.mp4', isVideo: true }, { autoplay: true });
  const video = engine.getVideoElement()!;
  video.pause = vi.fn();
  engine.load({ trackId: -1, url: '/episode.mp4', isVideo: true }, { autoplay: false });
  expect(video.pause).toHaveBeenCalled();
});

it('P10: foregrounding republishes actual playback state after a missed event', () => {
  const { engine, active } = engineSetup();
  const state = vi.fn();
  engine.on('state', state);
  property(active, 'paused', true);
  active.dispatchEvent(new Event('pause'));
  state.mockClear();
  property(active, 'paused', false);
  property(document, 'visibilityState', 'visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(state).toHaveBeenCalledWith(expect.objectContaining({ playing: true }));
});
