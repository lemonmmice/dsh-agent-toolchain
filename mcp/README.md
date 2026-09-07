# dsh-agent-toolchain MCP server

The same engineering-quality tools the DSH plugins expose — now available to **any MCP client** (Claude Code, Cursor, Cline, custom agents) over stdio.

## Why

The toolchain's `lib/` modules are framework-free by design. This thin MCP server
re-uses them directly (no duplication), so one set of battle-tested tools powers
every agent, not just DeepSeek Harness.

## Tools

| Tool | Backed by | Notes |
| --- | --- | --- |
| `build_run` | dsh-build/lib/builder.mjs | Incremental/Rebuild MSBuild with structured errors |
| `ui_status` / `ui_drive` | dsh-ui-drive/lib/driver.mjs | Windows UIA: find/read/shot read-only; click/setvalue/key need `allowSideEffects=true` |
| `http_request` | dsh-postman/lib/http.mjs | Host-side HTTP (no CORS), non-2xx is a normal result |
| `memory_index` / `memory_search` / `memory_save` / `memory_recall` / `memory_status` | dsh-memory/lib/memory.mjs | Vector search + cross-session KV |
| `failure_record` / `failure_query` / `failure_stats` | lib/failure-corpus.mjs | Local-only JSONL failure corpus: record handoffs/failures, query, stats |
| `capture_query` / `capture_append` | lib/capture-store.mjs | Query/append the API-capture store — caller attribution (ViewModel→API→call-chain) + runId spine |
| `verify_report` | lib/verify/report.mjs | Claims adjudicated from evidence (build/api/file checks, manual opt-out) → verdict; contradictions auto-record as agent-misjudge |

## Configure (Claude Code)

```bash
claude mcp add --scope user dsh-agent-toolchain -- cmd /c node <repo>\mcp\server.mjs
```

Cursor / Cline: add a stdio MCP server entry with the same command.

## Environment

Same `DSH_*` variables as the plugins:

| Variable | Used by | Required for |
| --- | --- | --- |
| `DSH_UI_PROC_NAME` / `DSH_UI_WINDOW_NAME` / `DSH_UI_CLIENT_EXE` | ui tools | driving your desktop client |
| `DSH_UI_EVIDENCE_DIR` | ui tools | screenshot/evidence dir (default `~/.dsh-agent-toolchain/ui-evidence`) |
| `DSH_BUILD_CLIENT_ROOT` | build_run | solution root (or pass `clientRoot` per call) |
| `DSH_BUILD_MSBUILD` | build_run | explicit MSBuild path (auto-detect otherwise) |
| `DSH_MEMORY_DIR` | memory tools | data dir (default `~/.dsh/memory`) |
| `MINIMAX_CN_API_KEY` | memory_search | MiniMax embeddings (falls back to local bigram search) |
| `DSH_FAILURE_CORPUS_DIR` | failure tools | corpus dir (default `~/.dsh-agent-toolchain/failure-corpus`) |
| `DSH_API_CAPTURE_STORE` | capture tools | capture store dir (default `~/.dsh/api-capture`, shared with the panel) |
| `DSH_VERIFY_DIR` | verify_report | report dir (default `~/.dsh-agent-toolchain/verify-reports`) |

## Run standalone

```bash
cd mcp && npm install && node server.mjs   # waits for JSON-RPC on stdin
```

## Safety model

Same guardrails as the DSH plugins: side-effect UI actions are blocked unless
`allowSideEffects=true` is passed explicitly, and the description of every
side-effect tool tells the model to confirm with the human first.
