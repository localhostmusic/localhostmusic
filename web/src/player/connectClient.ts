// WebSocket client for Connect: hello handshake, reconnect with backoff,
// and dispatch of server messages to callbacks. Auth is the cookie on the upgrade.

import { getConnId, getDeviceId, getDeviceName, resetConnId } from "./device";

export interface ConnTrack {
  id: number; title: string; duration?: number;
  albumId?: number; album?: string; artist?: string;
}
export interface SessionState {
  activeDeviceId: string | null;
  queue: ConnTrack[]; order: number[]; pos: number;
  isPlaying: boolean; position: number; positionAt: number;
  volume: number; shuffle: boolean; repeat: "off" | "all" | "one";
  updatedAt: number;
}
export interface DeviceInfo { id: string; name: string; isActive: boolean; }
export type ApplyMsg =
  | { action: "load"; trackId: number; position: number; play: boolean; pos?: number }
  | { action: "play" } | { action: "pause" } | { action: "stop" }
  | { action: "seek"; position: number }
  | { action: "setVolume"; volume: number }
  // Adopt remote queue edits / mode flags without touching local audio. Sent to
  // the active device so its own pushes don't revert them.
  | { action: "queue"; queue?: ConnTrack[]; order: number[]; pos: number; shuffle?: boolean }
  | { action: "mode"; repeat?: "off" | "all" | "one"; shuffle?: boolean };

// A member of a Session (listen-together across users).
export interface SessionMember { name: string; isHost: boolean; }
// Server-wide presence: another online user + what they're listening to.
export interface PresenceUser {
  userId: number;
  name: string;
  playing: boolean;
  track: { id: number; title: string; artist?: string; album?: string; albumId?: number } | null;
  inSession: boolean;
  isHost: boolean;
}
export interface SessionSync { track: ConnTrack | null; positionMs: number; playing: boolean; shuffle: boolean; repeat: "off" | "all" | "one"; rate?: number; at: number; }

interface Handlers {
  onState?: (s: SessionState) => void;
  onDevices?: (d: DeviceInfo[]) => void;
  onApply?: (a: ApplyMsg) => void;
  onPosition?: (p: { position: number; isPlaying: boolean; at: number }) => void;
  onVolume?: (volume: number) => void;
  onStatus?: (connected: boolean) => void;
  onConnIdChanged?: (connId: string) => void; // our connId was superseded; we took a new one
  // -- Sessions --
  onSessionCreated?: (code: string) => void;
  onSessionJoined?: (info: { code: string; host: string }) => void;
  onSessionMembers?: (members: SessionMember[], nightcoreOk: boolean) => void;
  onSessionSync?: (s: SessionSync) => void;
  onSessionEnded?: () => void;
  onSessionError?: (error: string) => void;
  onSessionHostAway?: () => void;
  // -- Presence (server-wide "who's online") --
  onPresence?: (users: PresenceUser[]) => void;
  onJoinRequest?: (r: { fromUserId: number; fromName: string }) => void; // host: someone wants in
  onJoinApproved?: (info: { code: string; host: string }) => void;        // guest: request accepted
  onJoinDeclined?: (info: { fromName: string }) => void;
  onInvite?: (inv: { fromUserId: number; fromName: string; code: string }) => void; // invitee
  onPresenceError?: (error: string) => void;
  onPresenceSelf?: (sharing: boolean) => void; // my own privacy setting (seeded on connect)
}

export class ConnectClient {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private closed = false;
  private h: Handlers;

  constructor(handlers: Handlers) { this.h = handlers; }

  // The id the session's `activeDeviceId` is expressed in: per-tab, not per-browser.
  get connId() { return getConnId(); }
  get deviceId() { return getDeviceId(); }

  start() { this.closed = false; this.open(); }

