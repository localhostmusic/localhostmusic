// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

function worker() {
  const buckets = new Map<string, Map<string, Response>>();
  const key = (r: string | Request) => new URL(typeof r === 'string' ? r : r.url, 'https://lhm.test').href;
  const caches = { open: async (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const data = buckets.get(name)!;
    return {
      match: async (r: string | Request) => data.get(key(r))?.clone(),
      put: async (r: string | Request, response: Response) => { data.set(key(r), response.clone()); },
      keys: async () => [...data.keys()].map(url => new Request(url)),
      delete: async (r: string | Request) => data.delete(key(r)),
    };
  } };
  const listeners: Record<string, (e: any) => void> = {};
  const fetch = vi.fn(async () => new Response('network audio', { headers: { 'Content-Type': 'audio/mpeg' } }));
  const context = vm.createContext({
    self: { addEventListener(type: string, fn: (e: unknown) => void) { listeners[type] = fn; }, clients: { claim() {} } }, navigator: { userAgent: 'Safari/605.1.15' },
    location: { origin: 'https://lhm.test' }, caches, fetch,
    Blob, ReadableStream, URL, Request, Response, AbortController, setTimeout, clearTimeout, console,
  });
  vm.runInContext(readFileSync(resolve('public/sw.js'), 'utf8') +
    '\nglobalThis.audit = {serveAudio, rangeFrom, cacheShell, storeTee, abortFillsExcept};', context);
  return { audit: context.audit, caches, fetch, listeners };
}

it('S01: an uncached media GET without Range must receive audio, not 204', async () => {
  const { audit } = worker();
  const work: Promise<unknown>[] = [];
  const response = await audit.serveAudio({
    request: new Request('https://lhm.test/api/stream/1?src=n'),
    waitUntil: (p: Promise<unknown>) => work.push(p),
  });
  await Promise.all(work);
  expect(response.status).toBe(200);
});

it('S02: a network-pinned load must stay on network after a download appears', async () => {
  const { audit, caches, fetch } = worker();
  await (await caches.open('lhm-downloads')).put('/api/stream/1', new Response('downloaded audio'));
  const response = await audit.serveAudio({
    request: new Request('https://lhm.test/api/stream/1?src=n', { headers: { Range: 'bytes=0-' } }),
    waitUntil() {},
  });
  await response.text();
  expect(fetch).toHaveBeenCalled();
});

it('S03: re-downloading a key must not serve stale in-memory bytes', async () => {
  const { audit } = worker();
  await audit.rangeFrom(new Response('OLD'), '/api/stream/1', 'bytes=0-');
  const response = await audit.rangeFrom(new Response('NEW'), '/api/stream/1', 'bytes=0-');
  expect(await response.text()).toBe('NEW');
});

it('S04: failed bundle download must preserve the working offline shell', async () => {
  const { audit, caches, fetch } = worker();
  const cache = await caches.open('lhm-v24');
  await cache.put('/index.html', new Response('working shell'));
  fetch.mockRejectedValue(new Error('offline during deploy'));
  await expect(audit.cacheShell(cache, new Response('<script src="/assets/new.js"></script>', {headers: {'Content-Type':'text/html'}}))).rejects.toThrow();
  expect(await (await cache.match('/index.html'))!.text()).toBe('working shell');
});

it('S05: aborting a cache tee must cancel its underlying reader', async () => {
  const { audit, caches } = worker();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: cancelled });
  // Observe the real locked-stream behavior while suppressing its unhandled
  // rejection inside this diagnostic test (production does not suppress it).
  const cancel = stream.cancel.bind(stream);
  stream.cancel = reason => cancel(reason).catch(() => {});
  const work = audit.storeTee(await caches.open('lhm-audio-v1'), '/old', stream, 3, 'audio/mpeg');
  audit.abortFillsExcept('/new');
  const wasCancelled = cancelled.mock.calls.length;
  if (!wasCancelled) controller.close();
  await work;
  expect(wasCancelled).toBe(1);
});

it.each([
  ['bytes=0-1',206,'AB'], ['bytes=3-',206,'DE'], ['bytes=-2',206,'DE'],
  ['bytes=2-99',206,'CDE'], ['bytes=99-',416,''], ['bytes=3-2',416,''],
])('cached audio honors %s', async (range, status, body) => {
  const {audit} = worker();
  const response = await audit.rangeFrom(new Response('ABCDE',{headers:{'Content-Length':'5'}}),'/song',range);
  expect(response.status).toBe(status); expect(await response.text()).toBe(body);
});
it('live network playback is not blocked by hung Cache Storage', async () => {
  const {audit,caches} = worker();
  caches.open = () => new Promise(() => {});
  const response = await audit.serveAudio({request: new Request('https://lhm.test/api/stream/1?src=n'),waitUntil() {}});
  expect(await response.text()).toBe('network audio');
});
it('rejects a new offline shell whose lazy-chunk manifest is unavailable', async () => {
  const {audit,caches,fetch} = worker();
  const cache = await caches.open('shell');
  await cache.put('/index.html',new Response('old shell'));
  fetch.mockRejectedValue(new Error('offline'));
  await expect(audit.cacheShell(cache,new Response('<meta name="lhm-offline-manifest" content="1"><script src="/assets/main.js"></script>',{headers:{'Content-Type':'text/html'}}))).rejects.toThrow();
  expect(await (await cache.match('/index.html'))!.text()).toBe('old shell');
});

// The worker must stay out of the byte path of a live network load: iOS suspends
// it while a locked phone keeps playing, and a stream it was relaying stops.
it('declines a network-pinned media load so the browser fetches it natively', () => {
  const { listeners, fetch } = worker();
  const respondWith = vi.fn();
  listeners.fetch({ request: new Request('https://lhm.test/api/stream/1?bitrate=320&src=n', { headers: { Range: 'bytes=0-' } }), respondWith });
  expect(respondWith).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  ['a cache-pinned load', 'https://lhm.test/api/stream/1?src=c', {}],
  ['an explicit prefetch', 'https://lhm.test/api/stream/1?src=n', { 'x-lhm-prefetch': '1' }],
  ['a download', 'https://lhm.test/api/stream/1?src=n', { 'x-lhm-dl': '1' }],
])('still serves %s itself', async (_name, url, headers) => {
  const { listeners } = worker();
  const respondWith = vi.fn((p: Promise<Response>) => { void p.catch(() => {}); });
  listeners.fetch({ request: new Request(url, { headers }), respondWith, waitUntil() {} });
  expect(respondWith).toHaveBeenCalledTimes(1);
});
