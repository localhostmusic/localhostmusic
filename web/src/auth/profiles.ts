// Who has signed in on this device, for the sign-in page's tiles. Names only, kept
// in this browser, most recent first. Storage can be unavailable (private windows),
// in which case the page simply shows the plain form.

const KEY = "lhm-profiles";
const MAX = 12;

export function savedProfiles(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(n => typeof n === "string" && n.trim()).slice(0, MAX) : [];
  } catch { return []; }
}

function write(list: string[]): string[] {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* not remembered */ }
  return list;
}

const without = (name: string) => savedProfiles().filter(n => n.toLowerCase() !== name.toLowerCase());

export function rememberProfile(name: string): string[] {
  const n = name.trim();
  return n ? write([n, ...without(n)].slice(0, MAX)) : savedProfiles();
}

export function forgetProfile(name: string): string[] {
  return write(without(name));
}

// "Don't ask for my password on this device": the secret the server handed this
// device for a user. Whoever can use this browser can sign in as them, which is
// the point; it is opt-in per person.
const TOKENS = "lhm-device-tokens";

function tokens(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(TOKENS) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export const deviceToken = (name: string): string | null => tokens()[name.trim().toLowerCase()] ?? null;

export function setDeviceToken(name: string, token: string | null) {
  const all = tokens(), key = name.trim().toLowerCase();
  if (token) all[key] = token; else delete all[key];
  try { localStorage.setItem(TOKENS, JSON.stringify(all)); } catch { /* not remembered */ }
}