  private open() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try { ws = new WebSocket(`${proto}//${location.host}/api/connect`); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      // `v` is the hashed bundle this page runs, so the server's connect log can
      // spot devices on a stale (PWA-cached) frontend.
      let v = "dev";
      try {
        v = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
          .map(s => s.getAttribute("src") || "")
          .find(src => /assets\/index-/.test(src))
          ?.match(/index-([\w-]+)\.js/)?.[1] ?? "dev";
      } catch { v = "?"; }
      // `connId` keys the connection, `deviceId` groups a browser's tabs into one
      // roster entry. Older bundles send only `deviceId` and the server falls back.
      this.send({ type: "hello", connId: getConnId(), deviceId: getDeviceId(), name: getDeviceName(), v });
      this.h.onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case "state":    this.h.onState?.(m.state); break;
        case "devices":  this.h.onDevices?.(m.devices); break;
        case "apply":    this.h.onApply?.(m); break;
        case "position": this.h.onPosition?.(m); break;
        case "volume":   this.h.onVolume?.(Number(m.volume) || 0); break;
        case "session:created": this.h.onSessionCreated?.(String(m.code || "")); break;
        case "session:joined":  this.h.onSessionJoined?.({ code: String(m.code || ""), host: String(m.host || "") }); break;
        case "session:members": this.h.onSessionMembers?.(m.members || [], m.nightcoreOk !== false); break;
        case "session:state":   this.h.onSessionSync?.(m); break;
        case "session:ended":   this.h.onSessionEnded?.(); break;
        case "session:error":   this.h.onSessionError?.(String(m.error || "Session error")); break;
        case "session:host-away": this.h.onSessionHostAway?.(); break;
        case "presence:list": this.h.onPresence?.(m.users || []); break;
        case "presence:join-request":  this.h.onJoinRequest?.({ fromUserId: Number(m.fromUserId), fromName: String(m.fromName || "Someone") }); break;
        case "presence:join-approved":  this.h.onJoinApproved?.({ code: String(m.code || ""), host: String(m.host || "") }); break;
        case "presence:join-declined":  this.h.onJoinDeclined?.({ fromName: String(m.fromName || "The host") }); break;
        case "presence:invite":         this.h.onInvite?.({ fromUserId: Number(m.fromUserId), fromName: String(m.fromName || "Someone"), code: String(m.code || "") }); break;
        case "presence:error":          this.h.onPresenceError?.(String(m.error || "Something went wrong")); break;
        case "presence:self":           this.h.onPresenceSelf?.(m.sharing !== false); break;
      }
    };
    ws.onclose = (ev) => {
      this.h.onStatus?.(false);
      this.ws = null;
      if (ev.code === 4401) { this.closed = true; return; } // login expired/revoked
      // 4409: another socket registered our connId (a duplicated tab). Take a new
      // id and reconnect, don't fight for the slot.
      if (ev.code === 4409) { resetConnId(); this.backoff = 1000; this.h.onConnIdChanged?.(getConnId()); }
      this.scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    setTimeout(() => this.open(), delay);
  }

  send(msg: unknown) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); return true; } catch { /* */ }
    }
    return false;
  }

  command(cmd: Record<string, unknown>) { return this.send({ type: "command", cmd }); }
  // `trackId`: on a pull, what this device just loaded locally. The server sends
  // an apply-load if our mirror was stale.
  transfer(deviceId: string, trackId?: number) { return this.send({ type: "transfer", deviceId, trackId }); }
  reportPosition(position: number, isPlaying: boolean) { return this.send({ type: "position", position, isPlaying }); }
  rename(name: string) { return this.send({ type: "rename", name }); }

  // -- Sessions --
  // canNightcore: whether this device can run nightcore (false on phones). Nightcore
  // is off for the whole session if any member can't.
  createSession(name?: string, canNightcore = true) { return this.send({ type: "session:create", name, canNightcore }); }
  joinSession(code: string, name?: string, canNightcore = true) { return this.send({ type: "session:join", code, name, canNightcore }); }
  resumeSession(code: string) { return this.send({ type: "session:resume", code }); } // host reconnect
  leaveSession() { return this.send({ type: "session:leave" }); }
  sendSessionState(track: ConnTrack | null, positionMs: number, playing: boolean, shuffle: boolean, repeat: string, rate = 1) {
    return this.send({ type: "session:state", track, positionMs, playing, shuffle, repeat, rate });
  }

  // -- Presence ask-to-join / invite --
  requestJoin(targetUserId: number) { return this.send({ type: "presence:request-join", targetUserId }); }
  respondJoin(toUserId: number, accept: boolean) { return this.send({ type: "presence:respond-join", toUserId, accept }); }
  invitePresence(targetUserId: number) { return this.send({ type: "presence:invite", targetUserId }); }
  setSharing(sharing: boolean) { return this.send({ type: "presence:set-sharing", sharing }); }

  stop() { this.closed = true; try { this.ws?.close(); } catch { /* */ } this.ws = null; }
}
