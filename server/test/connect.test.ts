import { describe, it, expect, beforeEach } from "vitest";
import { ConnectHub, type SessionState } from "../src/realtime/connect.js";

// The hub only touches the DB to load/persist a session blob. A no-op stub keeps
// these tests to the connection bookkeeping.
const stubDb = { prepare: () => ({ get: () => undefined, run: () => {} }) } as any;

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  closedWith: number | null = null;
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close(code: number) { this.closedWith = code; this.readyState = 3; }
  msgs(type: string) { return this.sent.filter(m => m.type === type); }
  lastState(): SessionState | undefined { return this.msgs("state").at(-1)?.state; }
}

const U = 1;
const TRACKS = [{ id: 10, title: "A" }, { id: 11, title: "B" }];
const playNow = (hub: ConnectHub, from: string) =>
  hub.command(U, from, { action: "playNow", claim: true, queue: TRACKS, order: [0, 1], pos: 0 });

// Read the session as a neutral third party: connect an observer and take the
// `state` the hub seeds it with.
function readState(hub: ConnectHub, n = "obs"): SessionState {
  const s = new FakeSocket();
  hub.connect(U, n, "observer-browser", "Observer", s as any);
  const st = s.lastState()!;
  hub.disconnect(U, n, s as any);
  return st;
}

describe("ConnectHub connection bookkeeping", () => {
  let hub: ConnectHub;
  beforeEach(() => { hub = new ConnectHub(stubDb); });

  it("ignores a stale socket's close after the same tab reconnected", () => {
    const oldSock = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", oldSock as any);
    playNow(hub, "conn-1");
    expect(readState(hub).activeDeviceId).toBe("conn-1");

    // Tab reloads: a new socket registers under the same per-tab connId.
    const newSock = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", newSock as any);
    expect(oldSock.closedWith).toBe(4409); // superseded, told to take a fresh id

    // The dead socket's close arrives only now. It must not drop the live connection.
    hub.disconnect(U, "conn-1", oldSock as any);

    const st = readState(hub);
    expect(st.activeDeviceId).toBe("conn-1");
    expect(st.isPlaying).toBe(true);
  });

  it("closing one tab does not evict another tab of the same browser", () => {
    const tab1 = new FakeSocket();
    const tab2 = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", tab1 as any);
    hub.connect(U, "conn-2", "browser-A", "Chrome", tab2 as any);
    playNow(hub, "conn-1"); // tab1 is producing audio

    hub.disconnect(U, "conn-2", tab2 as any); // user closes the idle tab

    const st = readState(hub);
    expect(st.activeDeviceId).toBe("conn-1");
    expect(st.isPlaying).toBe(true);
  });

  it("collapses a browser's tabs into one roster entry, preferring the active one", () => {
    const tab1 = new FakeSocket();
    const tab2 = new FakeSocket();
    const phone = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", tab1 as any);
    hub.connect(U, "conn-2", "browser-A", "Chrome", tab2 as any);
    hub.connect(U, "conn-3", "browser-B", "iPhone", phone as any);
    playNow(hub, "conn-1");

    const roster = phone.msgs("devices").at(-1)!.devices;
    expect(roster).toHaveLength(2); // not 3: the two Chrome tabs are one device
    expect(roster.find((d: any) => d.name === "Chrome").id).toBe("conn-1"); // the audio producer
    expect(roster.find((d: any) => d.name === "Chrome").isActive).toBe(true);
  });

  it("routes a remote's apply-load to the tab producing audio, not its sibling", () => {
    // Tab 1 is playing. Tab 2 was opened afterwards.
    const tab1 = new FakeSocket();
    const tab2 = new FakeSocket();
    const phone = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", tab1 as any);
    hub.connect(U, "conn-2", "browser-A", "Chrome", tab2 as any);
    hub.connect(U, "conn-3", "browser-B", "iPhone", phone as any);
    playNow(hub, "conn-1");
    tab1.sent.length = 0; tab2.sent.length = 0;

    // The phone hits "next". The load must reach the tab that owns the speakers.
    hub.command(U, "conn-3", { action: "next" });

    expect(tab1.msgs("apply").map(m => m.action)).toEqual(["load"]);
    expect(tab2.msgs("apply")).toEqual([]); // no song starts here
  });

  it("still clears the active device when the real connection closes", () => {
    const sock = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", sock as any);
    playNow(hub, "conn-1");

    hub.disconnect(U, "conn-1", sock as any);

    const st = readState(hub);
    expect(st.activeDeviceId).toBeNull();
    expect(st.isPlaying).toBe(false);
  });
});

