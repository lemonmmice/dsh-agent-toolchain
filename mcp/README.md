# dsh-agent-toolchain MCP server

The same engineering-quality tools the DSH plugins expose — now available to **any MCP client** (Claude Code, Cursor, Cline, custom agents) over stdio.

## Responsiveness and diagnostics

Requests carrying `_meta.progressToken` receive `notifications/progress` at
dispatch, every two seconds while asynchronous work remains pending, and when
the call finishes. Messages contain only the tool name, state and elapsed time;
they are liveness notifications, not completion percentages. Clients without a
progress token retain ordinary request/response behavior. Display depends on
the MCP client. Synchronous work can delay timer notifications.

`jev_decide` is an optional advisory decision tool. It sends the supplied
`stateJson` and `questionsJson` to TypeSafe only when the call includes
`allowRemoteData=true`; without that flag it returns immediately without a
network request. Set `TYPESAFE_API_KEY` in the MCP process environment and pin
`model` to `jev-1.13.0` when thresholds depend on model behavior. The tool never
executes the selected action and does not replace UI approval, snapshot
freshness, build verification, or evidence adjudication. Keep inputs small and
脱敏; Jev's primary language is English and its current model has known weak
spots for arithmetic, dates, long irrelevant state, and adversarial content.

Blocked actions, missing evidence packs and rejected writes return `isError:true`
with JSON `{ok:false,errorCode,error}`. HTTP non-2xx responses remain successful
transport observations; inspect their `status` separately. MCP request
cancellation now aborts `http_request`, including response-body reading.
Cancellation of an HTTP request does not prove that the remote server undid it.
Other tools retain their existing per-operation timeouts and stop controls.

`DSH_OUTPUT_MAX_TOKENS` remains opt-in. When positive, all text blocks share the
estimated token budget, including a truncation notice. Truncated JSON is a valid
`{outputBudget:{truncated:true,originalFormat:"json"},previewText:...}` envelope,
not the original complete payload. Tiny budgets report their minimum metadata
overhead. Images, resources and `structuredContent` are preserved outside this
text budget; narrow large queries at their source whenever possible.

`node mcp/probe.mjs --seq '[["memory_status",{}],["failure_stats",{}]]'`
executes calls in order in one session, shows progress on stderr, and stops with
exit code 1 on a failed call. It does not print request arguments.

Run `npm run bench:mcp -- --output bench-runs/mcp-benchmark.json` to measure
startup/discovery, repeat-call latency, response size and first feedback using
temporary stores and a loopback HTTP fixture. The benchmark disables environment
fallback; its unconfigured UI timings are not live application timings.
See [the evaluation](../docs/agent-toolchain-evaluation.md) for measurements and
remaining limitations.

## Platform scope (honest)

The MCP transport and the evidence spine are cross-platform, but the tool set is not:

| Tools | Scope |
| --- | --- |
| `failure_*`, `http_request`, memory KV save/recall/forget | cross-platform (Node stdlib / HTTP only) |
| `memory_index`, `memory_search`, `memory_status` | require the memory-store Node-API module built for the current platform/architecture; Windows x64 validated |
| `capture_*`, API evidence in `verify_report` | require the capture-store Node-API module built for the current platform/architecture; Windows x64 validated, Linux/macOS builds supported by the build script but not yet validated |
| `build_run` | cross-platform with `engine=dotnet` (SDK-style repos); the default `engine=msbuild` is Windows/VS only |
| `ui_status` / `ui_windows` / `ui_state` / `ui_drive` / `ui_flow` / `ui_replay` | **Windows only** — they drive a Windows desktop client via PowerShell + UIA |
| `perf_probe` / `perf_report` | **Windows only** — window-message latency sampling of the same client |
| `hang_status` / `hang_run` / `hang_stop` / `hang_packs` / `hang_pack` / `hang_analyze` / `hang_delete` | **Windows only** — hang-monitor control, evidence packs, ClrMD dump analysis |

On macOS/Linux the UI-driving half is inert and `ui_status` reports
`unconfigured`; the evidence spine and the dotnet build engine keep working.

## Why

The toolchain's `lib/` modules are framework-free by design. This thin MCP server
re-uses them directly (no duplication), so one set of battle-tested tools powers
every agent, not just DeepSeek Harness.

