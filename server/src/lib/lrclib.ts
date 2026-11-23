import { createHash } from "crypto";

// Publish hand-synced lyrics to LRCLIB (https://lrclib.net). Publishing needs a
// proof-of-work token: request a challenge (prefix + target), find a nonce whose
// SHA-256(prefix + nonce) is <= the target, and send `prefix:nonce`.
// See https://lrclib.net/docs.

const LRCLIB = "https://lrclib.net/api";
const UA = "LocalhostMusic/1.0 (self-hosted music server; +https://github.com/localhostmusic/localhostmusic)";

export interface PublishPayload {
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number; // seconds
  plainLyrics: string;
  syncedLyrics: string;
}

// A candidate hash satisfies the challenge when it is <= the target, compared as
// big-endian byte strings (LRCLIB's own verifier). Equal counts as satisfied.
function meetsTarget(hash: Buffer, target: Buffer): boolean {
  const n = Math.min(hash.length, target.length);
  for (let i = 0; i < n; i++) {
    if (hash[i] > target[i]) return false;
    if (hash[i] < target[i]) return true;
  }
  return true;
}

// Find a nonce for the challenge. CPU-bound, so it runs in chunks, yields to the
// event loop between them, and gives up after a timeout.
async function solveChallenge(prefix: string, targetHex: string, timeoutMs = 120_000): Promise<string> {
  const target = Buffer.from(targetHex, "hex");
  const started = Date.now();
  let nonce = 0;
  for (;;) {
    for (let i = 0; i < 20_000; i++) {
      const hash = createHash("sha256").update(prefix + nonce).digest();
      if (meetsTarget(hash, target)) return String(nonce);
      nonce++;
    }
    if (Date.now() - started > timeoutMs) throw new Error("proof-of-work timed out");
    await new Promise((r) => setImmediate(r));
  }
}

// Request a challenge, solve it, and publish. Throws with a human-readable message on
// any failure (network, rejected token, duplicate/invalid submission).
export async function publishToLrclib(payload: PublishPayload): Promise<void> {
  const chRes = await fetch(`${LRCLIB}/request-challenge`, {
    method: "POST",
    headers: { "User-Agent": UA },
  });
  if (!chRes.ok) throw new Error(`could not get a publish challenge (${chRes.status})`);
  const { prefix, target } = (await chRes.json()) as { prefix: string; target: string };
  if (!prefix || !target) throw new Error("malformed challenge from LRCLIB");

  const nonce = await solveChallenge(prefix, target);

  const pubRes = await fetch(`${LRCLIB}/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Publish-Token": `${prefix}:${nonce}`,
    },
    body: JSON.stringify(payload),
  });
  if (pubRes.status === 201) return;
  const body = await pubRes.text().catch(() => "");
  throw new Error(`LRCLIB rejected the submission (${pubRes.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
}
