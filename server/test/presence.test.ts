import { test, expect, beforeEach, vi } from "vitest";
import { openDb } from "../src/db/index.js";
import { PresenceHub } from "../src/realtime/presence.js";

// A fake WebSocket that just records the messages sent to it.
function fakeSocket() {
  return { readyState: 1, OPEN: 1, sent: [] as any[], send(m: string) { this.sent.push(JSON.parse(m)); } };
}
const last = (s: any, type: string) => [...s.sent].reverse().find((m: any) => m.type === type);

// Minimal stubs standing in for ConnectHub / SessionHub. Presence only reads
// nowPlaying() + presenceFor() from them.
function stubs() {
  const nowPlaying = new Map<number, any>();
  const sessionInfo = new Map<number, { inSession: boolean; isHost: boolean }>();
  const hosted = new Map<number, string>(); // userId -> session code they host
  const calls = { created: null as null | { userId: number; connId: string } };
  const hub = { nowPlaying: (u: number) => nowPlaying.get(u) ?? { track: null, playing: false } };
  const sessions = {
    presenceFor: (u: number) => sessionInfo.get(u) ?? { inSession: false, isHost: false },
    hostedCode: (u: number) => hosted.get(u) ?? null,
    create: (userId: number, connId: string) => { calls.created = { userId, connId }; const code = "NEW999"; hosted.set(userId, code); return code; },
  };
  return { hub, sessions, nowPlaying, sessionInfo, hosted, calls };
}

let presence: PresenceHub;
let s: ReturnType<typeof stubs>;
beforeEach(() => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'alice','x',1),(2,'bob','x',0)").run();
  presence = new PresenceHub(db);
  s = stubs();
  presence.attach(s.hub as any, s.sessions as any);
});

test("a user never sees themselves; each sees the other", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);

  const aliceList = last(alice, "presence:list").users;
  const bobList = last(bob, "presence:list").users;
  expect(aliceList.map((u: any) => u.userId)).toEqual([2]); // alice sees only bob
  expect(bobList.map((u: any) => u.userId)).toEqual([1]);   // bob sees only alice
});

test("now-playing + hosting status flow into the roster", () => {
  s.nowPlaying.set(1, { track: { id: 7, title: "Wait", artist: "The Dear Hunter" }, playing: true });
  s.sessionInfo.set(1, { inSession: true, isHost: true });
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);

  const seenByBob = last(bob, "presence:list").users[0];
  expect(seenByBob).toMatchObject({ name: "alice", playing: true, isHost: true, inSession: true });
  expect(seenByBob.track).toMatchObject({ id: 7, title: "Wait", artist: "The Dear Hunter" });
});

test("refresh de-dupes: no re-broadcast when nothing visible changed", () => {
  vi.useFakeTimers();
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);
  const before = bob.sent.length;

  // A position tick nudges refresh() but the track/playing signature is unchanged.
  presence.refresh();
  vi.advanceTimersByTime(1100);
  expect(bob.sent.length).toBe(before); // suppressed

  // A real change (alice starts a track) does broadcast.
  s.nowPlaying.set(1, { track: { id: 9, title: "New" }, playing: true });
  presence.refresh();
  vi.advanceTimersByTime(1100);
  expect(bob.sent.length).toBe(before + 1);
  vi.useRealTimers();
});

test("ask-to-join an existing host reuses the code; no new session created", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any); // alice already hosting
  presence.join(2, "b1", "bob", bob as any);
  s.hosted.set(1, "ABC123");

  presence.requestJoin(2, 1); // bob -> alice
  expect(last(alice, "presence:join-request")).toMatchObject({ fromUserId: 2, fromName: "bob" });

  presence.respondJoin(1, "a1", alice as any, 2, true); // alice accepts on device a1
  expect(s.calls.created).toBeNull(); // she already had a session
  expect(last(bob, "presence:join-approved")).toMatchObject({ code: "ABC123", host: "alice" });
});

test("ask-to-join a non-host still forwards; accepting auto-starts a session", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any); // alice not hosting
  presence.join(2, "b1", "bob", bob as any);

  presence.requestJoin(2, 1);
  expect(last(alice, "presence:join-request")).toMatchObject({ fromUserId: 2, fromName: "bob" }); // forwarded anyway
  expect(last(bob, "presence:error")).toBeFalsy();

  presence.respondJoin(1, "a1", alice as any, 2, true); // alice accepts, session created on a1
  expect(s.calls.created).toEqual({ userId: 1, connId: "a1" });
  expect(last(bob, "presence:join-approved")).toMatchObject({ code: "NEW999", host: "alice" });
});

test("request to an offline user errors back; decline notifies the requester", () => {
  const bob = fakeSocket();
  presence.join(2, "b1", "bob", bob as any);

  presence.requestJoin(2, 99); // nobody with id 99 online
  expect(last(bob, "presence:error")).toBeTruthy();

  const alice = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.respondJoin(1, "a1", alice as any, 2, false); // alice declines
  expect(last(bob, "presence:join-declined")).toMatchObject({ fromName: "alice" });
  expect(last(bob, "presence:join-approved")).toBeFalsy();
});

test("invite requires the inviter to host; delivers the code to the target", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);

  presence.invite(1, 2); // alice isn't hosting yet
  expect(last(alice, "presence:error")).toBeTruthy();
  expect(last(bob, "presence:invite")).toBeFalsy();

  s.hosted.set(1, "XYZ789");
  presence.invite(1, 2);
  expect(last(bob, "presence:invite")).toMatchObject({ fromUserId: 1, fromName: "alice", code: "XYZ789" });
});

test("invisible users are hidden from others but still see everyone", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);
  expect(last(alice, "presence:self")).toMatchObject({ sharing: true }); // seeded on connect
  expect(last(bob, "presence:list").users.map((u: any) => u.userId)).toEqual([1]);

  presence.setSharing(1, false); // alice goes invisible
  expect(last(alice, "presence:self")).toMatchObject({ sharing: false });
  expect(last(bob, "presence:list").users).toHaveLength(0);              // bob no longer sees alice
  expect(last(alice, "presence:list").users.map((u: any) => u.userId)).toEqual([2]); // alice still sees bob

  presence.setSharing(1, true); // back to visible
  expect(last(bob, "presence:list").users.map((u: any) => u.userId)).toEqual([1]);
});

test("a user goes offline only when their last device leaves", () => {
  const alice = fakeSocket(), bob = fakeSocket();
  presence.join(1, "a1", "alice", alice as any);
  presence.join(2, "b1", "bob", bob as any);
  presence.join(2, "b2", "bob", bob as any); // bob's second device

  presence.leave(2, "b1"); // one device gone, bob still online
  expect(last(alice, "presence:list").users.map((u: any) => u.userId)).toEqual([2]);

  presence.leave(2, "b2"); // last device gone, bob offline
  expect(last(alice, "presence:list").users).toHaveLength(0);
});
