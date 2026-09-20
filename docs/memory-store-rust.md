# Memory vector store Rust migration

Validated locally on Windows x64 with Node.js 24.15.0 and Rust 1.98.1.

## Scope

`native/memory-store/` implements a Node-API module used by
`plugins/dsh-memory/lib/store.mjs`. It caches dense vectors and sparse bigram
terms, ranks hits with a bounded heap, indexes UTF-16 ID prefixes and writes
JSONL with staged replacement and previous-generation `.bak` files. DSH and MCP
already retain one DshMemory instance, so subsequent calls reuse the index.

Embedding providers, privacy screening, KV memory, result rendering, source
freshness checks and index budgets remain in JS. JSON parsing happens on initial
load or external file change, then only selected result rows cross back to JS.
Dense vectors cross Node-API as Float64Array, avoiding millions of individual
N-API number conversions. Rust retains typed vectors and original JSON rows;
memory usage remains proportional to the index size, including both forms.

Existing JSONL is read without conversion or rewrite. Ordinary rankings preserve
the JS reference's scores and stable tie order. Unequal dimensions that produce
NaN use the original JS comparator for ordering; this uncommon path returns all
candidate rows and does not have the normal bounded top-k transport cost.

## Evidence-backed correctness changes

Before editing the old implementation, an isolated probe showed:

- A local bigram vector with 10 terms persisted with 0 terms because JSON.stringify
  serialized its Map as `{}`. Its reopened self-similarity was 0.
- A deliberately failing reindex removed the previous complete file index before
  the embedding error was reported.

New bigram Maps are serialized as ordinary objects, including UTF-16 terms
containing surrogate halves. Previously lost terms cannot be reconstructed from
an empty saved object. Reindex affected sources into a fresh project namespace;
unchanged-file mtime skipping otherwise keeps the old index. No existing user
data was edited or reindexed during this work.

File chunks now remain temporary until every embedding succeeds and the source
mtime/size still matches. A single prefix replacement installs the complete file.
Batch flush thresholds are evaluated only after this replacement, so even a
one-chunk threshold cannot publish a partial file. Failed/budget-aborted reindexing
keeps the previous complete snapshot; sensitive content still removes prior
chunks and is never embedded. Final publication errors propagate to the caller.

## Performance

Baseline Git revision `6887521`, synthetic 3000-row index, 1024-dimensional dense
vectors, nine repeated searches for five hits. Timings include disk checking and
result transfer but exclude remote embedding. Cold means an empty application
cache, not a cold OS disk cache. The benchmark checks that top IDs agree; returned
scores in this run were identical too.

| Operation | Previous JS | Rust-backed |
| --- | ---: | ---: |
| First search, one sample | 283.812 ms | 426.462 ms |
| Repeated search median | 281.878 ms | 3.764 ms |
| Empty begin/end batch | 857.828 ms | 0.299 ms |
| Add 200 vectors in a batch | 1518.190 ms | 268.866 ms |

Repeated search was **74.9x** faster locally. Most of the gain is avoiding repeated
JSONL parsing; the first load still pays to build the native index and is slower.
Subsequent no-op batches no longer rewrite the entire file. Non-batch writes and
changed batch flushes still rewrite JSONL and create a backup; this is not a WAL
or a vector database, and indexing API latency is unaffected.

Reproduce:

```powershell
npm run build:memory-store
npm run bench:memory-store -- 6887521
```

## Verification and deployment

- Full repository regression: 106 JS test files, zero failures (221.2 seconds).
  The final typed-array transfer, deployment and complete-file boundary additions
  are also covered by the focused memory suite.
- Five Rust tests cover stable top-k, UTF-16 sparse terms, prefix replacement,
  backups/staging failure and stale-writer rejection.
- JS integration compares random dense and sparse results to the old similarity
  function, including ties, zero vectors, unequal dimensions, legacy duplicate
  IDs, unusual k values, Unicode and external edits/corruption.
- Persistence tests cover backup contents, failed serialization/staging, external
  write conflicts, a child killed with an unflushed batch, failed reindexing,
  source edits during embedding and final flush failure propagation.
- A temporary deployment refuses a missing module before copying, then saves and
  searches successfully from a profile path containing spaces.
- Rustfmt, Clippy and repository sanity checks run locally. The Windows binary
  depends only on Windows system DLLs, with no separate VC runtime dependency.

Build with Rust and platform linker tools. Ship
`plugins/dsh-memory/bin/<platform>-<Node architecture>/memory-store.node` with the
plugin, then restart DSH/MCP. `DSH_MEMORY_STORE_NATIVE` can override that path.
Windows x64 is tested; Linux GNU/macOS targets are offered by the build script
but not validated. Remote CI has not been run and no live profile was deployed.

New writers coordinate through a persistent `<namespace>.jsonl.lock` file with
bounded lock waits. Stale pending batches fail rather than overwrite another
writer; callers may abort/reload and retry. Legacy versions do not honor that
lock, so upgrade all writers together. Replacement is atomic per JSONL file;
pending unflushed work is lost on process exit, while published generations
remain readable. This does not promise a multi-file or power-loss transaction.
