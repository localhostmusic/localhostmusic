import { afterEach, expect, it, vi } from 'vitest';
import { resolveTrackSource } from './source';
vi.mock('../downloads', () => ({downloadedUrl: () => null}));
afterEach(() => {vi.unstubAllGlobals();vi.useRealTimers();});
it('bounds source lookup latency when Cache Storage hangs', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('caches',{open: () => new Promise(() => {})});
  const pending = resolveTrackSource(1,'/api/stream/1');
  await vi.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toEqual({src:'/api/stream/1?src=n',blob:false});
});

// Cached audio plays from memory: no network and no service worker in the byte path.
function cacheWith(entries: Record<string, Record<string, Response>>) {
  const deleted: string[] = [];
  vi.stubGlobal('caches', { open: async (name: string) => ({
    match: async (u: string) => entries[name]?.[u]?.clone(),
    put: async () => {}, keys: async () => [],
    delete: async (u: string) => { deleted.push(u); delete entries[name]?.[u]; return true; },
  }) });
  return deleted;
}
const audio = (body: string, length = body.length) => new Response(body, { headers: { 'content-length': String(length) } });

it('plays a prefetched track from a blob of the cached bytes', async () => {
  cacheWith({ 'lhm-audio-v1': { '/api/stream/1': audio('whole file') } });
  const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cached');
  await expect(resolveTrackSource(1, '/api/stream/1')).resolves.toEqual({ src: 'blob:cached', blob: true });
  made.mockRestore();
});
it('refuses a truncated cache entry and drops it, rather than play a song that ends early', async () => {
  const deleted = cacheWith({ 'lhm-audio-v1': { '/api/stream/1': audio('half', 4000) } });
  await expect(resolveTrackSource(1, '/api/stream/1')).resolves.toEqual({ src: '/api/stream/1?src=n', blob: false });
  expect(deleted).toEqual(['/api/stream/1']);
});
it('streams a cached file too large to hold in memory', async () => {
  cacheWith({ 'lhm-audio-v1': { '/api/stream/1': audio('x', 64 * 1024 * 1024) } });
  await expect(resolveTrackSource(1, '/api/stream/1')).resolves.toEqual({ src: '/api/stream/1?src=c', blob: false });
});
