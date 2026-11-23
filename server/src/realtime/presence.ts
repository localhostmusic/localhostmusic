import type { WebSocket } from "ws";
import type { ConnectHub } from "./connect.js";
import type { SessionHub } from "./sessions.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

// Shares connect.log (prefixed PRESENCE) for diagnosing roster staleness.
const PLOG = join(config.dataDir, "connect.log");
function plog(msg: string) {
  try { appendFileSync(PLOG, `${new Date().toISOString()} PRESENCE ${msg}\n`); } catch { /* diagnostics never break the hub */ }
}

// Presence: server-wide "who's online and what they're listening to", across all
// users. Owns no playback state: reads now-playing from ConnectHub and session
// status from SessionHub, and broadcasts a coarse roster (no position stream).

interface OnlineUser { userId: number; name: string; conns: Map<string, WebSocket>; share: boolean; }

export interface PresenceEntry {
  userId: number;
  name: string;
  playing: boolean;
  track: { id: number; title: string; artist?: string; album?: string; albumId?: number } | null;
  inSession: boolean;
  isHost: boolean;
}

export class PresenceHub {
  private online = new Map<number, OnlineUser>();
  private hub?: ConnectHub;
  private sessions?: SessionHub;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSig = "";

  constructor(private db: import("better-sqlite3").Database) {}

  // Wired after all three hubs exist (they reference one another).
  attach(hub: ConnectHub, sessions: SessionHub) { this.hub = hub; this.sessions = sessions; }

  private username(userId: number): string {
    const r = this.db.prepare("SELECT username FROM users WHERE id=?").get(userId) as any;
    return r?.username ?? "Listener";
  }
  private loadShare(userId: number): boolean {
    const r = this.db.prepare("SELECT share_activity FROM users WHERE id=?").get(userId) as any;
    return r?.share_activity !== 0; // default (and any legacy NULL) = share
  }
  private send(socket: WebSocket, msg: unknown) {
    try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  // A device connected. A user is online while they have at least one connected
  // device. Presence is per-user, so the label is the username, not the device name.
  join(userId: number, connId: string, _deviceName: string, socket: WebSocket) {
    let u = this.online.get(userId);
    if (!u) { u = { userId, name: this.username(userId), conns: new Map(), share: this.loadShare(userId) }; this.online.set(userId, u); }
    u.conns.set(connId, socket);
    this.send(socket, { type: "presence:self", sharing: u.share }); // seed the toggle state
    this.flush(true); // roster grew, send immediately
  }

  // Toggle whether this user is visible to others (persisted). Invisible users are
  // hidden from everyone else's roster but still see everyone.
  setSharing(userId: number, share: boolean) {
    this.db.prepare("UPDATE users SET share_activity=? WHERE id=?").run(share ? 1 : 0, userId);
    const u = this.online.get(userId);
    if (u) u.share = share;
    plog(`set-sharing u${userId} share=${share}`);
    this.sendToUser(userId, { type: "presence:self", sharing: share });
    this.flush(true); // visibility changed, rebroadcast now
  }

  leave(userId: number, connId: string) {
    const u = this.online.get(userId);
    if (!u) return;
    u.conns.delete(connId);
    if (u.conns.size === 0) this.online.delete(userId);
    this.flush(true);
  }

  // A user's playback or session status changed. Throttled and de-duped, so
  // position heartbeats that don't change the visible roster cost nothing.
  refresh() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(false); }, 1000);
  }

  private entryFor(u: OnlineUser): PresenceEntry {
    const np = this.hub?.nowPlaying(u.userId);
    const sess = this.sessions?.presenceFor(u.userId) ?? { inSession: false, isHost: false };
    return {
      userId: u.userId, name: u.name,
      playing: np?.playing ?? false,
      track: np?.track ?? null,
      inSession: sess.inSession, isHost: sess.isHost,
    };
  }

  private sendToUser(userId: number, msg: unknown) {
    const u = this.online.get(userId);
    if (!u) return false;
    for (const socket of u.conns.values()) this.send(socket, msg);
    return true;
  }

  // A user asks to listen together. Forwarded whether or not the target hosts a
  // session; respondJoin starts one on accept. Fails only if the target is offline.
  requestJoin(fromUserId: number, targetUserId: number) {
    plog(`request-join u${fromUserId} -> u${targetUserId}`);
    if (!this.sendToUser(targetUserId, { type: "presence:join-request", fromUserId, fromName: this.username(fromUserId) }))
      this.sendToUser(fromUserId, { type: "presence:error", error: "They just went offline." });
  }

  // The target accepts or declines. On accept, start a session on the accepting
  // device if they aren't hosting yet, then hand the requester the code.
  respondJoin(hostUserId: number, hostConnId: string, hostSocket: WebSocket, requesterUserId: number, accept: boolean) {
    if (!accept) { this.sendToUser(requesterUserId, { type: "presence:join-declined", fromName: this.username(hostUserId) }); return; }
    let code = this.sessions?.hostedCode(hostUserId) ?? null;
    if (!code) code = this.sessions?.create(hostUserId, hostConnId, this.username(hostUserId), hostSocket) ?? null;
    if (!code) { this.sendToUser(requesterUserId, { type: "presence:error", error: "Couldn't start the session." }); return; }
    plog(`respond-join u${hostUserId} accept u${requesterUserId} (${code})`);
    this.sendToUser(requesterUserId, { type: "presence:join-approved", code, host: this.username(hostUserId) });
  }

  // A host invites an online user; the invitee gets the code and can accept.
  invite(fromUserId: number, targetUserId: number) {
    const code = this.sessions?.hostedCode(fromUserId);
    if (!code) { this.sendToUser(fromUserId, { type: "presence:error", error: "Start a session before inviting someone." }); return; }
    plog(`invite u${fromUserId} -> u${targetUserId} (${code})`);
    if (!this.sendToUser(targetUserId, { type: "presence:invite", fromUserId, fromName: this.username(fromUserId), code }))
      this.sendToUser(fromUserId, { type: "presence:error", error: "They just went offline." });
  }

  private flush(force: boolean) {
    const users = [...this.online.values()];
    // Invisible users still receive the roster but never appear in it.
    const visible = users.filter(u => u.share).map(u => this.entryFor(u));
    // Skip the broadcast when nothing a viewer would see changed.
    const sig = visible.map(e => `${e.userId}:${e.track?.id ?? 0}:${e.playing ? 1 : 0}:${e.inSession ? 1 : 0}:${e.isHost ? 1 : 0}`).join("|");
    if (!force && sig === this.lastSig) return; // nothing visible changed (e.g. a position tick)
    this.lastSig = sig;
    plog(`broadcast sig=${sig} online=${users.length} visible=${visible.length}`);
    for (const u of users) {
      const list = visible.filter(e => e.userId !== u.userId); // a user never sees themselves
      for (const socket of u.conns.values()) this.send(socket, { type: "presence:list", users: list });
    }
  }
}