// A device that drives its own <audio> element sends `local: true`; a casting
// controller relaying to the speakers sends `local: false`. The server must never
// hand an audio directive to a device that isn't making sound.
describe("ConnectHub local-vs-remote commands", () => {
  let hub: ConnectHub;
  let desktop: FakeSocket;
  let phone: FakeSocket;

  // Drift: the phone holds the session, but the desktop is the one actually playing.
  beforeEach(() => {
    hub = new ConnectHub(stubDb);
    desktop = new FakeSocket();
    phone = new FakeSocket();
    hub.connect(U, "desk", "browser-A", "Chrome", desktop as any);
    hub.connect(U, "fone", "browser-B", "iPhone", phone as any);
    playNow(hub, "fone"); // server believes the phone is active
    desktop.sent.length = 0; phone.sent.length = 0;
  });

  const applyActions = (s: FakeSocket) => s.msgs("apply").map(m => m.action);

  it("a local `ended` claims instead of starting a song on the other device", () => {
    hub.command(U, "desk", { action: "ended", local: true });

    expect(applyActions(phone)).toEqual(["stop"]);   // not ["load"], which would start a second song
    expect(applyActions(desktop)).toEqual([]);        // it advanced its own audio already
    expect(readState(hub).activeDeviceId).toBe("desk");
  });

  it("a local seek moves only the sender's playhead", () => {
    hub.command(U, "desk", { action: "seek", position: 42, local: true });

    expect(applyActions(phone)).toEqual(["stop"]);
    expect(applyActions(phone)).not.toContain("seek");
    expect(readState(hub).activeDeviceId).toBe("desk");
  });

  it("REMOTE control still works: a controller's play relays to the active device", () => {
    hub.command(U, "desk", { action: "play", local: false }); // desktop is casting

    expect(applyActions(phone)).toEqual(["play"]); // the phone plays, as Spotify does
    expect(readState(hub).activeDeviceId).toBe("fone"); // and keeps the session
  });

  it("REMOTE control still works: a controller's next loads on the active device", () => {
    hub.command(U, "desk", { action: "next", local: false });

    expect(applyActions(phone)).toEqual(["load"]);
    expect(readState(hub).activeDeviceId).toBe("fone");
  });

  it("non-transport commands never steal the session", () => {
    hub.command(U, "desk", { action: "setVolume", volume: 0.5, local: true });

    expect(readState(hub).activeDeviceId).toBe("fone"); // volume says nothing about who plays
    expect(applyActions(phone)).not.toContain("stop");
  });

  it("a bundle too old to send `local` keeps the previous behaviour", () => {
    hub.command(U, "desk", { action: "play" }); // no `local` field

    expect(applyActions(phone)).toEqual(["play"]);
    expect(readState(hub).activeDeviceId).toBe("fone");
  });

  it("claims from a device with no live connection are ignored", () => {
    hub.command(U, "ghost", { action: "play", local: true });

    expect(readState(hub).activeDeviceId).toBe("fone");
  });
});

describe("ConnectHub (regression guard)", () => {
  let hub: ConnectHub;
  beforeEach(() => { hub = new ConnectHub(stubDb); });

  it("the active device sending a local command is a no-op claim", () => {
    const sock = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", sock as any);
    playNow(hub, "conn-1");
    sock.sent.length = 0;

    hub.command(U, "conn-1", { action: "ended", local: true });

    // It must never `apply stop` itself, and it advances its own audio (no load).
    expect(sock.msgs("apply")).toEqual([]);
    expect(readState(hub).activeDeviceId).toBe("conn-1");
  });

  it("still clears the active device when the real connection closes", () => {
    const sock = new FakeSocket();
    hub.connect(U, "conn-1", "browser-A", "Chrome", sock as any);
    playNow(hub, "conn-1");

    hub.disconnect(U, "conn-1", sock as any);

    const st = readState(hub);
    expect(st.activeDeviceId).toBeNull();
    expect(st.isPlaying).toBe(false);
  });
});
