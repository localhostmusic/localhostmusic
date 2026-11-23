import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../src/player/engine/WebAudioEngine';
import { resolveTrackSource } from '../src/player/engine/source';
vi.mock('../src/player/engine/source', () => ({resolveTrackSource: vi.fn()}));
let engine: WebAudioEngine;
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(() => {});
  vi.mocked(resolveTrackSource).mockResolvedValue({src:'/api/stream/1',blob:false});
  engine = new WebAudioEngine({getLiveStreamUrl:id=>`/api/stream/${id}`,wantsToPlay:()=>true});
});
afterEach(() => {engine.dispose();vi.restoreAllMocks();});
it('preserves a handed-off position while the new media element still reads zero', async () => {
  engine.load({trackId:1,duration:240},{autoplay:true,resumeAt:83});
  expect(engine.getCurrentTime()).toBe(83);
  expect(engine.getPlaybackState()).toMatchObject({currentTime:83,positionPending:true});
  await flush();
  expect(engine.getPlaybackState()).toMatchObject({currentTime:83,positionPending:true});
  // The browser has now decoded metadata and completed the seek.
  const audio = (engine as unknown as {elems:HTMLAudioElement[]}).elems[0];
  Object.defineProperty(audio,'readyState',{value:4,configurable:true});
  audio.dispatchEvent(new Event('loadedmetadata'));
  audio.dispatchEvent(new Event('canplay'));
  expect(audio.currentTime).toBe(83);
  expect(engine.getPlaybackState()).toMatchObject({currentTime:83,positionPending:false});
});
it('a seek made during source lookup overrides the handoff resume point', async () => {
  let resolve!: (source:{src:string;blob:boolean}) => void;
  vi.mocked(resolveTrackSource).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  engine.load({trackId:1,duration:240},{autoplay:true,resumeAt:83});
  engine.seek(120);
  resolve({src:'/api/stream/1',blob:false}); await flush();
  const audio = (engine as unknown as {elems:HTMLAudioElement[]}).elems[0];
  Object.defineProperty(audio,'readyState',{value:4,configurable:true});
  audio.dispatchEvent(new Event('loadedmetadata')); audio.dispatchEvent(new Event('canplay'));
  expect(audio.currentTime).toBe(120);
});
