import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fstatic from "@fastify/static";
import { registerCompression } from "./lib/compress.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { adoptOldDb, openDb } from "./db/index.js";
import { config } from "./config.js";
import { authenticate, type SessionUser } from "./lib/auth.js";
import { authRoutes } from "./routes/auth.js";
import { libraryRoutes } from "./routes/library.js";
import { homeRoutes } from "./routes/home.js";
import { streamRoutes } from "./routes/stream.js";
import { searchRoutes } from "./routes/search.js";
import { playlistRoutes } from "./routes/playlists.js";
import { favoriteRoutes } from "./routes/favorites.js";
import { adminRoutes } from "./routes/admin.js";
import { lyricsRoutes } from "./routes/lyrics.js";
import { scrobbleRoutes } from "./routes/scrobble.js";
import { genreRoutes } from "./routes/genres.js";
import { backfillArtistGenres } from "./lib/genres.js";
import { reportRoutes } from "./routes/reports.js";
import { notificationRoutes } from "./routes/notifications.js";
import { accountRoutes } from "./routes/account.js";
import { metadataRoutes } from "./routes/metadata.js";
import { artistInfoRoutes } from "./routes/artistinfo.js";
import { discographyRoutes } from "./routes/discography.js";
import { discoverRoutes } from "./routes/discover.js";
import { statsRoutes } from "./routes/stats.js";
import { healthRoutes } from "./routes/health.js";
import { connectRoutes } from "./realtime/connect.js";
import { subsonicRoutes } from "./routes/subsonic.js";
import { podcastRoutes } from "./routes/podcasts.js";

declare module "fastify" {
  interface FastifyInstance { db: Database.Database; authRequired: any; }
  interface FastifyRequest { user?: SessionUser; }
}

export function buildApp(db?: Database.Database): FastifyInstance {
  // Behind a reverse proxy, set TRUST_PROXY=1 so req.ip is the real client (login
  // throttling keys on it) and req.protocol reflects the browser's https (the cookie's
  // Secure flag keys on it). Off by default: a directly reachable server must not
  // believe a client-supplied X-Forwarded-For/-Proto header.
  const app = Fastify({ logger: false, trustProxy: process.env.TRUST_PROXY === "1" });
  app.register(cookie);
  app.register(websocket);
  if (!db) adoptOldDb(config.dataDir);
  app.decorate("db", db ?? openDb(`${config.dataDir}/lhm.db`));
  app.decorate("authRequired", async (req: any, reply: any) => {
    const token = req.cookies?.lhm_session;
    try { req.user = authenticate(app.db, token); }
    catch { return reply.code(401).send({ error: "unauthorized" }); }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/stream/")) {
      const row = app.db.prepare("SELECT value FROM app_settings WHERE key='_library_revision'").get() as { value: string } | undefined;
      if (row) reply.header("x-lhm-library-revision", row.value);
    }
    return payload;
  });
  registerCompression(app);
  app.get("/api/health", async () => ({ status: "ok" }));

  // Digital Asset Links: lets an installed Android TWA (the TV app) verify it owns
  // this site and run fullscreen. Set ANDROID_PACKAGE + ANDROID_FINGERPRINT (the APK
  // signing SHA-256). Returns 404 until configured.
  app.get("/.well-known/assetlinks.json", async (_req, reply) => {
    const pkg = process.env.ANDROID_PACKAGE;
    const fp = process.env.ANDROID_FINGERPRINT;
    if (!pkg || !fp) return reply.code(404).send();
    return [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fp.split(",").map(s => s.trim()) },
    }];
  });

  app.register(authRoutes);
  app.register(libraryRoutes);
  app.register(homeRoutes);
  app.register(streamRoutes);
  app.register(searchRoutes);
  app.register(playlistRoutes);
  app.register(favoriteRoutes);
  app.register(adminRoutes);
  app.register(lyricsRoutes);
  app.register(scrobbleRoutes);
  app.register(reportRoutes);
  app.register(notificationRoutes);
  app.register(accountRoutes);
  app.register(metadataRoutes);
  app.register(artistInfoRoutes);
  app.register(discographyRoutes);
  app.register(discoverRoutes);
  app.register(statsRoutes);
  app.register(healthRoutes);
  app.register(connectRoutes);
  app.register(genreRoutes);
  app.register(subsonicRoutes);
  app.register(podcastRoutes);

  // Populate the genre index in the background (from cached genres, then Last.fm).
  void backfillArtistGenres(app.db);

  // PUBLIC_DIR lets a dev instance serve its own frontend build instead of public/.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", process.env.PUBLIC_DIR || "public");
  if (existsSync(publicDir)) {
    app.register(fstatic, {
      root: publicDir, wildcard: false,
      // Send the .br/.gz copies the web build writes next to each text asset.
      preCompressed: true,
      // The plugin writes its own Cache-Control after setHeaders and overrides it,
      // so it is turned off and every file gets its header below.
      cacheControl: false,
      // The service worker and index shell are never served stale, so updates reach
      // clients. Hashed /assets never change, so they cache for good.
      setHeaders: (res: any, path: string) => {
        const file = path.replace(/\.(br|gz)$/, "");
        if (file.endsWith("sw.js") || file.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
        else if (/[\\/]assets[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "public, max-age=0");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      // A missing build asset must 404, not fall back to the HTML shell: a 200 with
      // HTML under a .js URL renders a blank page and gets cached by the service worker.
      if (req.url.startsWith("/assets/")) return reply.code(404).send("not found");
      return reply.sendFile("index.html");
    });
  }
  return app;
}
