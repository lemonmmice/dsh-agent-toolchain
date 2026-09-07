# dsh-memory

Long-term memory for coding agents: document indexing + semantic search +
cross-session key-value conventions. Ships as a DeepSeek Harness plugin and
through the MCP server (`memory_index` / `memory_search` / `memory_save` /
`memory_recall` / `memory_forget` / `memory_status`).

## What it does

- `memory_index(path)` — index a directory's docs/code into a local vector
  store. **mtime-incremental**: files whose mtime is unchanged are skipped;
  updated files get their old chunks evicted and replaced; chunks of deleted
  files are removed.
- `memory_search(query, k)` — semantic search (MiniMax embo-01 vectors; falls
  back to a local character-bigram index when no key is configured).
- `memory_save` / `memory_recall` / `memory_forget` — cross-session KV
  conventions, scoped per project (e.g. the project name).

## Hygiene guarantees

- **Stale chunks never linger**: indexing a changed file replaces all of its
  previous chunks (chunks are keyed by `file:<relPath>:<mtime>`); indexing a
  workspace also evicts chunks belonging to files that no longer exist.
- **Secrets never land on disk**: `memory_save` runs a fail-closed
  sensitive-string filter (GitHub tokens, OpenAI-style keys, AWS access keys,
  bearer tokens, private-key blocks, labeled secrets). A hit rejects the save
  with a message instead of storing the raw value.

## Data

Everything lives under `~/.dsh/memory/` (override with `DSH_MEMORY_DIR` /
`DSH_HOME`). Nothing is uploaded.
