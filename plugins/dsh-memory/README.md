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

## Hygiene guarantees

- **Stale chunks never linger**: indexing a changed file replaces all of its
  previous chunks (chunks are keyed by `file:<absPath>:<mtime>`); indexing a
  workspace also evicts chunks belonging to files that no longer exist on
  disk.
- **Secrets never land on disk — and never leave the machine**: `memory_save`
  runs a fail-closed sensitive-string filter (GitHub tokens, OpenAI-style
  keys, AWS access keys, bearer tokens, private-key blocks, labeled secrets).
  A hit rejects the save. The **index path is screened too**: a file whose
  content trips the filter is skipped before chunking and counted as
  `sensitiveSkipped`, so it is never embedded — and therefore never sent to
  an embedding API.

## Data & privacy

- Everything lives under `~/.dsh/memory/` (override with `DSH_MEMORY_DIR` /
  `DSH_HOME`).
- **Embedding egress**: when a MiniMax API key is configured
  (`MINIMAX_CN_API_KEY` or `~/.dsh/.credentials.yaml`), indexed chunks and
  search queries are embedded via the **remote** `api.minimax.chat` endpoint —
  i.e. that content leaves this machine. Without a key, embeddings fall back
  to a local character-bigram index (zero egress). `memory_status` reports the
  active endpoint, so the choice is visible, not implicit.
