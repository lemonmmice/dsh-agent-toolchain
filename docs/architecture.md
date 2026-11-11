# Architecture

dsh-agent-toolchain is a monorepo of host plugins for the DeepSeek Harness Web
GUI and shared framework-free libraries used by both DSH and MCP. Host adapters
register tools and routes; storage and other reusable behavior live behind
shared interfaces, with Rust components for selected native operations.

## Plugin anatomy

Every plugin follows the same three-part shape:

```
plugins/<name>/
├── index.js          # host entry: exports { name, inject, apply(ctx) + tool defs }
├── lib/              # framework-free core (no @deepseek-ai/dsh-tools import)
└── scripts/          # Windows PowerShell helpers (UIA drive, MSBuild, procdump...)
```

- **`index.js`** registers agent tools via `defineTool`, announces itself to the
  model via the `systemPrompt` injection (GUIDANCE), and mounts loopback-only
  Web routes (`/api/dsh-<plugin>/*`) for the GUI panel.
- **`lib/*.mjs`** contain framework-free logic (driver, parser, store) that runs
  without DSH — the seam that keeps plugins thin.
- **`scripts/*.ps1`** do the actual Windows work (UIA via PowerShell,
  MSBuild via process spawn, procdump/DumpStack via file paths).
- **`native/`** holds Rust components. The process-table helper is an executable;
  capture storage is an in-process Node-API module behind `lib/capture-storage.mjs`.
  DSH and MCP share the capture storage/index implementation. Generated binaries
  ship under each plugin's `bin/`, while build caches stay outside the plugins.
  Memory's Node-API module holds resident dense/sparse vectors and stages JSONL
  replacements; its JS adapter retains JSON compatibility and embedding policy.
  Trace folding uses native asynchronous tasks for bounded event scanning and
  stack aggregation; process regular expressions and final report shaping stay
  in JS. The same open file is checked for changes across the two trace passes.
- **`lib/`** at the repo root is shared by every plugin and by the MCP server.
  `tool-registry.mjs` defines each tool once and generates both faces, including
  the MCP approval annotations; `task-service.mjs` / `task-tools.mjs` run long
  tools in the background behind a `jobId`; `output-budget.mjs` bounds MCP
  output; `harness/` is the Harness² core. `verify/` and `failure-corpus.mjs`
  are the internal verification engine and failure store — since 2026-11-04
  neither has an agent-callable tool.

## How the pieces compose (the loop)

| Stage | Plugin | Agent capability added |
| --- | --- | --- |
| 0. Check the setup | dsh-verify | `toolchain_status`: what is configured, from which source, and what cannot be checked |
| 1. Code changed | dsh-build | compile-proof the patch (`build_run` → structured errors → fix → rebuild) |
| 2. Run it | dsh-ui-drive | `ui_launch` + a window screenshot the calling model reads: know the app got to the expected page |
| 3. Verify behavior | dsh-api-visualizer | see the HTTP traffic the page fired, attribute to ViewModel/API, replay/contract-diff |
| 4. Debug ad-hoc | dsh-postman | `http_request` server-side (no CORS) for endpoint questions |
| 5. Observe quality | dsh-perf / dsh-hang-inspector | stutter stats (P50/P95/P99), dump analysis, hang thread → source mapping |
| 6. Don't regress | dsh-memory | vector search + cross-session conventions |
| 7. Keep a lesson (optional) | dsh-verify (Harness²) | `harness_trial` / `harness_experience`: propose → probe → compose under a frozen check; a validated lesson is applied as a project skill |

## Environment contract

All plugins read the same naming convention: `DSH_<PLUGIN>_<SETTING>` env vars
override defaults; **no absolute machine paths and no credentials in code**.
Evidence/tool dirs default under `~/.dsh-agent-toolchain/`.

## Safety model

- GUI panels: loopback-only (127.0.0.1) routes; no external callback.
- Side-effect agent tools (`click`/`setvalue`/`key` in ui-drive, build
  `killClient`, capture stop/rotate) require explicit opt-in parameters;
  read-only paths are always available.
- Every tool carries MCP approval annotations generated from the registry
  (read-only, destructive, open-world). UI actions are also checked against
  snapshot freshness, an optional deny policy and a global kill switch, and an
  action whose outcome is unknown is never retried — see
  [ui-drive-safety-boundary.md](./ui-drive-safety-boundary.md).
- The systemPrompt GUIDANCE layer adds soft constraints (confirm before
  save/delete/export; never trade).

## Repo gate

`scripts/check.mjs` (`npm run check`) blocks on six things: JS syntax errors,
forbidden environment-specific references (company identifiers, internal paths,
personal scopes), nested `.git`/`node_modules` that would break the repo as a
unit, tracked files under the local-only benchmark paths, tool schemas that
`defineTool` would reject at plugin load, and `.ps1` files without a UTF-8 BOM.
The unit-test suite and CI workflow were removed on 2026-11-04, so this gate is
currently the only automated check.
