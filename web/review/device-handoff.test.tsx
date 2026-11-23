import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer, usePlayerTime } from '../src/player/PlayerProvider';
import { MediaSession } from '../src/player/MediaSession';
import type { ConnectClient, SessionState } from '../src/player/connectClient';
import type { WebAudioEngine } from '../src/player/engine/WebAudioEngine';

type Handlers = ConstructorParameters<typeof ConnectClient>[0];
const fixture = vi.hoisted(() => ({
  mounting: 'phone',
  engines: new Map<string, WebAudioEngine>(),
  clients: new Map<string, { h: Handlers; reportPosition: ReturnType<typeof vi.fn>; transfer: ReturnType<typeof vi.fn> }>(),
  players: new Map<string, ReturnType<typeof usePlayer>>(),
}));
vi.mock('../src/player/device', () => ({getConnId: () => fixture.mounting, setDeviceName: vi.fn()}));
vi.mock('../src/player/engine/source', () => ({resolveTrackSource: vi.fn(async (id:number) => ({src:`/api/stream/${id}`,blob:false}))}));
vi.mock('../src/player/engine/WebAudioEngine', async original => {
  const {WebAudioEngine: Engine} = await original<typeof import('../src/player/engine/WebAudioEngine')>();
  return {WebAudioEngine: class extends Engine {
    constructor(...args: ConstructorParameters<typeof Engine>) { super(...args); fixture.engines.set(fixture.mounting,this); }
  }};
});
vi.mock('../src/player/connectClient', () => ({ConnectClient: class {
  h: Handlers;
  reportPosition = vi.fn(); transfer = vi.fn(); command = vi.fn(); stop = vi.fn();
  constructor(h: Handlers) {this.h=h;fixture.clients.set(fixture.mounting,this);}
  start() { this.h.onStatus?.(true); }
}}));
const flush = async () => {for(let i=0;i<15;i++) await Promise.resolve();};
function Probe({name}:{name:string}) {
  const p = usePlayer(), t = usePlayerTime();
  fixture.players.set(name,p);
  return <span data-testid={name}>{t.currentTime.toFixed(0)}</span>;
}
function audio(name:string) {
  const e = fixture.engines.get(name)! as unknown as {elems: HTMLAudioElement[]; activeIdx:number};
  return e.elems[e.activeIdx];
}
function ready(name:string,position:number) {
  const el = audio(name);
  Object.defineProperty(el,'readyState',{value:4,configurable:true});
  Object.defineProperty(el,'duration',{value:240,configurable:true});
  Object.defineProperty(el,'paused',{value:false,configurable:true});
  Object.defineProperty(el,'ended',{value:false,configurable:true});
  el.dispatchEvent(new Event('loadedmetadata'));
  el.dispatchEvent(new Event('canplay'));
  el.currentTime=position;
  el.dispatchEvent(new Event('playing'));
  el.dispatchEvent(new Event('timeupdate'));
}
const state = (activeDeviceId:string, position:number, isPlaying=true): SessionState => ({
  activeDeviceId,position,isPlaying,positionAt:Date.now(),updatedAt:Date.now(),
  queue:[{id:1,title:'Song',duration:240}],order:[0],pos:0,volume:1,shuffle:false,repeat:'off',
});
describe.each(['desktop', 'iPhone'])('%s transport', mode => {
beforeEach(() => {
  localStorage.clear(); fixture.engines.clear(); fixture.clients.clear(); fixture.players.clear();
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'mediaSession', {configurable:true, value:{metadata:null,playbackState:'none',setActionHandler:vi.fn(),setPositionState:vi.fn()}});
  vi.stubGlobal('MediaMetadata', class {constructor(data:object){Object.assign(this,data);}});
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(function(this:HTMLMediaElement) {
    Object.defineProperty(this,'paused',{value:true,configurable:true}); this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(() => {});
  const userAgent = vi.spyOn(navigator,'userAgent','get').mockReturnValue(mode === 'iPhone' ? 'iPhone' : 'Chrome');
  fixture.mounting='phone';render(<PlayerProvider><Probe name="phone"/><MediaSession/></PlayerProvider>);
  localStorage.clear();
  userAgent.mockReturnValue('Chrome');
  fixture.mounting='chrome';render(<PlayerProvider><Probe name="chrome"/></PlayerProvider>);
});
afterEach(async () => {cleanup();await flush();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('updates OS metadata during a background track transition before React commits', async () => {
  const queue = [{id:1,title:'First',duration:240},{id:2,title:'Second',duration:240}];
  await act(async () => {
    fixture.players.get('phone')!.playNow(queue,0);
    await flush(); ready('phone',239);
    fixture.engines.get('phone')!.setUpcoming({trackId:2,duration:240});
    await flush();
  });
  expect(navigator.mediaSession.metadata?.title).toBe('First');
  const engine = fixture.engines.get('phone')! as unknown as {elems:HTMLAudioElement[];activeIdx:number};
  expect(engine.elems).toHaveLength(2);
  const next = engine.elems[1-engine.activeIdx];
  Object.defineProperty(next,'readyState',{value:4,configurable:true});
  Object.defineProperty(next,'duration',{value:240,configurable:true});
  Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
  act(() => {
    const old = audio('phone');
    Object.defineProperty(old,'ended',{value:true,configurable:true});
    old.dispatchEvent(new Event('ended'));
    ready('phone',0);
    // These assertions run before React's act() commit.
    expect(fixture.players.get('phone')!.current?.id).toBe(1);
    expect(navigator.mediaSession.metadata?.title).toBe('Second');
    expect(navigator.mediaSession.playbackState).toBe('playing');
    expect(navigator.mediaSession.setPositionState).toHaveBeenLastCalledWith({duration:240,position:0,playbackRate:1});
  });
  expect(fixture.players.get('phone')!.current?.id).toBe(2);
  Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
});
it('keeps both progress bars at the resume point through phone to Chrome and back', async () => {
  const phone = fixture.clients.get('phone')!, chrome = fixture.clients.get('chrome')!;
  await act(async () => {fixture.players.get('phone')!.playNow(state('phone',83).queue,0,83); await flush(); ready('phone',83);});
  act(() => {phone.h.onState?.(state('phone',83)); chrome.h.onState?.(state('phone',83));});
  expect(screen.getByTestId('phone').textContent).toBe('83');
  expect(screen.getByTestId('chrome').textContent).toBe('83');
  phone.reportPosition.mockClear(); chrome.reportPosition.mockClear();

  act(() => fixture.players.get('phone')!.transferTo('chrome'));
  expect(phone.reportPosition).toHaveBeenLastCalledWith(83,true);
  await act(async () => {
    chrome.h.onApply?.({action:'load',trackId:1,position:83,play:true,pos:0});
    phone.h.onState?.(state('chrome',83)); chrome.h.onState?.(state('chrome',83));
    await flush();
    audio('chrome').currentTime=0; audio('chrome').dispatchEvent(new Event('durationchange'));
  });
  expect(screen.getByTestId('phone').textContent).toBe('83');
  expect(screen.getByTestId('chrome').textContent).toBe('83');
  expect(chrome.reportPosition).not.toHaveBeenCalled();
  act(() => ready('chrome',83));
  expect(chrome.reportPosition).toHaveBeenLastCalledWith(83,true);

  act(() => {ready('chrome',98);phone.h.onPosition?.({position:98,isPlaying:true,at:Date.now()});});
  phone.reportPosition.mockClear();
  await act(async () => {
    Object.defineProperty(audio('phone'),'readyState',{value:0,configurable:true});
    fixture.players.get('phone')!.transferTo('phone');
    chrome.h.onApply?.({action:'stop'});
    phone.h.onState?.(state('phone',98));chrome.h.onState?.(state('phone',98));
    await flush();
    audio('phone').currentTime=0;audio('phone').dispatchEvent(new Event('durationchange'));
  });
  expect(screen.getByTestId('phone').textContent).toBe('98');
  expect(screen.getByTestId('chrome').textContent).toBe('98');
  expect(phone.reportPosition).not.toHaveBeenCalled();
  act(() => ready('phone',98));
  expect(phone.reportPosition).toHaveBeenLastCalledWith(98,true);
  act(() => phone.h.onPosition?.({position:0,isPlaying:false,at:Date.now()})); // late tick from old owner
  expect(screen.getByTestId('phone').textContent).toBe('98');
});
it('updates a passive progress bar immediately for a paused position tick', () => {
  const phone=fixture.clients.get('phone')!;
  act(() => phone.h.onState?.(state('chrome',83,false)));
  act(() => phone.h.onPosition?.({position:120,isPlaying:false,at:Date.now()}));
  expect(screen.getByTestId('phone').textContent).toBe('120');
});
});
