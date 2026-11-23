import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { signToken } from '../src/lib/auth.js';
import * as sc from '../src/lib/scrobble.js';
vi.mock('../src/lib/scrobble.js', () => ({lastfmAvailable: () => false, lbListen: vi.fn(), lfmScrobble: vi.fn()}));
afterEach(() => vi.clearAllMocks());
it('retries failed services without submitting twice to services that succeeded', async () => {
  const db = openDb(':memory:');
  db.exec(`INSERT INTO users(id,username,password_hash) VALUES(1,'tester','unused');
    INSERT INTO artists(id,name) VALUES(1,'Artist');
    INSERT INTO tracks(id,path,title,artist_id,mtime,size) VALUES(1,'/unused','Song',1,0,1);
    INSERT INTO scrobble_accounts(user_id,provider,token,created_at) VALUES(1,'listenbrainz','unused',0),(1,'lastfm','unused',0);`);
  const app = buildApp(db);
  const cookies = {lhm_session:signToken({id:1,username:'tester',isAdmin:false})};
  vi.mocked(sc.lbListen).mockResolvedValue(true);
  vi.mocked(sc.lfmScrobble).mockResolvedValueOnce(false).mockResolvedValue(true);
  const payload = {trackId:1,listenedAt:Date.now()-60000};
  try {
    const send = () => app.inject({method:'POST',url:'/api/scrobble/listen',cookies,payload});
    expect((await send()).statusCode).toBe(502);
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(sc.lbListen).toHaveBeenCalledOnce();
    expect(sc.lfmScrobble).toHaveBeenCalledTimes(2);
  } finally {await app.close();db.close();}
});
