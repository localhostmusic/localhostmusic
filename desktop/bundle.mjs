// Builds the web app and the server and assembles ./server: everything the built-in
// server needs to run without the user installing anything.
//
// The server runs on a real Node binary, not Electron's (sharp does not work under
// Electron's on Linux). The Node that runs this script is the one that gets shipped,
// so the native modules installed here match it. Use an official Node build.
import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

run("npm run build", join(root, "web"));
run("npm run build", join(root, "server"));

const out = join(here, "server");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "server", "dist"), join(out, "dist"), { recursive: true });
cpSync(join(root, "web", "dist"), join(out, "public"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) cpSync(join(root, "server", f), join(out, f));
// The MIT notices for ported code have to travel with the built app.
for (const f of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) cpSync(join(root, f), join(out, f));
run("npm ci --omit=dev --no-audit --no-fund", out);

// The Go scanner is much faster on big libraries and keeps the scan out of the
// server process. Optional: without Go the server uses its own scanner.
try {
  const scanner = join(out, process.platform === "win32" ? "lhm-scan.exe" : "lhm-scan");
  run(`go build -o "${scanner}" .`, join(root, "server", "scanner-go"));
} catch {
  console.warn("Go not available, shipping without the fast scanner.");
}

const node = join(out, basename(process.execPath));
cpSync(process.execPath, node);
chmodSync(node, 0o755);
writeFileSync(join(out, "node-version.txt"), process.version + "\n");
