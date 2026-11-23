import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR ?? "/data";

// Session-signing key. Anyone who knows it can forge an admin cookie.
// Refuses to boot on a known-public placeholder. When unset, generates a strong
// secret and persists it under DATA_DIR so logins survive restarts.
const PLACEHOLDERS = new Set(["change-me", "changeme", "secret", "your-secret-here", "localhostmusic"]);

function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (PLACEHOLDERS.has(fromEnv.trim().toLowerCase())) {
      console.error(
        `[lhm] FATAL: JWT_SECRET is set to the placeholder "${fromEnv}".\n` +
        `         This value is published in Localhost Music's own source, so anyone could forge\n` +
        `         an admin session on this server. Remove JWT_SECRET to have Localhost Music\n` +
        `         generate and store a strong one, or set your own:\n` +
        `             JWT_SECRET=$(openssl rand -hex 32)`
      );
      process.exit(1);
    }
    if (fromEnv.length < 16)
      console.warn("[lhm] JWT_SECRET is short; 32+ random bytes is recommended (openssl rand -hex 32).");
    return fromEnv;
  }

  // Unset: reuse the persisted secret, or mint one now and store it 0600 next to the DB.
  const file = join(dataDir, ".jwt-secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first run, fall through and create it */ }

  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`[lhm] Generated a session secret and saved it to ${file}.`);
  } catch {
    // Read-only or missing DATA_DIR (also tests). Still safe, but sessions don't
    // survive a restart.
    console.warn("[lhm] JWT_SECRET is not set and DATA_DIR isn't writable, using a random per-boot secret; logins will not survive a restart.");
  }
  return secret;
}

export const config = {
  port: Number(process.env.PORT ?? 8585),
  // Address to listen on. The desktop app sets 127.0.0.1 so nothing else on the
  // network can reach its built-in server.
  host: process.env.HOST ?? "0.0.0.0",
  musicDir: process.env.MUSIC_DIR ?? "/music",
  dataDir,
  jwtSecret: resolveJwtSecret(),
  // Send the session cookie with the Secure flag (HTTPS-only). Auto-detected per
  // request when unset: forcing it on locks out plain-HTTP LAN installs, forcing it
  // off leaks the 30-day token on any plaintext hop.
  cookieSecure: process.env.COOKIE_SECURE === "1" ? true
    : process.env.COOKIE_SECURE === "0" ? false
    : ("auto" as const),
  // Optional free API key (fanart.tv) used to fetch wide landscape artist banners.
  fanartApiKey: process.env.FANART_API_KEY ?? "",
  // Optional Last.fm API app credentials (register at last.fm/api/account/create).
  // Without both, Last.fm scrobbling is unavailable. ListenBrainz needs no server config.
  lastfmApiKey: process.env.LASTFM_API_KEY ?? "",
  lastfmApiSecret: process.env.LASTFM_API_SECRET ?? "",
  // TheAudioDB artist-image source. "2" is their free test key (rate-limited);
  // set your own Patreon key for higher limits.
  audiodbApiKey: process.env.AUDIODB_API_KEY ?? "2",
};
