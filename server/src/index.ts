import { buildApp } from "./app.js";
import { config } from "./config.js";
import { ensureAdmin, resetAdminPassword } from "./lib/bootstrap.js";
import { scanAll } from "./lib/libraryScan.js";
import { pruneEmpty } from "./lib/prune.js";
import { runPrewarm } from "./lib/prewarm.js";
import { backfillLoudness } from "./lib/loudness.js";
import { backfillArtColors } from "./lib/artColor.js";
import { refreshAllChannels } from "./lib/podcast.js";
import { startUpdateChecks } from "./lib/updateCheck.js";

const app = buildApp();
const admin = await ensureAdmin(
  app.db,
  process.env.ADMIN_USER ?? "admin",
  process.env.ADMIN_PASSWORD || undefined
);
if (admin.created && admin.generatedPassword) {
  console.log(
    `\n[lhm] Created the admin account. This password is shown ONCE:\n\n` +
    `             username: ${admin.username}\n` +
    `             password: ${admin.generatedPassword}\n\n` +
    `         Sign in and change it, or set ADMIN_PASSWORD before first run.\n`
  );
} else if (admin.created) {
  console.log(`[lhm] Created admin user "${admin.username}" from ADMIN_PASSWORD.`);
}
if (process.env.RESET_ADMIN_PASSWORD && !admin.created) {
  console.log("[lhm] " + await resetAdminPassword(app.db, process.env.ADMIN_USER ?? "admin", process.env.RESET_ADMIN_PASSWORD));
}
scanAll(app.db, config.dataDir)
  .then(r => {
    const pruned = pruneEmpty(app.db);
    console.log(`Scan: +${r.added} tracks, -${r.removed} gone, ${r.issues} issues; pruned ${pruned.albums} albums, ${pruned.artists} artists; +${r.books} audiobooks`);
    return runPrewarm(app.db); // fill any missing pre-transcodes (no-op when all tiers are off)
  })
  // Measure loudness for un-analyzed tracks (background, one niced ffmpeg at a time).
  // Delayed so it doesn't contend with the boot scan/prewarm.
  .then(() => {
    setTimeout(() => backfillLoudness(app.db).catch(() => {}), 120_000);
    // Cover colours for grid placeholders (a 64px downscale each).
    setTimeout(() => backfillArtColors(app.db, config.dataDir).catch(() => {}), 10_000);
  })
  .catch(e => console.error("Scan failed", e));
startUpdateChecks(app.db);
app.listen({ port: config.port, host: config.host })
  .then(() => console.log(`Localhost Music on ${config.port}`));

// The desktop app passes its pid. When that process is gone, however it died, stop
// too so no orphan keeps the port.
const parentPid = Number(process.env.EXIT_WITH_PID);
if (parentPid > 0) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { process.exit(0); }
  }, 2000).unref();
}

// Podcast auto-refresh: pull new episodes for every subscribed feed shortly after
// boot, then every 3h. Per-feed failures are swallowed inside.
const refreshPodcasts = () => refreshAllChannels(app.db)
  .then(n => { if (n) console.log(`Podcasts: +${n} new episodes`); })
  .catch(() => {});
setTimeout(refreshPodcasts, 90_000);
setInterval(refreshPodcasts, 3 * 60 * 60 * 1000);
