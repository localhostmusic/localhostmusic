import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptOldDb } from "../src/db/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "lhm-adopt-"));

test("moves a pre-rename database and its WAL files to the new name", () => {
  const d = dir();
  for (const s of ["", "-wal", "-shm"]) writeFileSync(join(d, "sonora.db" + s), "old" + s);
  adoptOldDb(d);
  for (const s of ["", "-wal", "-shm"]) {
    expect(readFileSync(join(d, "lhm.db" + s), "utf8")).toBe("old" + s);
    expect(existsSync(join(d, "sonora.db" + s))).toBe(false);
  }
});

test("leaves an existing database alone", () => {
  const d = dir();
  writeFileSync(join(d, "sonora.db"), "old");
  writeFileSync(join(d, "lhm.db"), "new");
  adoptOldDb(d);
  expect(readFileSync(join(d, "lhm.db"), "utf8")).toBe("new");
  expect(existsSync(join(d, "sonora.db"))).toBe(true);
});

test("does nothing on a fresh install", () => {
  const d = dir();
  adoptOldDb(d);
  expect(existsSync(join(d, "lhm.db"))).toBe(false);
});
