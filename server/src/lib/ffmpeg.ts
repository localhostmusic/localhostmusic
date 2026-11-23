import { spawn } from "node:child_process";

// FFMPEG_PATH points at a specific binary (the desktop app ships its own).
const bin = process.env.FFMPEG_PATH || "ffmpeg";

// `low` runs background jobs at low CPU priority where `nice` exists.
export function spawnFfmpeg(args: string[], low = false) {
  const stdio: ["ignore", "ignore", "pipe"] = ["ignore", "ignore", "pipe"];
  return low && process.platform !== "win32"
    ? spawn("nice", ["-n", "15", bin, ...args], { stdio })
    : spawn(bin, args, { stdio });
}
