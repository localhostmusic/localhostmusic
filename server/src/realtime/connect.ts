import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { authenticate } from "../lib/auth.js";
import { config } from "../config.js";
import { SessionHub } from "./sessions.js";
import { PresenceHub } from "./presence.js";

// Connect diagnostics: one line per session event (hello/bye/transfer/command)
// in DATA_DIR/connect.log, rotated at ~1MB.
const CONNECT_LOG = join(config.dataDir, "connect.log");
function clog(userId: number, msg: string) {
  try {
    try { if (statSync(CONNECT_LOG).size > 1_000_000) renameSync(CONNECT_LOG, CONNECT_LOG + ".1"); } catch { /* fresh file */ }
    appendFileSync(CONNECT_LOG, `${new Date().toISOString()} u${userId} ${msg}\n`);
  } catch { /* diagnostics must never break the hub */ }
}
const short = (id?: string | null) => (id ? id.slice(0, 8) : "none");

// Connect: shared playback session across a user's devices.
// The server owns session state. Exactly one device is `active` (the only one
// producing audio). Every device renders from the broadcast `state`; the active
// one also executes `apply` directives and reports its playhead back.

export interface ConnTrack {
  id: number;
  title: string;
  duration?: number;
  albumId?: number;
  album?: string;
  artist?: string;
}

export type RepeatMode = "off" | "all" | "one";

export interface SessionState {
  activeDeviceId: string | null;
  queue: ConnTrack[];
  order: number[];      // play order: indices into queue
  pos: number;          // position within order
  isPlaying: boolean;
  position: number;     // last reported playhead, seconds
  positionAt: number;   // Date.now() when `position` was captured
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  updatedAt: number;
}

// One live WebSocket. `id` is the per-tab connection id (what `activeDeviceId`
// holds); `deviceId` is per-browser, shared by its tabs, used only to dedupe the roster.
interface Device {
  id: string;
  deviceId: string;
  name: string;
  socket: WebSocket;
  lastSeen: number;
}

function emptyState(): SessionState {
  return {
    activeDeviceId: null, queue: [], order: [], pos: 0,
    isPlaying: false, position: 0, positionAt: Date.now(),
    volume: 1, shuffle: false, repeat: "off", updatedAt: Date.now(),
  };
}

// Extrapolate the live playhead from the last report (so remotes show smooth
// progress and handoff resumes at the right spot).
function livePosition(s: SessionState): number {
  if (!s.isPlaying) return s.position;
  return s.position + (Date.now() - s.positionAt) / 1000;
}

export class ConnectHub {
  private sessions = new Map<number, SessionState>();
  private devices = new Map<number, Map<string, Device>>();
  private saveTimers = new Map<number, NodeJS.Timeout>();

  // `presence` (optional) is nudged when a user's playback changes so the
  // server-wide roster reflects what they're listening to.
  constructor(private db: import("better-sqlite3").Database, private presence?: { refresh(): void }) {}

  // Coarse now-playing for the presence roster: current track (if any) and whether
  // it's playing. No position.
  nowPlaying(userId: number): { track: { id: number; title: string; artist?: string; album?: string; albumId?: number } | null; playing: boolean } {
    const s = this.getState(userId);
    const t = s.queue[s.order[s.pos]] ?? null;
    return {
      track: t ? { id: t.id, title: t.title, artist: t.artist, album: t.album, albumId: t.albumId } : null,
      playing: s.isPlaying && !!t,
    };
  }

  private getState(userId: number): SessionState {
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    const row = this.db.prepare("SELECT state FROM player_sessions WHERE user_id=?").get(userId) as any;
    const s: SessionState = row?.state
      ? { ...emptyState(), ...JSON.parse(row.state), activeDeviceId: null }
      : emptyState();
    this.sessions.set(userId, s);
    return s;
  }

