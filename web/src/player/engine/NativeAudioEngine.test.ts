import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeAudioEngine } from "./NativeAudioEngine";
import { LhmAudio } from "./nativeBridge";
const native = vi.hoisted(() => ({ events: new Map<string, (data: any) => void>(), remove: vi.fn() }));
vi.mock("./nativeBridge", () => ({ LhmAudio: {
  addListener: vi.fn(async (event, fn) => { native.events.set(event, fn); return { remove: native.remove }; }),
  getState: vi.fn(), load: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
  stop: vi.fn(async () => {}), setPlaybackRate: vi.fn(async () => {}), setUpcoming: vi.fn(async () => {}),
} }));
const flush = async () => { for (let i=0; i<60; i++) await Promise.resolve(); };
let engine: NativeAudioEngine;
beforeEach(() => {
  vi.clearAllMocks(); native.events.clear(); native.remove.mockResolvedValue(undefined);
  vi.mocked(LhmAudio.getState).mockResolvedValue({ paused: true });
  engine = new NativeAudioEngine({getLiveStreamUrl: id => `/api/stream/${id}`});
});
afterEach(() => engine.dispose());
it("waits for native readiness and preserves load/pause command order", async () => {
  let ready!: (value: {paused: boolean}) => void;
  vi.mocked(LhmAudio.getState).mockReturnValueOnce(new Promise(r => {ready=r;}));
  engine.attach();
  engine.load({trackId: -1, url: "/radio/stream"}, {autoplay: true});
  engine.pause();
  await flush();
  expect(LhmAudio.load).not.toHaveBeenCalled();
  ready({paused: true}); await flush();
  expect(LhmAudio.load).toHaveBeenCalledWith(expect.objectContaining({url: new URL("/radio/stream", location.origin).href}));
  expect(vi.mocked(LhmAudio.pause).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(LhmAudio.load).mock.invocationCallOrder[0]);
});
it("updates the active descriptor on automatic transition and exposes errors", async () => {
  engine.attach(); await flush();
  engine.load({trackId: 1}, {autoplay: true});
  engine.setUpcoming({trackId: -2, url: "/episode.mp3", duration: 50});
  await flush(); native.events.get("trackChanged")!({});
  expect(engine.getPlaybackState().trackId).toBe(-2);
  native.events.get("audioerror")!({message: "Connection failed"});
  expect(engine.getPlaybackState()).toMatchObject({playing: false, error: "Connection failed"});
});
it("sends speed changes and removes late listeners after disposal", async () => {
  engine.attach(); engine.setPlaybackRate(1.5, true); await flush();
  expect(LhmAudio.setPlaybackRate).toHaveBeenCalledWith({rate: 1.5, preservePitch: true});
  const handles = native.events.size;
  engine.dispose(); await flush();
  expect(native.remove).toHaveBeenCalledTimes(handles);
});
