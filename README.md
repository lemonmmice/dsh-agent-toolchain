# dsh-agent-toolchain

**The engineering runtime that makes coding agents *verifiably accountable* for their own changes.**

A suite of plugins and an MCP server for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that let a coding agent do more than write code — it can *see* the running desktop client, *measure* it, *capture* what it sends over the network, and *verify* the code it just changed. Each plugin is a small, composable building block; together they close the loop between "agent wrote a change" and "the change actually works" — and produce the evidence to prove it.

> Roadmap: [ROADMAP.md](./ROADMAP.md)

## The problem

Coding agents are excellent at producing patches, but they are blind to what happens after the patch: Did the build break? Did the UI actually render the new page? Which API calls did the client fire, and did one of them hang for 20 seconds? Did the change introduce a memory leak or a UI stall?

Traditional agents verify by reading code. This toolchain lets them verify by *observing the running application* — the same way a human QA engineer would.

## The loop

```
  change code → build (dsh-build) → drive client (dsh-ui-drive)
                                      → capture APIs (dsh-api-visualizer, dsh-postman)
                                      → inspect perf (dsh-perf) / hang (dsh-hang-inspector)
                                      → remember lessons (dsh-memory)
```

## Plugins

| Plugin | What it does for the agent |
| --- | --- |
| [dsh-build](./plugins/dsh-build/README.md) | Run MSBuild as a tool: incremental build, structured error list (file/line/col/code), error re-parse. Turns "agent wrote code" into "agent wrote code that compiles". |
| [dsh-ui-drive](./plugins/dsh-ui-drive/README.md) | Drive a running Windows desktop client via UIA: find/click/type/read/screenshot, visual-tree dumps, multi-step flows with assertions, screenshot + vision description. Lets the agent navigate to a page and *see* the result. |
| [dsh-api-visualizer](./plugins/dsh-api-visualizer/README.md) | Capture the client's HTTP traffic: live panel, JSONL store, caller attribution (ViewModel/API/call-chain), auto-responder rules, baseline/contract regression. Answers "which API did this page fire, and what came back?" |
| [dsh-postman](./plugins/dsh-postman/README.md) | Postman-style HTTP client inside the harness: compose/send requests from the host (no browser CORS), history store, WebSocket client, `http_request` agent tool. |
| [dsh-perf](./plugins/dsh-perf/README.md) | UI stutter measurement (SendMessageTimeout latency, P50/P95/P99, stutter events), full-dump capture + ClrMD analysis (UI thread stack, lock hot spots), managed-heap type stats (leak screening). |
| [dsh-hang-inspector](./plugins/dsh-hang-inspector/README.md) | One-click hang diagnosis: monitor main-window responsiveness, auto-collect evidence packs (frozen screenshot, timeline, process info, net-trace tail, dump), analyze the managed thread stack and map the hang thread to project source. |
| [dsh-memory](./plugins/dsh-memory/README.md) | Long-term memory for the harness: semantic search over indexed workspace docs, cross-session key-value conventions. Stops the agent from re-learning the same project rules every session. |
| [dsh-win-terminal-inspector](./plugins/dsh-win-terminal-inspector/README.md) | Windows terminal (ConPTY) inspection for persistent bash shells — the piece that stops the harness from throwing "terminal inspection unsupported on win32". |

## Highlights

- **One toolchain, every agent**: the same tools power the DeepSeek Harness plugins **and** any MCP client — see [mcp/](./mcp/README.md). Claude Code, Cursor, Cline can drive the client, run builds, capture APIs and search memory with the exact same `lib/` code.
- **Safety-first UI automation**: `click`/`setvalue`/`key` require an explicit `allowSideEffects=true`; read-only operations (`find`/`read`/`shot`/`expect`) are always safe. Trading entries are never clicked.
- **Honest measurement**: perf metrics come from real windows-message round trips; cost/price tables mark "unknown" instead of inventing numbers.
- **Loopback-only control APIs**: all Web routes bind to 127.0.0.1; no external callbacks.
- **Zero-drift config**: every environment-specific value (client exe name/window title, evidence dirs, tool paths, source roots) is an environment variable with a sane default — no hard-coded machines, no embedded credentials.

## Requirements

- Windows 10/11 (the client-driving and performance plugins target Windows desktop apps)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI (Node.js 20+)

## Install

Each plugin is a drop-in host plugin. Copy the plugin directory into your DSH profile's `plugins/` (or `node_modules/@dsh-agent-toolchain/` for the panels) and register it in `cordis.patch.yml`:

```yaml
- insert:
    - id: ui-drive
      name: './plugins/dsh-ui-drive/index.js'
```

Then restart the harness and set the environment variables the plugin needs (see each plugin README).

## Layout

```
plugins/
  dsh-build/                  # MSBuild as an agent tool
  dsh-ui-drive/               # UIA client driver + vision ground-truth
  dsh-api-visualizer/         # traffic capture panel + proxy engine
  dsh-postman/                # host-side HTTP client
  dsh-perf/                   # stutter probe + dump analysis
  dsh-hang-inspector/         # hang loop + dump-stack analysis
  dsh-memory/                 # vector/KV long-term memory
  dsh-win-terminal-inspector/ # win32 ConPTY inspection
mcp/
  server.mjs                  # MCP stdio server: build/ui-drive/http/memory tools
docs/
  architecture.md             # how the pieces compose
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Releases

- [CHANGELOG.md](./CHANGELOG.md) — SemVer history (Keep a Changelog format)
- [docs/compatibility.md](./docs/compatibility.md) — harness/plugin/MCP compatibility matrix

## License

Apache-2.0 (per-plugin LICENSE files mirror this).
