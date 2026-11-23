import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MediaSession } from "./MediaSession";
const model = vi.hoisted(() => ({ p: {} as any, t: {currentTime: 0} }));
vi.mock("./PlayerProvider", () => ({usePlayer: () => model.p, usePlayerTime: () => model.t}));
let actions: Map<string, (d: any) => void>;
let session: any;
let transportListeners: Set<() => void>;
let transport: any;
beforeEach(() => {
  vi.useFakeTimers();
  transportListeners = new Set();
  transport = {current: {id: 1, title: "Song"}, playing: true, duration: 100, currentTime: 42, effectiveRate: 1};
  Object.defineProperty(document, "visibilityState", {value: "visible", configurable: true});
  actions = new Map();
  session = {metadata: null, playbackState: "none", setPositionState: vi.fn(), setActionHandler: vi.fn((a,h) => actions.set(a,h))};
  Object.defineProperty(navigator, "mediaSession", {value: session, configurable: true});
  vi.stubGlobal("MediaMetadata", class { constructor(data: object) {Object.assign(this,data);} });
  model.p = { current: {id: 1, title: "Song"}, isPlaying: false, duration: 100, effectiveRate: 1,
    play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn(),
    getTransportState: () => transport,
    getMediaSessionState: () => transport,
    subscribeTransport: (fn: () => void) => {transportListeners.add(fn); return () => transportListeners.delete(fn);} };
});

// Handlers are re-bound on every republish (iOS drops them whenever WebKit's
// remote-command listener is recreated). Re-binding must reuse the same handler
// functions and leave prev/next set and the time-skip actions cleared.
function expectStableBindings(firstCalls: number) {
  const calls = session.setActionHandler.mock.calls as [string, unknown][];
  const first = new Map(calls.slice(0, firstCalls));
  for (const [action, handler] of calls.slice(firstCalls)) expect(handler).toBe(first.get(action));
  expect(actions.get("previoustrack")).toBeTypeOf("function");
  expect(actions.get("nexttrack")).toBeTypeOf("function");
  expect(actions.get("seekbackward")).toBeNull();
  expect(actions.get("seekforward")).toBeNull();
}
it("publishes background track changes and resume without a React render", () => {
  render(<MediaSession/>);
  const count = session.setActionHandler.mock.calls.length;
  Object.defineProperty(document, "visibilityState", {value: "hidden", configurable: true});
  transport = {...transport, current: {id: 2, title: "Next song"}, playing: false, currentTime: 0};
  transportListeners.forEach(fn => fn());
  expect(session.metadata.title).toBe("Next song");
  expect(session.playbackState).toBe("paused");
  transport.playing = true;
  transport.currentTime = 1;
  transportListeners.forEach(fn => fn());
  expect(session.playbackState).toBe("playing");
  expect(session.setPositionState).toHaveBeenLastCalledWith({duration:100, position:1, playbackRate:1});
  expectStableBindings(count);
});
it("restores metadata and actual playback on lifecycle events without restarting audio", () => {
  render(<MediaSession/>);
  session.metadata = null;
  session.playbackState = "none";
  Object.defineProperty(document, "visibilityState", {value: "hidden", configurable: true});
  document.dispatchEvent(new Event("visibilitychange"));
  expect(session.metadata.title).toBe("Song");
  expect(session.playbackState).toBe("playing");
  const metadata = session.metadata;
  window.dispatchEvent(new Event("pageshow"));
  expect(session.metadata).not.toBe(metadata);
  expect(model.p.play).not.toHaveBeenCalled();
  expect(model.p.pause).not.toHaveBeenCalled();
});
it("corrects a lost playback state on an audio tick and keeps completed track metadata", () => {
  render(<MediaSession/>);
  session.playbackState = "none";
  transportListeners.forEach(fn => fn());
  expect(session.playbackState).toBe("playing");
  transport.playing = false; transport.currentTime = 100;
  transportListeners.forEach(fn => fn());
  expect(session.playbackState).toBe("paused");
  expect(session.metadata.title).toBe("Song");
  expect(session.setPositionState).toHaveBeenLastCalledWith({duration:100,position:100,playbackRate:1});
});
it("avoids metadata churn on ordinary ticks and removes transport listeners on unmount", () => {
  const {unmount} = render(<MediaSession/>);
  const metadata = session.metadata;
  session.setPositionState.mockClear();
  transport.currentTime += 0.25;
  transportListeners.forEach(fn => fn());
  expect(session.metadata).toBe(metadata);
  expect(session.setPositionState).not.toHaveBeenCalled();
  unmount();
  expect(transportListeners.size).toBe(0);
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});
it("uses explicit transport commands even when React's playing flag is stale", () => {
  render(<MediaSession/>);
  actions.get("pause")!({}); actions.get("play")!({});
  expect(model.p.pause).toHaveBeenCalledOnce();
  expect(model.p.play).toHaveBeenCalledOnce();
});
it("keeps handlers stable across ticks and restores actual state on foreground", () => {
  const {rerender} = render(<MediaSession/>);
  const count = session.setActionHandler.mock.calls.length;
  model.t.currentTime = 40; rerender(<MediaSession/>);
  expect(session.setActionHandler).toHaveBeenCalledTimes(count);
  Object.defineProperty(document, "visibilityState", {value: "visible", configurable: true});
  document.dispatchEvent(new Event("visibilitychange"));
  expect(session.playbackState).toBe("playing");
  expect(session.setPositionState).toHaveBeenLastCalledWith({duration: 100, position: 42, playbackRate: 1});
});

