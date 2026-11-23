import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

// Guards routes where the server fetches a user-supplied URL (podcast feeds,
// episodes, transcripts, internet radio streams). Blocks hosts that resolve to a
// private/reserved address, so a user can't read cloud metadata or the host's LAN.
// The check must hold after every redirect, so redirects are followed manually.

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BlockedUrlError";
  }
}

const ipv4Blocked = (ip: string): boolean => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||                                  // 0.0.0.0/8 "this network"
    a === 10 ||                                 // private
    a === 127 ||                                // loopback
    (a === 100 && b >= 64 && b <= 127) ||       // 100.64/10 CGNAT (Tailscale et al.)
    (a === 169 && b === 254) ||                 // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||        // private
    (a === 192 && b === 168) ||                 // private
    (a === 192 && b === 0) ||                   // 192.0.0/24 protocol assignments
    (a === 198 && (b === 18 || b === 19)) ||    // benchmarking
    a >= 224                                    // multicast + reserved + broadcast
  );
};

const ipv6Blocked = (ip: string): boolean => {
  const a = ip.toLowerCase().split("%")[0]; // strip zone id
  if (a === "::" || a === "::1") return true;                       // unspecified / loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge by the embedded v4.
  const mapped = /^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return ipv4Blocked(mapped[2]);
  return (
    a.startsWith("fe8") || a.startsWith("fe9") ||                   // link-local fe80::/10
    a.startsWith("fea") || a.startsWith("feb") ||
    a.startsWith("fc") || a.startsWith("fd") ||                     // unique-local fc00::/7
    a.startsWith("ff")                                              // multicast
  );
};

export const isBlockedAddress = (ip: string): boolean =>
  isIPv4(ip) ? ipv4Blocked(ip) : isIPv6(ip) ? ipv6Blocked(ip) : true;

/**
 * Resolve `url` and throw BlockedUrlError unless it is a public http(s) endpoint.
 * Returns the resolved address so the caller can log/pin it.
 */
export async function assertPublicUrl(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); }
  catch { throw new BlockedUrlError("That doesn't look like a valid URL."); }

  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new BlockedUrlError(`Only http and https URLs are supported (got ${u.protocol.replace(":", "") || "none"}).`);

  const host = u.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1]

  // A literal IP skips DNS entirely.
  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrlError("That address is on a private or reserved network.");
    return host;
  }

  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new BlockedUrlError(`Couldn't resolve ${host}.`); }

  if (!addrs.length) throw new BlockedUrlError(`Couldn't resolve ${host}.`);
  // Block if any resolved address is private, so a hostname with both public and
  // private A records can't be used to reach the private one.
  for (const { address } of addrs)
    if (isBlockedAddress(address)) throw new BlockedUrlError("That hostname resolves to a private or reserved network.");

  return addrs[0].address;
}

/**
 * fetch(), but every URL in the redirect chain must pass assertPublicUrl().
 */
export async function safeFetch(url: string, init: RequestInit & { maxRedirects?: number } = {}): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...rest, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // redirect with no target; let the caller deal with it
      // Drain the redirect body so the socket can be reused.
      try { await res.arrayBuffer(); } catch { /* empty body */ }
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new BlockedUrlError("Too many redirects.");
}
