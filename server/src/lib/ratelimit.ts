// Brute-force throttle for the password endpoints (/api/auth/login and the Subsonic
// authenticator).
// Only failures count, and a success clears the counter, so Subsonic clients that
// re-auth on every request are unaffected.
// Keyed by username as well as IP: behind a reverse proxy every request shares the
// proxy's IP, so an IP-only limit would lock out everyone.

interface Bucket { count: number; resetAt: number; }

export interface LimitDecision { allowed: boolean; retryAfter: number; }

export class AttemptLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private bucket(key: string, now: number): Bucket {
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      const fresh = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    return b;
  }

  check(key: string, now = Date.now()): LimitDecision {
    const b = this.bucket(key, now);
    if (b.count >= this.max)
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
    return { allowed: true, retryAfter: 0 };
  }

  /** Record a failed attempt. Returns the decision for the *next* attempt. */
  fail(key: string, now = Date.now()): LimitDecision {
    const b = this.bucket(key, now);
    b.count++;
    this.prune(now);
    return this.check(key, now);
  }

  /** A correct password clears the slate for that key. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  // Drop expired buckets on write so the map stays bounded. It only holds keys
  // that have failed.
  private prune(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [k, b] of this.buckets) if (now >= b.resetAt) this.buckets.delete(k);
  }

  /** Test seam. */
  clear(): void { this.buckets.clear(); }
}

// 10 failures per account per 15 minutes. The per-IP limit is looser because a
// shared proxy address is normal.
export const loginLimiter = new AttemptLimiter(10, 15 * 60 * 1000);
export const loginIpLimiter = new AttemptLimiter(50, 15 * 60 * 1000);

/**
 * Shared gate for both password paths. Returns null when the attempt may proceed,
 * or the number of seconds to wait when it may not.
 */
export function checkLoginAllowed(username: string, ip: string): number | null {
  const user = loginLimiter.check(`u:${username.toLowerCase()}`);
  if (!user.allowed) return user.retryAfter;
  const addr = loginIpLimiter.check(`i:${ip}`);
  if (!addr.allowed) return addr.retryAfter;
  return null;
}

export function recordLoginFailure(username: string, ip: string): void {
  loginLimiter.fail(`u:${username.toLowerCase()}`);
  loginIpLimiter.fail(`i:${ip}`);
}

export function recordLoginSuccess(username: string, ip: string): void {
  loginLimiter.reset(`u:${username.toLowerCase()}`);
  loginIpLimiter.reset(`i:${ip}`);
}