it("exposes previous/next track buttons without competing time-skip actions", () => {
  render(<MediaSession/>);
  expect(actions.get("seekbackward")).toBeNull();
  expect(actions.get("seekforward")).toBeNull();
  actions.get("previoustrack")!({});
  actions.get("nexttrack")!({});
  actions.get("seekto")!({seekTime: 25});
  expect(model.p.prev).toHaveBeenCalledOnce();
  expect(model.p.next).toHaveBeenCalledOnce();
  expect(model.p.seek).toHaveBeenCalledWith(25);
});

it("re-binds the remote controls when playback starts, so iOS learns about prev/next", () => {
  transport = {...transport, playing: false};
  render(<MediaSession/>);
  session.setActionHandler.mockClear(); actions.clear(); // WebKit's listener didn't exist yet
  transport.playing = true;
  transportListeners.forEach(fn => fn());
  expect(actions.get("previoustrack")).toBeTypeOf("function");
  expect(actions.get("nexttrack")).toBeTypeOf("function");
  expect(actions.get("seekbackward")).toBeNull();
});

it("republishes an intact JS session on background progress to repair a lost OS card", () => {
  render(<MediaSession/>);
  vi.runOnlyPendingTimers();
  Object.defineProperty(document, "visibilityState", {value: "hidden", configurable: true});
  const metadata = session.metadata;
  const handlerCount = session.setActionHandler.mock.calls.length;
  // Losing the native presentation need not change either JS property.
  vi.advanceTimersByTime(10_000);
  expect(session.metadata).toBe(metadata); // no polling timer / audio restart
  transport.currentTime = 52;
  transportListeners.forEach(fn => fn());
  expect(session.metadata).not.toBe(metadata);
  expect(session.playbackState).toBe("playing");
  expect(session.setPositionState).toHaveBeenLastCalledWith({duration:100, position:52, playbackRate:1});
  expectStableBindings(handlerCount);
  expect(model.p.play).not.toHaveBeenCalled();
});

it("rereads playback after an OS action instead of retaining its pre-play snapshot", () => {
  transport.playing = false;
  render(<MediaSession/>);
  vi.runOnlyPendingTimers();
  actions.get("play")!({});
  expect(session.playbackState).toBe("paused");
  // Playback starts after the action returns, before a media event/React commit.
  transport.playing = true;
  vi.runOnlyPendingTimers();
  expect(session.playbackState).toBe("playing");
  expect(model.p.play).toHaveBeenCalledOnce();
});

it("repairs a late OS state overwrite after a track transition", () => {
  render(<MediaSession/>);
  vi.runOnlyPendingTimers();
  transport = {...transport, current: {id: 2, title: "Next song"}, currentTime: 0};
  transportListeners.forEach(fn => fn());
  // The old element's queued pause can land after the new track was published.
  session.playbackState = "paused";
  session.metadata = null;
  vi.runOnlyPendingTimers();
  expect(session.metadata.title).toBe("Next song");
  expect(session.playbackState).toBe("playing");
});

it("does not periodically reclaim the card while paused and cancels deferred work on unmount", () => {
  transport.playing = false;
  const {unmount} = render(<MediaSession/>);
  vi.runOnlyPendingTimers();
  const metadata = session.metadata;
  vi.advanceTimersByTime(30_000);
  transportListeners.forEach(fn => fn());
  expect(session.metadata).toBe(metadata);
  window.dispatchEvent(new Event("pageshow"));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  session.metadata = null;
  window.dispatchEvent(new Event("pageshow"));
  window.dispatchEvent(new Event("pagehide"));
  expect(session.metadata).toBeNull();
});
