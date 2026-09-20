# Architecture

dsh-agent-toolchain is a monorepo of host plugins for the DeepSeek Harness Web
GUI and shared framework-free libraries used by both DSH and MCP. Host adapters
register tools and routes; storage and other reusable behavior live behind
shared interfaces, with Rust components for selected native operations.

## Plugin anatomy

Every plugin follows the same four-part shape:

```
plugins/<name>/
├── index.js          # host entry: exports { name, inject, apply(ctx) + tool defs }
├── lib/              # framework-free core (no @deepseek-ai/dsh-tools import)
├── scripts/          # Windows PowerShell helpers (UIA drive, MSBuild, procdump...)
└── test/             # offline self-tests / smoke scripts
```

- **`index.js`** registers agent tools via `defineTool`, announces itself to the
  model via the `systemPrompt` injection (GUIDANCE), and mounts loopback-only
  Web routes (`/api/dsh-<plugin>/*`) for the GUI panel.
- **`lib/*.mjs`** contain framework-free logic (driver, parser, store) that can be unit
  tested without DSH — this is the testable seam.
- **`scripts/*.ps1`** do the actual Windows work (UIA via PowerShell,
  MSBuild via process spawn, procdump/DumpStack via file paths).
- **`test/`** offline scripts with hard-coded-free env configuration.
- **`native/`** holds Rust components. The process-table helper is an executable;
  capture storage is an in-process Node-API module behind `lib/capture-storage.mjs`.
  DSH and MCP share the capture storage/index implementation. Generated binaries
  ship under each plugin's `bin/`, while build caches stay outside the plugins.
  Memory's Node-API module holds resident dense/sparse vectors and stages JSONL
  replacements; its JS adapter retains JSON compatibility and embedding policy.
  Trace folding uses native asynchronous tasks for bounded event scanning and
  stack aggregation; process regular expressions and final report shaping stay
  in JS. The same open file is checked for changes across the two trace passes.

## How the pieces compose (the loop)

| Stage | Plugin | Agent capability added |
| --- | --- | --- |
| 1. Code changed | dsh-build | compile-proof the patch (`build_run` → structured errors → fix → rebuild) |
| 2. Run it | dsh-ui-drive | `ui_launch` + screenshot-with-vision: know the app got to the expected page |
| 3. Verify behavior | dsh-api-visualizer | see the HTTP traffic the page fired, attribute to ViewModel/API, replay/contract-diff |
| 4. Debug ad-hoc | dsh-postman | `http_request` server-side (no CORS) for endpoint questions |
| 5. Observe quality | dsh-perf / dsh-hang-inspector | stutter stats (P50/P95/P99), dump analysis, hang thread → source mapping |
| 6. Don't regress | dsh-memory | vector search + cross-session conventions |

## Environment contract

All plugins read the same naming convention: `DSH_<PLUGIN>_<SETTING>` env vars
override defaults; **no absolute machine paths and no credentials in code**.
Evidence/tool dirs default under `~/.dsh-agent-toolchain/`.

## Safety model

- GUI panels: loopback-only (127.0.0.1) routes; no external callback.
- Side-effect agent tools (`click`/`setvalue`/`key` in ui-drive, build
  `killClient`, capture stop/rotate) require explicit opt-in parameters;
  read-only paths are always available.
- The systemPrompt GUIDANCE layer adds soft constraints (confirm before
  save/delete/export; never trade).

## CI gate

`scripts/check.mjs` blocks on three things: JS syntax errors, forbidden
environment-specific references (company identifiers, internal paths, personal
scopes), and nested `.git`/`node_modules` that would break the repo as a unit.
