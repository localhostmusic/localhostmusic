import { test, expect, describe } from "vitest";
import { isBlockedAddress, assertPublicUrl, BlockedUrlError } from "../src/lib/ssrf.js";

describe("isBlockedAddress", () => {
  test("blocks the private, loopback and reserved v4 ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3",     // loopback
      "10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.10", // RFC1918
      "169.254.169.254",            // cloud metadata
      "100.64.0.1",                 // CGNAT / Tailscale
      "0.0.0.0", "224.0.0.1", "255.255.255.255",
    ]) expect(isBlockedAddress(ip), ip).toBe(true);
  });

  test("allows ordinary public v4 addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1"])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });

  test("blocks loopback, link-local, ULA and v4-mapped-private v6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
      expect(isBlockedAddress(ip), ip).toBe(true);
  });

  test("allows public v6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("treats anything unparseable as blocked", () => {
    for (const s of ["", "nonsense", "999.1.1.1"]) expect(isBlockedAddress(s), s).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  const blocked = (url: string) => expect(assertPublicUrl(url)).rejects.toThrow(BlockedUrlError);

  test("rejects non-http schemes", async () => {
    await blocked("file:///etc/passwd");
    await blocked("gopher://localhost:70/");
    await blocked("ftp://example.com/x");
  });

  test("rejects literal private/loopback hosts without touching DNS", async () => {
    await blocked("http://127.0.0.1:8585/api/health");
    await blocked("http://169.254.169.254/latest/meta-data/");
    await blocked("http://192.168.1.1/");
    await blocked("http://[::1]:3000/");
  });

  test("rejects hostnames that resolve into a private network", async () => {
    // localhost resolves to 127.0.0.1/::1 on every platform we support.
    await blocked("http://localhost:3000/");
  });

  test("rejects garbage input", async () => {
    await blocked("not a url");
  });

  test("allows a public literal address", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/")).resolves.toBe("1.1.1.1");
  });
});
