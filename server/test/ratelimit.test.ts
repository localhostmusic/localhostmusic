import { test, expect, describe, beforeEach } from "vitest";
import {
  AttemptLimiter, loginLimiter, loginIpLimiter,
  checkLoginAllowed, recordLoginFailure, recordLoginSuccess,
} from "../src/lib/ratelimit.js";

describe("AttemptLimiter", () => {
  test("allows attempts up to the cap, then blocks", () => {
    const l = new AttemptLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(l.check("k").allowed).toBe(true);
      l.fail("k");
    }
    const d = l.check("k");
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
  });

  test("the window expires", () => {
    const l = new AttemptLimiter(1, 1000);
    const t0 = 1_000_000;
    l.fail("k", t0);
    expect(l.check("k", t0).allowed).toBe(false);
    expect(l.check("k", t0 + 1001).allowed).toBe(true);
  });

  test("a success clears the counter", () => {
    const l = new AttemptLimiter(2, 60_000);
    l.fail("k"); l.fail("k");
    expect(l.check("k").allowed).toBe(false);
    l.reset("k");
    expect(l.check("k").allowed).toBe(true);
  });

  test("keys are independent", () => {
    const l = new AttemptLimiter(1, 60_000);
    l.fail("a");
    expect(l.check("a").allowed).toBe(false);
    expect(l.check("b").allowed).toBe(true);
  });
});

describe("login throttle", () => {
  beforeEach(() => { loginLimiter.clear(); loginIpLimiter.clear(); });

  test("blocks sustained guessing against one account", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkLoginAllowed("admin", "1.2.3.4")).toBeNull();
      recordLoginFailure("admin", "1.2.3.4");
    }
    expect(checkLoginAllowed("admin", "1.2.3.4")).toBeGreaterThan(0);
  });

  // Behind a reverse proxy every request carries the proxy's IP. Guessing "admin"
  // must not block anyone else signing in.
  test("throttling one account does not lock out a different account", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("admin", "1.2.3.4");
    expect(checkLoginAllowed("admin", "1.2.3.4")).toBeGreaterThan(0);
    expect(checkLoginAllowed("alice", "1.2.3.4")).toBeNull();
  });

  test("distributing the attack across IPs still hits the per-account limit", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("admin", `10.0.0.${i}`);
    expect(checkLoginAllowed("admin", "203.0.113.9")).toBeGreaterThan(0);
  });

  test("usernames are matched case-insensitively, like login itself", () => {
    for (let i = 0; i < 10; i++) recordLoginFailure("Admin", "1.2.3.4");
    expect(checkLoginAllowed("admin", "1.2.3.4")).toBeGreaterThan(0);
  });

  test("a correct password clears the throttle", () => {
    for (let i = 0; i < 9; i++) recordLoginFailure("admin", "1.2.3.4");
    recordLoginSuccess("admin", "1.2.3.4");
    for (let i = 0; i < 9; i++) {
      expect(checkLoginAllowed("admin", "1.2.3.4")).toBeNull();
      recordLoginFailure("admin", "1.2.3.4");
    }
  });

  test("successful logins are never throttled, however many there are", () => {
    // Subsonic clients re-authenticate on every request. This must stay free.
    for (let i = 0; i < 500; i++) {
      expect(checkLoginAllowed("alice", "1.2.3.4")).toBeNull();
      recordLoginSuccess("alice", "1.2.3.4");
    }
  });
});
