import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { downloadGroup, groupDownloaded, groupTracks } from '../src/player/downloads';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('D01: a group whose downloads all failed must not be marked downloaded', async () => {
  localStorage.clear();
  vi.stubGlobal('caches', { open: async () => ({ put: vi.fn() }) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await expect(downloadGroup({ kind: 'album', id: 987, name: 'Failed download' }, [{ id: 123, title: 'Song' }], 256)).rejects.toThrow('Downloaded 0 of 1');
  expect(groupTracks('album', 987)).toEqual([]);
  expect(groupDownloaded('album', 987)).toBe(false);
});

it('D02: a GET started before a mutation must not repopulate stale cache data', async () => {
  let resolve!: (v: Response) => void;
  const fetch = vi.fn()
    .mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json([]));
  vi.stubGlobal('fetch', fetch);
  const pending = api.getFavorites();
  await api.removeFavorite(123);
  resolve(Response.json([{ id: 123 }]));
  await pending;
  expect(await api.getFavorites()).toEqual([]);
});
