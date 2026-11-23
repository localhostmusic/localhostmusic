# lhm-scan: Go library scanner

A drop-in, parallel replacement for the in-process JS scanner
(`server/src/scanner/scan.ts`). It produces **byte-identical** results (verified
against the JS scanner: same artists/albums/tracks/covers, durations within
0.5 ms) but parses tags across a worker pool instead of one file at a time. The
one part of a scan that gets painful at million-track scale.

Pure-Go, no CGO, so it builds to a single static binary that cross-compiles to a
Raspberry Pi:

- **Tags + duration + embedded art:** [`go.senan.xyz/taglib`](https://pkg.go.dev/go.senan.xyz/taglib)
  (taglib compiled to WASM, run via wazero). Multi-value fields come back as
  ordered slices; `[0]` matches music-metadata's "first value" semantics.
- **DB writes:** [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) (pure Go).

## Architecture

```
walk music dir ─► skip paths already in tracks ─► [N parse workers] ─► 1 writer goroutine ─► SQLite
```

Only the writer touches the DB, so there is no write contention inside the
process. Track inserts are batched in transactions of 200 (like the JS scanner)
so the WAL write-lock is held only briefly, so a live server can interleave its own
writes (it has `busy_timeout=10000` for exactly this).

## Build

```sh
cd server/scanner-go
go build -o lhm-scan .                          # host platform
GOOS=linux GOARCH=arm64 go build -o lhm-scan .  # Raspberry Pi (64-bit)
```

The binary is gitignored; build it as part of deploy.

## Enable

The Node server uses the sidecar **only** when `LHM_SCANNER_BIN` points at the
built binary; otherwise it runs the JS scanner. If the sidecar errors, the server
logs a warning and falls back to the JS scanner (both share the same skip logic,
so a half-finished sidecar run is safely completed by the fallback).

```sh
LHM_SCANNER_BIN=/abs/path/to/server/scanner-go/lhm-scan
```

Test on the **dev** instance first (never prod directly).

## Run standalone

```sh
./lhm-scan --music /path/to/Music --data /path/to/data --db /path/to/data/lhm.db [--workers N]
# {"added":735,"issues":0}
```
