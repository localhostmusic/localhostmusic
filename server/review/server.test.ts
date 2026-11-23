import { afterEach, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/lib/auth.js';
import { scanLibrary } from '../src/scanner/scan.js';
import { readTags } from '../src/scanner/tags.js';
import { transcodedFile } from '../src/lib/transcode.js';

vi.mock('../src/lib/transcode.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/transcode.js')>(),
  transcodedFile: vi.fn(),
}));

const fixture = join(import.meta.dirname, '../test/fixtures/song-a.mp3');
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function appFixture() {
  const db = openDb(':memory:');
  cleanups.push(() => db.close());
  const data = mkdtempSync(join(tmpdir(), 'lhm-audit-'));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  await scanLibrary(db, join(import.meta.dirname, '../test/fixtures'), data);
  db.prepare('INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,?,?,1)').run('review', 'unused');
  const app = buildApp(db);
  cleanups.push(() => app.close());
  const cookies = { lhm_session: signToken({ id: 1, username: 'review', isAdmin: true }) };
  const track = db.prepare('SELECT id FROM tracks LIMIT 1').get() as { id: number };
  return { app, db, cookies, track };
}

it('B01: invalid streaming bitrate must be rejected before transcoding', async () => {
  const { app, cookies, track } = await appFixture();
  vi.mocked(transcodedFile).mockResolvedValue(fixture);
  const response = await app.inject({ url: `/api/stream/${track.id}?bitrate=not-a-number`, cookies });
  expect(response.statusCode).toBe(400);
});

it('B02: deleted users must lose authenticated API access', async () => {
  const { app, db, cookies } = await appFixture();
  db.prepare('DELETE FROM users WHERE id=1').run();
  const response = await app.inject({ url: '/api/admin/users', cookies });
  expect(response.statusCode).toBe(401);
});

it('B03: downloaded podcast must honor a suffix byte range', async () => {
  const { app, db, cookies } = await appFixture();
  db.prepare('INSERT INTO podcast_channels(id,user_id,feed_url,title,added_at) VALUES(1,1,?,?,0)').run('https://example.test/feed', 'Review');
  db.prepare('INSERT INTO podcast_episodes(id,channel_id,guid,title,audio_url,local_path) VALUES(1,1,?,?,?,?)')
    .run('review-episode', 'Episode', 'https://example.test/episode.mp3', fixture);
  const response = await app.inject({ url: '/api/podcasts/episodes/1/stream', cookies, headers: { range: 'bytes=-100' } });
  expect(response.statusCode).toBe(206);
});

it('B04: rescan must refresh metadata after replacing a file in place', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lhm-audit-scan-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const music = join(root, 'music');
  mkdirSync(music);
  const file = join(music, 'song.mp3');
  copyFileSync(fixture, file);
  const db = openDb(':memory:');
  cleanups.push(() => db.close());
  await scanLibrary(db, music, root);
  const replacement = join(import.meta.dirname, '../test/fixtures/song-b.mp3');
  copyFileSync(replacement, file);
  const tags = await readTags(file);
  await scanLibrary(db, music, root);
  const track = db.prepare('SELECT title FROM tracks WHERE path=?').get(file) as { title: string };
  expect(track.title).toBe(tags.title);
});

it('demotion takes effect for an already-issued admin cookie', async () => {
  const { app, db, cookies } = await appFixture();
  db.prepare('UPDATE users SET is_admin=0 WHERE id=1').run();
  expect((await app.inject({url:'/api/admin/users', cookies})).statusCode).toBe(403);
});
it('logout revokes the cookie while a new login token stays usable', async () => {
  const { app, cookies } = await appFixture();
  expect((await app.inject({method:'POST', url:'/api/auth/logout', cookies})).statusCode).toBe(200);
  expect((await app.inject({url:'/api/me', cookies})).statusCode).toBe(401);
  const fresh = {lhm_session: signToken({id:1, username:'review', isAdmin:true})};
  expect((await app.inject({url:'/api/me', cookies:fresh})).statusCode).toBe(200);
});
it.each(['bytes=9999999-', 'bytes=100-10', 'bytes=-0'])('rejects unsatisfiable podcast range %s', async range => {
  const { app, db, cookies } = await appFixture();
  db.prepare('INSERT INTO podcast_channels(id,user_id,feed_url,title,added_at) VALUES(1,1,?,?,0)').run('https://example.test/feed','Review');
  db.prepare('INSERT INTO podcast_episodes(id,channel_id,guid,title,audio_url,local_path) VALUES(1,1,?,?,?,?)')
    .run('episode','Episode','https://example.test/audio',fixture);
  expect((await app.inject({url:'/api/podcasts/episodes/1/stream',cookies,headers:{range}})).statusCode).toBe(416);
});
