import { test, expect, beforeEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { SessionHub } from "../src/realtime/sessions.js";

// A fake WebSocket that just records the messages sent to it.
function fakeSocket() {
  return { readyState: 1, OPEN: 1, sent: [] as any[], send(m: string) { this.sent.push(JSON.parse(m)); } };
}
const last = (s: any, type: string) => [...s.sent].reverse().find((m: any) => m.type === type);

let hub: SessionHub;
beforeEach(() => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'alice','x',1),(2,'bob','x',0)").run();
  hub = new SessionHub(db, 60); // short host-grace window for tests
});

test("host creates a session and gets a code + roster", () => {
  const host = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  expect(last(host, "session:created").code).toBe(code);
  const roster = last(host, "session:members").members;
  expect(roster).toHaveLength(1);
  expect(roster[0]).toMatchObject({ name: "alice", isHost: true });
});

test("guest joins by code: seeded with state + roster, host sees the new member", () => {
  const host = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  const guest = fakeSocket();
  expect(hub.join(2, "conn-guest", "bob", guest as any, code.toLowerCase())).toBe(true); // case-insensitive

  expect(last(guest, "session:joined")).toMatchObject({ code, host: "alice" });
  expect(last(guest, "session:state")).toBeTruthy(); // seeded playback (empty)
  expect(last(host, "session:members").members).toHaveLength(2);
});

test("only the host's playback state is relayed to guests", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);

  hub.state("conn-host", { track: { id: 42, title: "Song" }, positionMs: 30000, playing: true, shuffle: true, repeat: "all" });
  const relayed = last(guest, "session:state");
  expect(relayed).toMatchObject({ playing: true, positionMs: 30000, shuffle: true, repeat: "all" });
  expect(relayed.track.id).toBe(42);
  expect(typeof relayed.at).toBe("number"); // server-stamped for drift math

  // A guest cannot drive playback.
  const before = guest.sent.length;
  hub.state("conn-guest", { track: { id: 99, title: "Nope" }, positionMs: 0, playing: false });
  expect(guest.sent.length).toBe(before); // nothing relayed
});

test("host leaving ends the session for everyone", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);

  hub.leave("conn-host");
  expect(last(guest, "session:ended")).toBeTruthy();
  // The code is gone, so a new join fails.
  const late = fakeSocket();
  expect(hub.join(2, "conn-late", "bob", late as any, code)).toBe(false);
  expect(last(late, "session:error")).toBeTruthy();
});

test("host disconnect holds the session (grace) and resume reattaches", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);
  hub.state("conn-host", { track: { id: 5, title: "X" }, positionMs: 1000, playing: true });

  hub.disconnect("conn-host");
  expect(last(guest, "session:host-away")).toBeTruthy();
  expect(last(guest, "session:ended")).toBeFalsy(); // not ended during grace

  const host2 = fakeSocket();
  expect(hub.resume("conn-host", host2 as any, code)).toBe(true);
  const reseed = [...guest.sent].reverse().find((m: any) => m.type === "session:state");
  expect(reseed.track.id).toBe(5); // guests re-seeded on resume
});

test("host grace expiring ends the session", async () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);
  hub.disconnect("conn-host");
  await new Promise(r => setTimeout(r, 90)); // > 60ms grace
  expect(last(guest, "session:ended")).toBeTruthy();
});

test("guest disconnect drops them but keeps the session; they can rejoin", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);
  hub.disconnect("conn-guest");
  expect(last(host, "session:members").members).toHaveLength(1);
  const guest2 = fakeSocket();
  expect(hub.join(2, "conn-guest", "bob", guest2 as any, code)).toBe(true);
  expect(last(host, "session:members").members).toHaveLength(2);
});

test("a guest leaving just updates the roster (session stays)", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any);
  hub.join(2, "conn-guest", "bob", guest as any, code);

  hub.leave("conn-guest");
  expect(last(host, "session:members").members).toHaveLength(1);
  // Session still live: host can still push state without error.
  hub.state("conn-host", { track: { id: 7, title: "Still here" }, positionMs: 0, playing: true });
});

test("nightcoreOk drops when a phone joins and returns when it leaves", () => {
  const host = fakeSocket(), phone = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any, true); // desktop host
  // Solo desktop host: nightcore allowed.
  expect(last(host, "session:members").nightcoreOk).toBe(true);

  // A phone (canNightcore=false) joins: the whole room, host included, drops.
  hub.join(2, "conn-phone", "bob", phone as any, code, false);
  expect(last(host, "session:members").nightcoreOk).toBe(false);
  expect(last(phone, "session:members").nightcoreOk).toBe(false);

  // Phone leaves: the flag comes back, so the host's nightcore can re-engage.
  hub.leave("conn-phone");
  expect(last(host, "session:members").nightcoreOk).toBe(true);
});

test("nightcoreOk stays true when only nightcore-capable devices are present", () => {
  const host = fakeSocket(), guest = fakeSocket();
  const code = hub.create(1, "conn-host", "alice", host as any, true);
  hub.join(2, "conn-guest", "bob", guest as any, code, true); // another desktop
  expect(last(host, "session:members").nightcoreOk).toBe(true);
});
