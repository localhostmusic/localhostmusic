import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function cacheCover(dataDir: string, albumId: number, picture: Buffer): string {
  const dir = join(dataDir, "covers");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${albumId}.jpg`);
  writeFileSync(file, picture);
  return file;
}
