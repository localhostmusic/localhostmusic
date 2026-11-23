import type { WebSocket } from "ws";
import type { ConnTrack } from "./connect.js";
import { appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

// Session lifecycle log (shares connect.log, prefixed SESSION), rotated at ~1MB.
const SLOG = join(config.dataDir, "connect.log");
const short = (id?: string) => (id ? id.slice(0, 8) : "none");
function slog(msg: string) {
  try {
    try { if (statSync(SLOG).size > 1_000_000) renameSync(SLOG, SLOG + ".1"); } catch { /* fresh */ }
    appendFileSync(SLOG, `${new Date().toISOString()} SESSION ${msg}\n`);
  } catch { /* diagnostics must never break the hub */ }
}

// Sessions: listening together across users. A host shares a code, guests
// join and mirror the host's playback. The host is the source of truth; the server
// relays its playback state and keeps the roster. Host-controlled (no guest skip/add).
// A member is keyed by connection id + display name, not by user account.

interface Member { connId: string; userId: number; name: string; socket: WebSocket; canNightcore: boolean; }
interface Playback { track: ConnTrack | null; positionMs: number; playing: boolean; shuffle: boolean; repeat: string; rate: number; at: number; }
interface Session {
  code: string;
  hostUserId: number;
  hostConnId: string;
  members: Map<string, Member>; // by connId
  playback: Playback;
  createdAt: number;
}

// Unambiguous alphabet (no 0/O/1/I) for a friendly, speakable code.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export class SessionHub {
  private sessions = new Map<string, Session>();
  private byConn = new Map<string, string>(); // connId -> session code (a connection is in at most one session)
  private hostGrace = new Map<string, ReturnType<typeof setTimeout>>(); // code -> end-timer while host is away

  // graceMs: how long a session survives a host disconnect before it ends.
  // `presence` (optional) is nudged when session membership changes.
  constructor(private db: import("better-sqlite3").Database, private graceMs = 45000, private presence?: { refresh(): void }) {}

  // The code of a session this user is hosting, if any.
  hostedCode(userId: number): string | null {
    for (const s of this.sessions.values()) if (s.hostUserId === userId) return s.code;
    return null;
  }

  // Session status for the presence roster: is this user hosting or in a session?
  presenceFor(userId: number): { inSession: boolean; isHost: boolean } {
    let inSession = false, isHost = false;
    for (const s of this.sessions.values()) {
      if (s.hostUserId === userId) { isHost = true; inSession = true; }
      else { for (const m of s.members.values()) if (m.userId === userId) { inSession = true; break; } }
    }
    return { inSession, isHost };
  }

  private send(socket: WebSocket, msg: unknown) {
    try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); } catch { /* gone */ }
  }
  private username(userId: number): string {
    const r = this.db.prepare("SELECT username FROM users WHERE id=?").get(userId) as any;
    return r?.username ?? "Listener";
  }
  private roster(s: Session) {
    return [...s.members.values()]
      .map(m => ({ name: m.name, isHost: m.connId === s.hostConnId }))
      .sort((a, b) => (a.isHost === b.isHost ? a.name.localeCompare(b.name) : a.isHost ? -1 : 1));
  }
  // Roster message plus `nightcoreOk`: true only when every member can run nightcore.
  // One member that can't (a phone) drops the whole session to normal speed.
  private membersMsg(s: Session) {
    const nightcoreOk = [...s.members.values()].every(m => m.canNightcore);
    return { type: "session:members", members: this.roster(s), nightcoreOk };
  }
  private broadcast(s: Session, msg: unknown, exceptConnId?: string) {
    for (const m of s.members.values()) if (m.connId !== exceptConnId) this.send(m.socket, msg);
  }

  // Host opens a session and gets a fresh code.
  create(userId: number, connId: string, name: string, socket: WebSocket, canNightcore = true): string {
    this.leave(connId); // one session per connection
    let code = genCode();
    while (this.sessions.has(code)) code = genCode();
    const s: Session = {
      code, hostUserId: userId, hostConnId: connId, members: new Map(),
      playback: { track: null, positionMs: 0, playing: false, shuffle: false, repeat: "off", rate: 1, at: Date.now() }, createdAt: Date.now(),
    };
    s.members.set(connId, { connId, userId, name: name || this.username(userId), socket, canNightcore });
    this.sessions.set(code, s);
    this.byConn.set(connId, code);
    slog(`create ${code} host=u${userId}/${short(connId)}`);
    this.send(socket, { type: "session:created", code });
    this.send(socket, this.membersMsg(s));
    this.presence?.refresh();
    return code;
  }

  // Guest joins by code; seeded with the current playback + roster.
  join(userId: number, connId: string, name: string, socket: WebSocket, rawCode: string, canNightcore = true): boolean {
    const code = String(rawCode || "").trim().toUpperCase();
    const s = this.sessions.get(code);
    if (!s) {
      slog(`join ${code || "(empty)"} u${userId}/${short(connId)} FAIL not-found (live=${[...this.sessions.keys()].join(",") || "none"})`);
      this.send(socket, { type: "session:error", error: "Session not found. Check the code. It may have ended." });
      return false;
    }
    this.leave(connId);
    slog(`join ${code} u${userId}/${short(connId)} ok (members=${s.members.size + 1})`);
    s.members.set(connId, { connId, userId, name: name || this.username(userId), socket, canNightcore });
    this.byConn.set(connId, code);
    this.send(socket, { type: "session:joined", code, host: this.username(s.hostUserId) });
    this.send(socket, { type: "session:state", ...s.playback });
    this.broadcast(s, this.membersMsg(s));
    this.presence?.refresh();
    return true;
  }

  // Explicit leave (user tapped End/Leave): a host ends the session immediately.
  leave(connId: string) { this.remove(connId, true); }
  // Socket dropped: a host gets a grace window to reconnect before the session ends.
  disconnect(connId: string) { this.remove(connId, false); }

  private remove(connId: string, immediate: boolean) {
    const code = this.byConn.get(connId);
    if (!code) return;
    const s = this.sessions.get(code);
    if (!s) { this.byConn.delete(connId); return; }
    const wasHost = s.hostConnId === connId;

    // Host dropped without leaving: keep the session for the grace window and tell
    // guests the host is away. resume() reattaches it.
    if (wasHost && !immediate) {
      slog(`host-away ${code} ${short(connId)} grace=${this.graceMs}ms`);
      this.broadcast(s, { type: "session:host-away" }, connId);
      const prev = this.hostGrace.get(code);
      if (prev) clearTimeout(prev);
      this.hostGrace.set(code, setTimeout(() => this.end(code), this.graceMs));
      this.presence?.refresh();
      return; // keep the host member + byConn so resume can find it
    }

    this.byConn.delete(connId);
    s.members.delete(connId);
    slog(`leave ${code} ${short(connId)} host=${wasHost} remaining=${s.members.size}`);
    if (wasHost || s.members.size === 0) this.end(code);
    else this.broadcast(s, this.membersMsg(s));
    this.presence?.refresh();
  }

  private end(code: string) {
    const s = this.sessions.get(code);
    if (!s) return;
    const t = this.hostGrace.get(code);
    if (t) { clearTimeout(t); this.hostGrace.delete(code); }
    slog(`end ${code}`);
    this.broadcast(s, { type: "session:ended" });
    for (const m of s.members.values()) this.byConn.delete(m.connId);
    this.sessions.delete(code);
    this.presence?.refresh();
  }

  // Host reconnecting: reattach its new socket and cancel the grace timer.
  // Matched by connId.
  resume(connId: string, socket: WebSocket, rawCode: string): boolean {
    const code = String(rawCode || "").trim().toUpperCase();
    const s = this.sessions.get(code);
    if (!s || s.hostConnId !== connId) {
      this.send(socket, { type: "session:error", error: "Session ended." });
      return false;
    }
    const t = this.hostGrace.get(code);
    if (t) { clearTimeout(t); this.hostGrace.delete(code); }
    const m = s.members.get(connId);
    if (m) m.socket = socket;
    this.byConn.set(connId, code);
    slog(`resume ${code} host=${short(connId)}`);
    this.send(socket, { type: "session:created", code }); // re-affirm host UI/role
    this.broadcast(s, this.membersMsg(s));
    this.broadcast(s, { type: "session:state", ...s.playback }); // re-seed guests (clears host-away)
    return true;
  }

  // Host pushes playback state; the server stamps it and relays to guests.
  state(connId: string, playback: { track: ConnTrack | null; positionMs: number; playing: boolean; shuffle?: boolean; repeat?: string; rate?: number }) {
    const code = this.byConn.get(connId);
    if (!code) return;
    const s = this.sessions.get(code);
    if (!s || s.hostConnId !== connId) return; // only the host drives playback
    const rate = Number(playback.rate);
    s.playback = {
      track: playback.track ?? null,
      positionMs: Math.max(0, playback.positionMs || 0),
      playing: !!playback.playing,
      shuffle: !!playback.shuffle,
      repeat: ["off", "all", "one"].includes(playback.repeat as string) ? playback.repeat as string : "off",
      // Playback rate: guests project the host's position with it and match it.
      rate: Number.isFinite(rate) && rate > 0 && rate <= 4 ? rate : 1,
      at: Date.now(),
    };
    this.broadcast(s, { type: "session:state", ...s.playback }, connId);
  }
}