  // Persist state (throttled) so a restart or a fresh device can resume.
  // Position-only heartbeats pass a longer delay to avoid re-serializing the queue.
  private persist(userId: number, delay = 1500) {
    if (this.saveTimers.has(userId)) return;
    this.saveTimers.set(userId, setTimeout(() => {
      this.saveTimers.delete(userId);
      const s = this.sessions.get(userId);
      if (!s) return;
      const { activeDeviceId, ...rest } = s; // active device is connection-scoped, don't persist it
      this.db.prepare(
        `INSERT INTO player_sessions(user_id,state,updated_at) VALUES(?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`
      ).run(userId, JSON.stringify({ ...rest, activeDeviceId: null }), Date.now());
    }, delay));
  }

  private deviceMap(userId: number): Map<string, Device> {
    let m = this.devices.get(userId);
    if (!m) { m = new Map(); this.devices.set(userId, m); }
    return m;
  }

  private send(socket: WebSocket, msg: unknown) {
    try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  private broadcast(userId: number, msg: unknown, exceptDeviceId?: string) {
    for (const d of this.deviceMap(userId).values()) {
      if (d.id !== exceptDeviceId) this.send(d.socket, msg);
    }
  }

  // One entry per browser, not per tab (tabs share a `deviceId`). The connection
  // producing audio wins the slot, otherwise the most recently seen one.
  private deviceList(userId: number) {
    const active = this.getState(userId).activeDeviceId;
    const byDevice = new Map<string, Device>();
    for (const d of this.deviceMap(userId).values()) {
      const prev = byDevice.get(d.deviceId);
      if (!prev || d.id === active || (prev.id !== active && d.lastSeen > prev.lastSeen)) byDevice.set(d.deviceId, d);
    }
    return [...byDevice.values()]
      .map(d => ({ id: d.id, name: d.name, isActive: d.id === active }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private stateMsg(userId: number) {
    const s = this.getState(userId);
    return { type: "state", state: { ...s, position: livePosition(s) } };
  }

  private active(userId: number): Device | undefined {
    const id = this.getState(userId).activeDeviceId;
    return id ? this.deviceMap(userId).get(id) : undefined;
  }

  // Tell the active device to load the current track. `except` skips the directive
  // when the active device initiated the command: it already acted locally inside
  // its own user gesture (which iOS requires to start audio).
  private applyLoad(userId: number, play: boolean, except?: string) {
    const s = this.getState(userId);
    const track = s.queue[s.order[s.pos]];
    const dev = this.active(userId);
    // `pos` rides along so the active device moves its own queue cursor too;
    // otherwise its next state push reverts the skip.
    if (dev && track && dev.id !== except) this.send(dev.socket, {
      type: "apply", action: "load", trackId: track.id, position: s.position, play, pos: s.pos,
    });
  }

  private touch(userId: number) {
    this.getState(userId).updatedAt = Date.now();
    this.persist(userId);
    this.broadcast(userId, this.stateMsg(userId));
    this.presence?.refresh();
  }

  // True if `socket` is the connection currently registered under `connId`.
  // Teardown is gated on this (see `disconnect`).
  owns(userId: number, connId: string, socket: WebSocket): boolean {
    return this.deviceMap(userId).get(connId)?.socket === socket;
  }

  connect(userId: number, connId: string, deviceId: string, name: string, socket: WebSocket, clientVersion?: string) {
    const m = this.deviceMap(userId);
    const s = this.getState(userId);
    clog(userId, `hello ${short(connId)} dev=${short(deviceId)} "${name}" v=${clientVersion ?? "?"} active=${short(s.activeDeviceId)} playing=${s.isPlaying} queue=${s.queue.length}`);
    // Same connId, different socket: a duplicated tab (Chrome copies sessionStorage)
    // or a reload whose old socket isn't reaped yet. Close the old one with 4409;
    // it mints a fresh connId and reconnects.
    const prior = m.get(connId);
    if (prior && prior.socket !== socket) {
      clog(userId, `supersede ${short(connId)}, closing prior socket`);
      try { prior.socket.close(4409, "connection id superseded"); } catch { /* already gone */ }
    }
    m.set(connId, { id: connId, deviceId, name, socket, lastSeen: Date.now() });
    // Seed the new device with current state + roster.
    this.send(socket, this.stateMsg(userId));
    this.send(socket, { type: "devices", devices: this.deviceList(userId) });
    this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) }, connId);
  }

  // `socket` identifies which connection closed. A stale socket (superseded, or
  // closed late after the tab reconnected) is ignored so it can't evict the live one.
  disconnect(userId: number, connId: string, socket?: WebSocket) {
    const m = this.deviceMap(userId);
    const cur = m.get(connId);
    if (!cur) return;                                   // already gone (error+close both fire)
    if (socket && cur.socket !== socket) {
      clog(userId, `bye-stale ${short(connId)} (superseded, live connection kept)`);
      return;
    }
    m.delete(connId);
    const s = this.getState(userId);
    clog(userId, `bye ${short(connId)} wasActive=${s.activeDeviceId === connId}`);
    if (s.activeDeviceId === connId) { s.activeDeviceId = null; s.isPlaying = false; }
    this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) });
    this.broadcast(userId, this.stateMsg(userId));
    this.presence?.refresh();
  }

  // The name is per-browser (stored in its localStorage), so every connection
  // sharing the deviceId adopts it.
  rename(userId: number, connId: string, name: string) {
    const m = this.deviceMap(userId);
    const d = m.get(connId);
    if (!d) return;
    const n = name.slice(0, 60) || d.name;
    for (const other of m.values()) if (other.deviceId === d.deviceId) other.name = n;
    this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) });
  }

  // Make a device the active player and resume audio there at the live position.
  // On a pull (sender === target) the target already started audio locally in its
  // tap gesture, so it gets no load. On a push the target gets an apply directive.
  transfer(userId: number, toDeviceId: string, sender?: string, senderTrackId?: number) {
    const s = this.getState(userId);
    const m = this.deviceMap(userId);
    clog(userId, `transfer ${short(s.activeDeviceId)} -> ${short(toDeviceId)} by=${short(sender)} playing=${s.isPlaying} pos=${s.pos}@${s.position.toFixed(1)}s known=${m.has(toDeviceId)}`);
    if (!m.has(toDeviceId)) return;
    const prev = s.activeDeviceId;
    s.position = livePosition(s); s.positionAt = Date.now();
    s.activeDeviceId = toDeviceId;
    if (prev && prev !== toDeviceId) {
      const old = m.get(prev);
      if (old) this.send(old.socket, { type: "apply", action: "stop" });
    }
    // On a pull the device loaded what its mirror said was current, which can lag
    // the session. If it loaded the wrong track, send a corrective load.
    const pull = sender === toDeviceId;
    const actualTrack = s.queue[s.order[s.pos]]?.id;
    const pullStale = pull && senderTrackId != null && actualTrack != null && senderTrackId !== actualTrack;
    if (pullStale) clog(userId, `pull-correct ${short(toDeviceId)} loaded=${senderTrackId} actual=${actualTrack}`);
    this.applyLoad(userId, s.isPlaying, pull && !pullStale ? toDeviceId : undefined);
    this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) });
    this.touch(userId);
  }

  // Active device's playhead heartbeat.
  position(userId: number, fromDeviceId: string, position: number, isPlaying: boolean) {
    const s = this.getState(userId);
    if (s.activeDeviceId !== fromDeviceId) return; // only the active device reports
    s.position = position; s.positionAt = Date.now(); s.isPlaying = isPlaying;
    this.persist(userId, 5000);
    // Lightweight tick to the other devices for smooth progress bars.
    this.broadcast(userId, { type: "position", position, isPlaying, at: Date.now() }, fromDeviceId);
    this.presence?.refresh(); // de-duped: only a play/pause flip or track change re-broadcasts
  }

  // Transport commands. A local one (see `implicitClaim`) means the sender is the
  // audio source. Volume, shuffle, repeat and queue edits say nothing about that.
  private static readonly CLAIMING = new Set(["playNow", "play", "pause", "ended", "next", "prev", "jumpTo", "seek"]);

  // Invariant: a device producing audio that acts on its own transport is the active
  // device. The client flags this with `cmd.local`. A casting controller sends
  // `local: false`, never claims, and its commands are relayed.
  private implicitClaim(userId: number, deviceId: string, action: string) {
    if (!ConnectHub.CLAIMING.has(action)) return;
    const s = this.getState(userId);
    if (s.activeDeviceId === deviceId) return;
    const m = this.deviceMap(userId);
    if (!m.has(deviceId)) return; // not a live connection
    const prev = s.activeDeviceId;
    s.activeDeviceId = deviceId;
    // Position is not rebased here (unlike `transfer`): no audio moves, and the
    // claiming device owns the playhead. Its next report wins.
    if (prev) {
      const old = m.get(prev);
      if (old) this.send(old.socket, { type: "apply", action: "stop" }); // exactly one device makes sound
    }
    clog(userId, `claim ${short(prev)} -> ${short(deviceId)} via local ${action}`);
    this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) });
  }

  command(userId: number, fromDeviceId: string, cmd: any) {
    const s = this.getState(userId);
    const wasActive = s.activeDeviceId;
    // Must run before anything reads `active`. Older bundles omit `local` and never claim.
    if (cmd.local) this.implicitClaim(userId, fromDeviceId, cmd.action);
    const relay = (a: any) => { // send an apply to the active device when the command came from a remote
      const dev = this.active(userId);
      if (dev && dev.id !== fromDeviceId) this.send(dev.socket, a);
    };

    switch (cmd.action) {
      case "playNow": {
        // Start a new queue. `claim` (or nobody active) makes the initiator the
        // active player; it already started audio locally. Without claim it's a
        // remote start: the current active device keeps playing, with the new queue.
        if (!Array.isArray(cmd.queue) || !Array.isArray(cmd.order)) return;
        s.queue = cmd.queue; s.order = cmd.order; s.pos = cmd.pos ?? 0;
        s.shuffle = !!cmd.shuffle; s.repeat = cmd.repeat ?? s.repeat;
        s.position = 0; s.positionAt = Date.now(); s.isPlaying = true;
        if (cmd.claim || !s.activeDeviceId) s.activeDeviceId = fromDeviceId;
        // Remote start: hand the active device the new arrays before the load, or
        // its state pushes revert the queue swap.
        relay({ type: "apply", action: "queue", queue: s.queue, order: s.order, pos: s.pos, shuffle: s.shuffle });
        relay({ type: "apply", action: "mode", repeat: s.repeat });
        // `except` only when the initiator claimed. A claimless sender that became
        // active by default still needs the load.
        this.applyLoad(userId, true, cmd.claim ? fromDeviceId : undefined);
        if (wasActive !== s.activeDeviceId) this.broadcast(userId, { type: "devices", devices: this.deviceList(userId) });
        break;
      }
      case "play":  s.isPlaying = true;  relay({ type: "apply", action: "play" }); break;
      case "pause": s.isPlaying = false; relay({ type: "apply", action: "pause" }); break;
      case "seek":
        s.position = Math.max(0, cmd.position ?? 0); s.positionAt = Date.now();
        relay({ type: "apply", action: "seek", position: s.position }); break;
      case "setVolume":
        s.volume = Math.min(1, Math.max(0, cmd.volume ?? 1));
        relay({ type: "apply", action: "setVolume", volume: s.volume }); break;
      case "shuffle":
        s.shuffle = !!cmd.shuffle;
        if (Array.isArray(cmd.order)) { s.order = cmd.order; s.pos = cmd.pos ?? s.pos; }
        // The active device must adopt the new order/flag, or its next state push reverts it.
        relay({ type: "apply", action: "queue", order: s.order, pos: s.pos, shuffle: s.shuffle });
        break;
      case "repeat":
        s.repeat = ["off", "all", "one"].includes(cmd.repeat) ? cmd.repeat : "off";
        relay({ type: "apply", action: "mode", repeat: s.repeat });
        break;
      case "next": this.step(userId, +1, false, fromDeviceId); break;
      case "prev": this.step(userId, -1, false, fromDeviceId); break;
      case "ended": this.step(userId, +1, true, fromDeviceId); break;
      case "jumpTo":
        if (s.order[cmd.pos] == null) return;
        s.pos = cmd.pos; s.position = 0; s.positionAt = Date.now(); s.isPlaying = true;
        this.applyLoad(userId, true, fromDeviceId); break;
      case "queue": // reorder / remove / add: client sends recomputed order + pos
        if (!Array.isArray(cmd.order)) return;
        if (Array.isArray(cmd.queue)) s.queue = cmd.queue; // grew (play-next / add)
        { const curTrack = s.order[s.pos]; s.order = cmd.order;
          const np = typeof cmd.pos === "number" ? cmd.pos : s.order.indexOf(curTrack);
          const trackChanged = np !== s.pos && np >= 0;
          s.pos = Math.max(0, np);
          // Hand the active device the edited arrays (audio untouched) so its
          // state push doesn't revert the edit.
          relay({ type: "apply", action: "queue", queue: s.queue, order: s.order, pos: s.pos });
          // Reload only when the edit changed which track is current.
          if (trackChanged) { s.position = 0; s.positionAt = Date.now(); this.applyLoad(userId, s.isPlaying, fromDeviceId); } }
        break;
      default: return;
    }
    clog(userId, `cmd ${cmd.action} by=${short(fromDeviceId)} -> active=${short(s.activeDeviceId)} playing=${s.isPlaying} pos=${s.pos} queue=${s.queue.length}${cmd.action === "playNow" && cmd.claim ? " CLAIM" : ""}`);
    // Cheap actions get a delta broadcast: the full state message serializes the
    // whole queue, too heavy per slider event. Structural changes send full state.
    if (cmd.action === "setVolume") {
      s.updatedAt = Date.now();
      this.persist(userId);
      this.broadcast(userId, { type: "volume", volume: s.volume }, fromDeviceId);
    } else if (cmd.action === "seek" || cmd.action === "play" || cmd.action === "pause") {
      s.updatedAt = Date.now();
      this.persist(userId);
      this.broadcast(userId, { type: "position", position: livePosition(s), isPlaying: s.isPlaying, at: Date.now() }, fromDeviceId);
    } else {
      this.touch(userId);
    }
    this.presence?.refresh(); // a play/pause/next/etc. may change what others see us playing
  }

  // Advance/retreat within the play order, honoring repeat. `fromEnded` makes
  // repeat-one replay and repeat-off stop at the tail (matches the local player).
  private step(userId: number, dir: 1 | -1, fromEnded = false, except?: string) {
    const s = this.getState(userId);
    if (dir === 1 && fromEnded && s.repeat === "one") {
      s.position = 0; s.positionAt = Date.now(); this.applyLoad(userId, true, except); return;
    }
    let np = s.pos + dir;
    if (np >= s.order.length) {
      if (s.repeat === "all") np = 0;
      else { if (fromEnded) s.isPlaying = false; return; }
    } else if (np < 0) {
      if (s.repeat === "all") np = s.order.length - 1; else return;
    }
    s.pos = np; s.position = 0; s.positionAt = Date.now(); s.isPlaying = true;
    this.applyLoad(userId, true, except);
  }
}

