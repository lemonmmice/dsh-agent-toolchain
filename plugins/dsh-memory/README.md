# dsh-memory

Long-term memory for coding agents: document indexing + semantic search +
cross-session key-value conventions. Ships as a DeepSeek Harness plugin and
through the MCP server (`memory_index` / `memory_search` / `memory_save` /
`memory_recall` / `memory_forget` / `memory_status`).

## What it does

- `memory_index(path)` — index a directory's docs/code into a local vector
  store. **mtime-incremental**: files whose mtime is unchanged are skipped;
  updated files get their old chunks evicted and replaced; chunks of deleted
  files are removed. **Multi-root**: indexing directory B never evicts
  directory A's chunks — eviction judges file existence on disk, not the
  currently-indexed root.
- `memory_search(query, k)` — semantic search (MiniMax embo-01 vectors; falls  back to a local character-bigram index when no key is configured).
- `memory_save` / `memory_recall` / `memory_forget` — cross-session KV
  conventions, scoped per project (e.g. the project name).

## Native vector store

From the monorepo root, build with Rust and the platform linker (Windows:
Visual C++ build tools):

```powershell
npm run build:memory-store
npm run test:memory-native
node scripts/run-tests.mjs dsh-memory
```

Deploy the whole plugin including `bin/<platform>-<Node architecture>/memory-store.node`.
Consumers do not need Rust. `DSH_MEMORY_STORE_NATIVE` optionally overrides the
module path. The same adapter is used by DSH and MCP; restart both after deployment.
Windows x64 is validated; Linux GNU/macOS build targets are provided but untested.

Rust caches the vector index, computes dense/sparse similarity, selects stable
top-k hits, indexes ID prefixes and writes JSONL through staged replacement and
`.bak` backup. The JSONL file remains the source of truth; external changes cause
reloads, while conflicting unflushed batches fail instead of overwriting them.
File embedding results are published as complete files; failed reindexing keeps
the previous complete snapshot. Final flush errors reach the caller.

Local bigram Maps are serialized as objects so new vectors survive restarts.
Previously saved empty sparse objects cannot recover lost terms automatically;
reindex the source into a new project namespace if affected (unchanged-file
mtime skipping otherwise retains the old index). No user index is rewritten on
read. See [validation and timings](../../docs/memory-store-rust.md).

## Hygiene guarantees

- **Successful reindexing replaces stale chunks**: indexing a changed file replaces all of its
  previous chunks after embedding succeeds (chunks are keyed by `file:<absPath>:<mtime>`); indexing a
  workspace also evicts chunks belonging to files that no longer exist on
  disk.
  Failed reindexing retains the last complete snapshot, and search freshness
  metadata identifies changed/deleted sources.
- **Secrets never land on disk — and never leave the machine**: `memory_save`
  runs a fail-closed sensitive-string filter (GitHub tokens, OpenAI-style
  keys, AWS access keys, bearer tokens, private-key blocks, labeled secrets).
  A hit rejects the save. The **index path is screened too**: a file whose
  content trips the filter is skipped before chunking and counted as
  `sensitiveSkipped`, so it is never embedded — and therefore never sent to
  an embedding API.

## Data & privacy

- Remote embedding requests have a 20-second default timeout (`DSH_MEMORY_EMBED_TIMEOUT_MS`), covering both response headers and JSON body reading. Error responses are cancelled without exposing their bodies.
- Embedding cache names use SHA-256 over the endpoint, model and input text. Older 32-bit cache files are ignored and retained; subsequent calls populate the new cache without changing stored vectors.
- Everything lives under `~/.dsh/memory/` (override with `DSH_MEMORY_DIR` /
  `DSH_HOME`).
- **Embedding egress**: when a MiniMax API key is configured
  (`MINIMAX_CN_API_KEY` or `~/.dsh/.credentials.yaml`), indexed chunks and
  search queries are embedded via the **remote** `api.minimax.chat` endpoint —
  i.e. that content leaves this machine. Without a key, embeddings fall back
  to a local character-bigram index (zero egress). `memory_status` reports the
  active endpoint, so the choice is visible, not implicit.