## Tools

| Tool | Backed by | Notes |
| --- | --- | --- |
| `build_run` | dsh-build/lib/builder.mjs | Incremental/Rebuild MSBuild with structured errors |
| `ui_status` / `ui_drive` / `ui_flow` / `ui_replay` | dsh-ui-drive/lib/driver.mjs | Signed app identity, scoped approvals, desktop-state gates, action/observation records, identity-bound replay and opt-in visual fallback; guarded flows validate each action |
| `perf_probe` / `perf_report` | dsh-perf/lib/perf.mjs | Window-message latency sampling: P50/P95/P99 + stall events |
| `http_request` | dsh-postman/lib/http.mjs | Host-side HTTP (no CORS), non-2xx is a normal result |
| `memory_index` / `memory_search` / `memory_save` / `memory_recall` / `memory_status` | dsh-memory/lib/memory.mjs | Vector search + cross-session KV |
| `failure_record` / `failure_query` / `failure_stats` | lib/failure-corpus.mjs | Local-only JSONL failure corpus: record handoffs/failures, query, stats |
| `capture_query` / `capture_append` | lib/capture-store.mjs | Query/append the API-capture store — caller attribution (ViewModel→API→call-chain) + runId spine |
| `verify_report` | lib/verify/report.mjs | Claims adjudicated from evidence (build/api/file checks, manual opt-out) → verdict; contradictions auto-record as agent-misjudge |
| `jev_decide` | lib/jev-client.mjs | Optional remote typed decisions; advisory only, explicit remote-data opt-in |

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
| `DSH_BUILD_CLIENT_ROOT` / `DSH_BUILD_REPO_ROOT` | build_run | repo root (or pass `clientRoot`/`repoRoot` per call) |
| `DSH_BUILD_PLATFORM` | build_run | override the auto-resolved platform (`x86` / `Any CPU` / …) |
| `DSH_BUILD_MSBUILD` | build_run | explicit MSBuild path (auto-detect otherwise) |
| `DSH_MEMORY_DIR` | memory tools | data dir (default `~/.dsh/memory`) |
| `MINIMAX_CN_API_KEY` | memory_search | MiniMax embeddings (falls back to local bigram search) |
| `DSH_FAILURE_CORPUS_DIR` | failure tools | corpus dir (default `~/.dsh-agent-toolchain/failure-corpus`) |
| `DSH_API_CAPTURE_STORE` | capture tools | capture store dir (default `~/.dsh/api-capture`, shared with the panel) |
| `DSH_VERIFY_DIR` | verify_report | report dir (default `~/.dsh-agent-toolchain/verify-reports`) |
| `TYPESAFE_API_KEY` | jev_decide | TypeSafe API key; used only when `allowRemoteData=true` |

## Run standalone

Build memory indexing/search from the repository root with
`npm run build:memory-store`. Keep `plugins/dsh-memory/bin/` with the checkout.
KV-only operations remain implemented in JS.

Build capture storage from the repository root before using capture tools or API
verification: `npm run build:capture-store` (Rust plus the platform linker).
The resulting module lives under `plugins/dsh-api-visualizer/bin/`; keep it with
the checkout. Module loading is lazy, and missing binaries produce an explicit
build instruction rather than an empty capture result.

```bash
cd mcp && npm install && node server.mjs   # waits for JSON-RPC on stdin
```

## Pass the env explicitly (gotcha)

The MCP SDK's `StdioClientTransport` inherits only a safe-list of variables
(`PATH`, `HOME`, …) — **not** `DSH_*`. If you drive the server from your own
Node script, pass `env: { ...process.env, DSH_UI_PROC_NAME: '…' }` to the
transport; a client config (Claude Code `mcp-config.json`, Codex
`*.config.toml`) declares the variables in its own `env` block, which is what
the bench harness does. Symptom when you forget: `ui_status` reports
`unconfigured`, `build_run` fails with `ENOENT: mkdir ''`.

## Safety model

Same guardrails as the DSH plugins: side-effect UI actions are blocked unless
`allowSideEffects=true` is passed explicitly, and the description of every
side-effect tool tells the model to confirm with the human first.