// Parse the session JWT from the upgrade request's Cookie header.
function userFromCookie(db: import("better-sqlite3").Database, cookieHeader?: string): { id: number } | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)lhm_session=([^;]+)/);
  if (!m) return null;
  try { return authenticate(db, decodeURIComponent(m[1])); } catch { return null; }
}

export async function connectRoutes(app: FastifyInstance) {
  const presence = new PresenceHub(app.db);
  const hub = new ConnectHub(app.db, presence);
  const sessions = new SessionHub(app.db, 45000, presence);
  presence.attach(hub, sessions);

  app.get("/api/connect", { websocket: true }, (socket: WebSocket, req) => {
    const user = userFromCookie(app.db, req.headers.cookie);
    if (!user) { try { socket.close(4401, "unauthorized"); } catch { /* */ } return; }
    const userId = user.id;
    let deviceId = ""; // per-tab connection id, the key every hub is registered under

    // Heartbeat: a socket that misses a pong is terminated, which fires `close`
    // and removes the device from the roster.
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const hb = setInterval(() => {
      if (!userFromCookie(app.db, req.headers.cookie)) { socket.close(4401, "session revoked"); return; }
      if (!alive) { try { socket.terminate(); } catch { /* */ } return; }
      alive = false;
      try { socket.ping(); } catch { /* */ }
    }, 30000);

    socket.on("message", (raw: Buffer) => {
      if (!userFromCookie(app.db, req.headers.cookie)) { socket.close(4401, "session revoked"); return; }
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg.type) {
        case "hello": {
          // `connId` is per-tab. Older bundles send only `deviceId`; fall back to it.
          const browserId = String(msg.deviceId || "").slice(0, 64);
          deviceId = String(msg.connId || browserId).slice(0, 64);
          if (!deviceId) { try { socket.close(4400, "no device id"); } catch { /* */ } return; }
          const name = String(msg.name || "Device").slice(0, 60);
          hub.connect(userId, deviceId, browserId || deviceId, name, socket, String(msg.v || "").slice(0, 32) || undefined);
          presence.join(userId, deviceId, name, socket);
          break;
        }
        case "command":  if (deviceId) hub.command(userId, deviceId, msg.cmd ?? msg); break;
        case "transfer": if (deviceId) hub.transfer(userId, String(msg.deviceId || deviceId), deviceId, Number.isFinite(Number(msg.trackId)) ? Number(msg.trackId) : undefined); break;
        case "position": if (deviceId) hub.position(userId, deviceId, Number(msg.position) || 0, !!msg.isPlaying); break;
        case "rename":   if (deviceId) hub.rename(userId, deviceId, String(msg.name || "")); break;
        // Sessions (listen together across users)
        case "session:create": if (deviceId) sessions.create(userId, deviceId, String(msg.name || "").slice(0, 60), socket, msg.canNightcore !== false); break;
        case "session:join":   if (deviceId) sessions.join(userId, deviceId, String(msg.name || "").slice(0, 60), socket, String(msg.code || ""), msg.canNightcore !== false); break;
        case "session:leave":  if (deviceId) sessions.leave(deviceId); break;
        case "session:resume": if (deviceId) sessions.resume(deviceId, socket, String(msg.code || "")); break;
        case "session:state":  if (deviceId) sessions.state(deviceId, { track: msg.track ?? null, positionMs: Number(msg.positionMs) || 0, playing: !!msg.playing, shuffle: !!msg.shuffle, repeat: String(msg.repeat || "off"), rate: Number(msg.rate) || 1 }); break;
        // Presence ask-to-join / invite
        case "presence:request-join": if (deviceId) presence.requestJoin(userId, Number(msg.targetUserId)); break;
        case "presence:respond-join": if (deviceId) presence.respondJoin(userId, deviceId, socket, Number(msg.toUserId), !!msg.accept); break;
        case "presence:invite":       if (deviceId) presence.invite(userId, Number(msg.targetUserId)); break;
        case "presence:set-sharing":  if (deviceId) presence.setSharing(userId, !!msg.sharing); break;
      }
    });

    // Tear down only if this socket still owns the slot. A superseded socket closes
    // later and must leave the live connection alone.
    const teardown = () => {
      clearInterval(hb);
      if (!deviceId) return;
      if (!hub.owns(userId, deviceId, socket)) { hub.disconnect(userId, deviceId, socket); return; } // logs bye-stale, changes nothing
      hub.disconnect(userId, deviceId, socket);
      sessions.disconnect(deviceId);
      presence.leave(userId, deviceId);
    };
    socket.on("close", teardown);
    socket.on("error", teardown);
  });
}
