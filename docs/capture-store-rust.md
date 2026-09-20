# Capture storage Rust migration

## Behavior and scope

DSH's capture panel and MCP now share `lib/capture-storage.mjs`, backed by the
Rust Node-API module in `native/capture-store/`. This replaces the two separate
JSONL read/write caches. JS retains normalization, JSON parsing/serialization,
filtering, body omission, pagination and the existing return shapes.

Rust owns shard I/O, per-ID byte accounting, retention ordering, writer locks,
freshness checks and staged replacement. It keeps metadata rather than a second
copy of response bodies. Ordinary appends update only the changed IDs and their
byte counts. Sorting for retention happens only when the limits require it.
Read-only queries defer byte-index construction until a write, statistics or
retention operation needs it.

The existing day-shard JSONL format remains readable without conversion. Legacy
`records.jsonl` is read first and removed only during a successful replacement.
Cross-shard duplicate IDs follow the same last-shard/last-line rule as a cold JS
read. IDs use UTF-16 units across Node-API to preserve JS identity and tie sorting,
including lone surrogates. Canonical byte counts use JS serialization to preserve
number formatting, property ordering and Unicode escaping exactly.

MCP retains immediate count/byte retention. The host retains its compaction
throttle and duplicate backlog counters; both paths use the same native retention
planner and write the shared retention marker. Host status includes the last
compaction error so a background failure remains visible.

## Local performance

Windows x64, Node.js 24.15.0, 10000 synthetic records with 4096-character bodies,
40.32 MiB store, nine append/query samples. Baseline: Git revision `6887521`.
Both runs use isolated temporary stores. First-query timings mean an empty
application cache; they do not represent a cold OS disk cache.

| Operation | Previous JS store | Rust-backed store |
| --- | ---: | ---: |
| First query (one sample) | 156.972 ms | 136.343 ms |
| Cached query median | 0.530 ms | 0.312 ms |
| First append after loading | 210.414 ms | 93.166 ms |
| Append median, nine samples | 205.820 ms | 0.900 ms |

The append median is about **228.7x** faster in this sample. The main gain comes
from eliminating repeated whole-store loading/serialization and maintaining the
index incrementally; it is not a language-only speed comparison. The first write
still pays to initialize canonical byte counts. Backdated writes and external
file changes can require a full reload, so they do not have the steady-state
append cost.

Reproduce from the repository root:

```powershell
npm run build:capture-store
npm run bench:capture-store -- 6887521
```

## Verification

- Full repository JavaScript regression: **105 test files passed, 0 failed**
  (217.4 seconds). Retention-limit boundary cases were additionally checked in a
  focused storage rerun.
- Four Rust tests cover traversal rejection, replacement accounting, oversized
  newest-record retention, stale replacements, and multi-shard staging failure.
- Storage integration checks compare the native planner with the existing JS
  reference and cover Unicode, malformed/hand-edited legacy JSONL, duplicate IDs,
  in-place file edits, missing final newlines, three independent writers and
  rejection of stale read/modify/write snapshots.
- Failure injection into the second shard's staging file verifies that neither
  original shard is modified before all staging succeeds.
- The actual host module is imported with only its framework definition wrapper
  stubbed. Host/MCP mutual reads, runId preservation, filtering, byte caps,
  retention markers and clear operations are checked. No capture engine, proxy
  or desktop application is started by that test.
- A temporary deployment missing its native module fails before any copy. A
  complete deployment can append/query from a profile path containing spaces.
- Rustfmt, Clippy and repository syntax/private-reference checks are included in
  local validation. Remote CI and non-Windows builds have not been run.

## Build, deployment and boundaries

The build stages `capture-store.node` under
`plugins/dsh-api-visualizer/bin/<platform>-<Node architecture>/`. Windows uses a
static CRT. Node-API version 6 avoids tying the module to one Node/V8 ABI. The
build script supports Windows MSVC, Linux GNU and macOS targets; Windows x64 is
the platform validated here. `DSH_CAPTURE_STORE_NATIVE` optionally overrides the
module path. Missing modules fail with a build instruction; they do not silently
return an empty store or fall back to the old implementation.

Deploy the plugin's `bin/` and shared `lib/` together, then restart DSH and MCP.
The persistent `.capture-store.lock` coordinates only writers using the new
storage layer. A lock wait is bounded at two seconds; stale append snapshots
have bounded retries. Stale explicit replacements are rejected for caller retry.

Replacement stages and flushes every new shard before publishing any, then
removes obsolete shards last. Publication is atomic per file, not a database
transaction across multiple files: a crash during multi-file publication can
leave a mixture of generations. Ordinary appends retain the prior buffered-write
durability semantics. No live capture data was migrated or modified and no live
profile was deployed or restarted during this work.
