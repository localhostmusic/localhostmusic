// Per-browser identity for Connect. The id persists so a device keeps its
// roster slot across reloads. The name is user-editable and defaults to a guess
// from the user agent.

const ID_KEY = "lhm_device_id";
const CONN_KEY = "lhm_conn_id";
const NAME_KEY = "lhm_device_name";
const NAME_CUSTOM_KEY = "lhm_device_name_custom"; // set once the user renames

function uuid(): string {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* old browser */ }
  return "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getDeviceId(): string {
  let id = "";
  try { id = localStorage.getItem(ID_KEY) || ""; } catch { /* */ }
  if (!id) { id = uuid(); try { localStorage.setItem(ID_KEY, id); } catch { /* */ } }
  return id;
}

// Per-tab connection id, the key the server's Connect hub uses. The device id is
// in localStorage and shared by every tab, so it can't key connections.
// sessionStorage is per-tab and survives reloads. Memoized so a storage exception
// doesn't hand out a different id on every call.
let connId = "";
export function getConnId(): string {
  if (connId) return connId;
  try { connId = sessionStorage.getItem(CONN_KEY) || ""; } catch { /* */ }
  if (!connId) {
    connId = uuid();
    try { sessionStorage.setItem(CONN_KEY, connId); } catch { /* private mode: id stays in memory */ }
  }
  return connId;
}

// New connection id, for when the server reports ours was claimed by another
// socket (Chrome's "Duplicate tab" copies sessionStorage).
export function resetConnId(): string {
  connId = "";
  try { sessionStorage.removeItem(CONN_KEY); } catch { /* */ }
  return getConnId();
}

function guessName(): string {
  // On the /tv route the device is a TV, but only while on it. Never persisted.
  try { if (location.pathname.replace(/\/+$/, "") === "/tv") return "TV"; } catch { /* */ }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/\b(CrKey|SmartTV|SMART-TV|AppleTV|GoogleTV|BRAVIA|Tizen|Web0S|webOS)\b/i.test(ua)) return "TV";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android Phone" : "Android Tablet";
  const browser =
    /Firefox\//.test(ua) ? "Firefox" :
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : null;
  const os = /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} · ${os}`;
  return os ?? browser ?? "Browser";
}

export function getDeviceName(): string {
  // Only a user-typed name is stored. Defaults are recomputed on each load.
  try {
    if (localStorage.getItem(NAME_CUSTOM_KEY) && localStorage.getItem(NAME_KEY)) {
      return localStorage.getItem(NAME_KEY)!;
    }
  } catch { /* */ }
  return guessName();
}

export function setDeviceName(name: string) {
  const n = name.trim().slice(0, 60);
  if (n) try { localStorage.setItem(NAME_KEY, n); localStorage.setItem(NAME_CUSTOM_KEY, "1"); } catch { /* */ }
}
