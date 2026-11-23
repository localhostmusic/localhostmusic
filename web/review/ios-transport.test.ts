import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebAudioEngine } from '../src/player/engine/WebAudioEngine';
import { resolveTrackSource, type ResolvedSource } from '../src/player/engine/source';

vi.mock('../src/player/engine/source', () => ({resolveTrackSource:vi.fn(async (id:number) => ({src:`/stream/${id}`,blob:false}))}));
const engines: WebAudioEngine[] = [];
const spec = (id:number) => ({trackId:id,duration:240});
const flush = async () => {for(let i=0;i<10;i++) await Promise.resolve();};
function create() {
  const engine = new WebAudioEngine({getLiveStreamUrl:id => `/stream/${id}`,wantsToPlay:()=>true});
  engines.push(engine); engine.attach();
  const elems = (engine as unknown as {elems:HTMLAudioElement[]}).elems;
  return {engine,elems,el:elems[0]};
}
function ready(el:HTMLAudioElement) {
  Object.defineProperty(el,'readyState',{value:4,configurable:true});
  Object.defineProperty(el,'duration',{value:240,configurable:true});
  el.dispatchEvent(new Event('loadedmetadata')); el.dispatchEvent(new Event('canplay'));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)',platform:'iPhone',maxTouchPoints:5});
  Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
  vi.mocked(resolveTrackSource).mockReset().mockImplementation(async id => ({src:`/stream/${id}`,blob:false}));
  vi.spyOn(HTMLMediaElement.prototype,'play').mockImplementation(function(this:HTMLMediaElement){
    Object.defineProperty(this,'paused',{value:false,configurable:true});
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(function(this:HTMLMediaElement){
    Object.defineProperty(this,'paused',{value:true,configurable:true});
    this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(() => {});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:unlock');
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {});
});
afterEach(async () => {engines.splice(0).forEach(e=>e.dispose());await flush();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});});

it.each(['network', 'download'] as const)('starts the buffered next %s track while hidden without loading another source', async kind => {
  const {engine,elems,el} = create();
  engine.load(spec(1),{autoplay:true});await flush();ready(el);
  const source = kind === 'download' ? 'blob:download' : '/stream/2';
  vi.mocked(resolveTrackSource).mockResolvedValueOnce({src:source,blob:kind==='download'});
  engine.setUpcoming(spec(2));await flush();
  // Resolving a URL alone isn't enough: the browser must have a media element
  // loaded before the old track ends and iOS can suspend background loading.
  const next = elems.find(a=>a.getAttribute('src')===source);
  expect(next).toBeDefined();
  ready(next!);
  vi.mocked(resolveTrackSource).mockClear();
  vi.mocked(HTMLMediaElement.prototype.load).mockClear();
  const srcSetter = vi.spyOn(HTMLMediaElement.prototype,'src','set');
  const play = vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function(this:HTMLMediaElement) {
    // Model a suspended background load: only an already-buffered element may
    // start. This is a transport regression test, not an iOS browser emulator.
    if(this.readyState < 3) return new Promise<void>(()=>{});
    Object.defineProperty(this,'paused',{value:false,configurable:true});
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  });
  play.mockClear();
  Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
  engine.on('ended',()=>engine.goToUpcoming(spec(2)));
  Object.defineProperty(el,'ended',{value:true,configurable:true});
  el.dispatchEvent(new Event('ended'));
  expect(engine.getPlaybackState()).toMatchObject({trackId:2,playing:true});
  expect(play.mock.instances).toContain(next);
  expect(srcSetter).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  expect(resolveTrackSource).not.toHaveBeenCalled();
});

it('also retains media-element preloading on an iPad using a desktop user agent', async () => {
  vi.stubGlobal('navigator',{userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5});
  const {engine,elems} = create();
  engine.setUpcoming(spec(2));await flush();
  expect(elems[1]?.getAttribute('src')).toBe('/stream/2');
});

it('discards a late downloaded preload when the upcoming queue is cleared', async () => {
  const {engine,elems} = create();
  let finish!: (s:ResolvedSource)=>void;
  vi.mocked(resolveTrackSource).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  engine.setUpcoming(spec(2));engine.setUpcoming(null);
  finish({src:'blob:abandoned',blob:true});await flush();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:abandoned');
  expect(elems.every(el=>el.getAttribute('src')!=='blob:abandoned')).toBe(true);
});

it('retains a promoted download through pause and seek until active playback releases it', async () => {
  const {engine,elems} = create();
  vi.mocked(resolveTrackSource).mockResolvedValueOnce({src:'blob:download',blob:true});
  engine.setUpcoming(spec(2));await flush();ready(elems[1]);
  engine.goToUpcoming(spec(2));engine.pause();engine.seek(83);
  expect(elems[1].getAttribute('src')).toBe('blob:download');
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:download');
  expect(engine.getPlaybackState()).toMatchObject({playing:false,currentTime:83});
  engine.stop();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
});

it('releases preloaded downloads when the queue is cleared or the engine is disposed', async () => {
  const {engine} = create();
  vi.mocked(resolveTrackSource).mockResolvedValueOnce({src:'blob:cleared',blob:true});
  engine.setUpcoming(spec(2));await flush();engine.setUpcoming(null);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cleared');
  vi.mocked(resolveTrackSource).mockResolvedValueOnce({src:'blob:disposed',blob:true});
  engine.setUpcoming(spec(3));await flush();engine.dispose();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:disposed');
});
