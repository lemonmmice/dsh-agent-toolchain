# Changelog

All notable changes to dsh-agent-toolchain are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Compatibility: see [docs/compatibility.md](./docs/compatibility.md).

## [Unreleased]

### Added

- **dsh-ui-drive: dynamic-UI driving primitives (login / captcha / branch-on-screen)** —
  driving a real client is not "click a few buttons": the agent must log in, then keep
  acting on what the screen shows. Two independent external reviews (Claude Code +
  Codex/GPT-6 Astra) audited the driver against that bar and named three P0 gaps;
  all three are now implemented and measured on a real client and on a local
  no-network WPF login host.
  - **Cross-window primitives** — the login window is a *different top-level window*
    from the main window, and this client shows no success dialog, so "did login
    succeed" is a window-level question the old subtree-only `waitfor` could not
    express. New read-only actions: `expectwindow` (title regex appear/gone),
    `expecttext` (scan every window's Text/Edit values, e.g. `ErrorInfo`), `waitany`
    (race several conditions at once — success / error / still-here — and return which
    branch hit, with `stableCount` confirmation against transient states), plus
    `winTitle`/`winHandle` scoping on find/read/waitfor.
  - **Input correctness — no more silent success** — the target login page's phone box
    sets `e.Handled = true` for every key except digits, so `key`'s clipboard paste is
    swallowed *while still reporting ok*. Now `setvalue` (ValuePattern, bypasses key
    filtering) is the path for restricted fields, `key`/`type`/`setvalue` read the
    control value back and fail loudly on mismatch, and `type` sends printable ASCII
    through `keybd_event`/`VkKeyScan` instead of `SendKeys` (which silently typed
    nothing on the test host until this fix).
  - **Credential isolation** — `value: "${cred:name}"` is expanded inside the driver
    process from `DSH_CRED_name`, so the secret never enters the model context, the
    step file or the evidence; password/captcha controls report only `<secret:Nchars>`;
    `secret=true` (or a placeholder) masks the value in output.
  - **Hard deny (driver-level, not a prompt)** — buy/sell/order/commission/pay/withdraw
    controls are rejected by name/AutomationId match even with `allowSideEffects=true`.
  - New actions `state` (window + focused element + interactive-control snapshot,
    `#index` reusable as `index`), `windows` (all top-level windows), `type`
    (`{ENTER}`/`{TAB}` sequences), `drag` (slider captcha); `index` / `inAid` /
    `inName` targeting; `waitFor` on any action; `observe:true` on any side-effecting
    action returns the post-action snapshot; `click` dispatches by pattern
    (Invoke / Toggle / SelectionItem, then mouse) and refuses disabled controls.
  - Semantic tool split for agents: `ui_observe` (read-only) and `ui_act` (side
    effects) on both the DSH and MCP surfaces; `ui_windows` / `ui_state` exposed
    directly; `ui_drive` kept as the generic entry point.
  - Hang-inspector is now on the MCP surface too: `hang_status` / `hang_run` /
    `hang_stop` / `hang_packs` / `hang_pack` / `hang_analyze` / `hang_delete`
    (`plugins/dsh-hang-inspector/lib/hang.mjs` is the shared core; the panel routes
    are a thin transport over it).
  - Warm serve self-heals on script edits (`ScriptStamp`): a stale persistent process
    exits and the Node side respawns with the new script.
  - Tests: `flow-batch.test.mjs` covers action-name normalisation, the new step fields,
    `waitfor` as an assertion, and batch routing for the new actions;
    `plugins/dsh-win-terminal-inspector/test/inspector.test.mjs` no longer requires
    Git Bash (node-spawned process tree), so it runs in restricted environments too.

### Changed

- **dsh-ui-drive: UI driving is now real-time (3 layers)** — the old design
  spawned a fresh PowerShell per action (process start + script parse + 5 UIA
  assembly loads ≈ 900ms fixed cost per step), so a 10-step flow took ~9s and
  "click a control and see it react" was impossible.
  - `ui_flow` runs the whole step sequence inside ONE process
    (`scripts/ui-drive-batch.ps1 -StepsFile`): assemblies loaded once, main
    window resolved once, no per-step process cost. Measured on a 13-step
    read-only flow: **11.9s → 1.6s (7.6x)**.
  - `ui_drive` uses a persistent warm PowerShell in serve mode (`-Serve`,
    line-delimited JSON over stdin/stdout, ASCII-escaped protocol): startup is
    paid once, then each action costs only the UIA call. Measured p50:
    **886ms → 30ms (~30x)**. The process self-recycles on idle
    (`DSH_UI_SERVE_IDLE_MS`, default 5 min), is reclaimed on plugin unload, and
    `DSH_UI_SERVE=0` falls back to the one-shot path.
  - `ui_status` gets a UIA-free fast path (`-Status`): **~1000ms → ~400ms**.
  - Default `waitMs` 1200 → 250ms; `find`/`read`/`shot`/`expect` steps no
    longer pay a meaningless post-action sleep.
  - `find` now uses UIA native `FindAll` + `AndCondition` instead of a manual
    full-tree walk loop.
  - New offline unit test `plugins/dsh-ui-drive/test/flow-batch.test.mjs`
    (batch engine, guard rails, step-file whitelist, failure degradation) wired
    into CI.
  - Fixed: `driver.status()` never passed `-ProcName`/`-WindowName` to the
    script, so `ui_status` reported "not running" for a running client and
    `ui_launch` re-launched on top of it.

### Fixed

- **scripts/check.mjs: repo gate crashed with `RangeError: Maximum call stack
  size exceeded`** — the walker recursed into `bench-runs/` (per-run repo
  clones: 100k+ files, 19k+ dirs) before the local-only filter could skip it.
  The walker is now iterative and prunes local-only trees at the directory
  level; section 4 still guards them via `git ls-files`.

### Added

- **UI-driven benchmark tasks (home turf)** — the harness now supports tasks
  whose hidden verification is a UIA probe: `verify.patch` adds a minimal WPF
  host + probe script, `verifyCommand` builds/launches/asserts the rendered
  UI, and `config.json` declares `agentEnv` (`DSH_UI_PROC_NAME`,
  `DSH_UI_WINDOW_NAME`, …) that the harness injects into both the agent
  process and the toolchain MCP server (so `ui_status` / `ui_drive` can see
  the host app the agent launches). Documented in
  [bench/README.md](./bench/README.md).
- **gate vacuous-fail detail** — `verify_report kind=gate` now names WHICH
  zero-test pattern matched (`no-test-matches (EN/CN)` / `0-of-0-tests` /
  `0/0 summary`) and keeps the full 6-line / 400-char failure tail on the
  vacuous branch instead of a bare 2-line stub — the verdict is auditable.
- **msbuild engine generalization** — the msbuild engine no longer hardcodes
  the legacy client defaults. A repo containing `WholeSolution.sln` keeps the
  old behavior byte-for-byte (default target `WholeSolution.sln`, platform
  `x86`); any other repo gets `.sln`/`.slnx` auto-detection (root, then one
  level deep, skipping bin/obj/.git/node_modules/…) and platform detection
  from the solution file itself (`Any CPU` preferred, then
  `Mixed Platforms`, then `x86`). Ambiguity is an explicit error listing the
  candidates — never a guess. Shared logic in `lib/build-resolve.mjs` with
  its own CI unit test (`lib/build-resolve.test.mjs`); `repoRoot` /
  `DSH_BUILD_REPO_ROOT` / `DSH_BUILD_PLATFORM` accepted by both the DSH tool
  and the MCP tool.
- **msbuild engine always restores** — MSBuild.exe does not restore
  implicitly (unlike `dotnet build`), so SDK-style projects used to fail
  with NETSDK1004 (missing assets file); the engine now always passes
  `/restore` (a no-op for legacy packages.config projects).
- **SDK-resolution error chains parsed honestly** — six-letter code prefixes
  (`NETSDK1004`, `NETSDK1045`, …) now parse (the old regex only allowed five
  letters); the embedded-code form `file : error : MSB4276: …` is extracted
  from SDK-resolution prose chains while pure-prose lines stay out of the
  structured list (MSBuild's own summary does not count them — count parity
  holds); MSB4236/MSB4276/NETSDK1004/NETSDK1045/NU1301 now classify as
  environment errors, so a repo missing the .NET SDK or a targeting pack
  reports `blockedByEnvironment` instead of pretending it is a code bug.
- **Benchmark pilot harness** — `bench/harness/bench.mjs` runs one real coding
  task against an external agent CLI in two modes (`baseline` = built-in tools
  only, `toolchain` = built-in tools plus the dsh-agent-toolchain MCP server),
  then verifies the agent's patch in a clean checkout against the task's
  hidden verification patch. Metrics: turns / tokens / cost / verified →
  cost-per-verified-task. Task packages stay local-only (`bench/tasks/`,
  gitignored) for privacy and answer secrecy; `scripts/check.mjs` gains a
  git-tracked gate that hard-fails if they ever get committed. See
  [bench/README.md](./bench/README.md).
- **`build_run` dotnet engine + honest error parsing** — `engine=dotnet`
  (`DSH_BUILD_ENGINE`) builds SDK-style repos with `dotnet build`
  (restore-by-default, Any CPU, `NuGetAudit=false`); the parser now captures
  positionless errors (`MSBUILD : error MSB1009`, `Foo.csproj : error
  NU1301`) so `ok:false` never comes back with an empty structured list, and
  the summary line falls back to the parsed counts. `lib/build-parse.test.mjs`
  wired into CI.
- **Shared GBK-aware output decoder** — `lib/decode.mjs` (UTF-8 first, GBK
  fallback) now backs both the build runner and the ui-drive driver, so
  PowerShell/MSBuild errors on CN-locale Windows are no longer mojibake; the
  corpus no longer stores undecodable garbage. `ui_status` reports an explicit
  `unconfigured` state.

### Changed

- **Pilot 3 — home-turf task (UI-driven verification)** — the first task whose
  hidden check is a UIA probe (WPF host + live-window assertion). First MCP
  tool usage across all pilots: the toolchain agent called `ui_status` ×2 and
  `ui_drive` ×3 to verify the rendered control text — on a task where the bug
  is only observable in a live window. baseline $1.51/31 turns vs toolchain
  $2.84/41 turns (cap hit, still verified); `build_run` still unused. See
  [bench/pilot/report.md](./bench/pilot/report.md) §13.
- **Review round 4 fixes** — fresh adversarial review returned SATISFIED with
  0 must-fix and 4 should-fix, all reproduced and fixed: `verify kind=api`
  no longer passes `expect.min ≤ 0` with zero evidence; the vacuous-gate
  catches the .NET "no test containers" / "Tests run: 0" / "OK (0 tests)"
  wordings; the bench harness gained a runtime vacuous-output guard and
  `patchedTests` now downgrades `verified`; `/source/open` rejects
  cross-drive paths and quotes its `start` targets.
- **dsh-verify boot-crash fix** — `verify_report`'s `context` parameter was
  `{ type: 'object' }` without `additionalProperties`, which makes
  `defineTool` throw at boot and crash-loops the host (watchdog relaunch
  every 3s; `Restart-DSH` cannot cure a boot-time crash). Now spreads the
  `OBJECT` const. A new static guard in `scripts/check.mjs` hard-fails CI on
  the same single-line pattern (`key: { type: 'object', … }` missing
  `additionalProperties`), so the class cannot regress.
- **Review round 2 must-fixes** — `build_run` no longer double-counts
  MSBuild's twice-printed errors (dedupe on file,line,col,code; errorCount now
  agrees with the summary line on both engines), and `memory_index` no longer
  wipes legacy relative-path chunks on the first post-upgrade call (eviction
  skips non-absolute stored paths) while `DSH_MEMORY_DIR` is now actually
  honored. External reviewer re-verified both and closed with SATISFIED.
- **Pilot 2 (3 tasks)** — neutral prompts (no prescribed shell commands),
  WebSearch/WebFetch hard-blocked, hardened MCP-visibility probe (3 retries +
  `--mcp-debug` evidence). Result, now replicated across 3 tasks: every run
  verified, and the toolchain MCP was connected-visible but **never called**
  (0 `mcp__*` tool uses); cost-per-verified-task baseline $1.40 vs toolchain
  $1.44. Conclusion recorded in [bench/pilot/report.md](./bench/pilot/report.md):
  task shapes must match the tool — the toolchain's home turf is desktop-client
  work, not SDK-library bugfixes.
- **gate failure detail** — `verify_report kind=gate` keeps the last 6 lines /
  400 chars on failure (was 2 lines / 120), enough to see the failing
  assertion.
- **build blocked-by-environment** — a failed build with zero code errors but
  environmental errors (targeting packs, restore, locks) now returns
  `blockedByEnvironment: true` plus an explicit `error` line instead of a bare
  `ok:false` with empty `errors[]`.
- **Honest platform scope** — [mcp/README.md](./mcp/README.md) and the root
  README now state which tools are Windows-only (UI driving, VS MSBuild
  engine) and which are cross-platform (evidence spine, `dotnet` engine).
- **`memory_recall` flat shape (MCP)** — returns `{found, key, value, scope}`;
  the DSH-side tool already did.
- **`perf` PowerShell env override** — `DSH_PERF_POWERSHELL` (falling back to
  `DSH_UI_POWERSHELL`) replaces the hard-coded path.
- **dsh-verify registered in the DSH profile** (local deploy) — closing
  adjudication goes live in DSH sessions on next host restart.

- **`verify_report kind=gate` rejects vacuous passes** — exit 0 alone no
  longer adjudicates `pass` when the output shows zero tests executed
  (a filter matching nothing exits 0); that run now fails with
  "exit 0 but no tests executed". 3 new unit tests.
- **`memory_index` multi-root safety + egress disclosure** — chunk keys carry
  absolute paths and eviction judges disk existence only (indexing project B
  no longer wipes project A); the fail-closed sensitive filter now also runs
  on the index path (offending files are skipped before embedding, counted as
  `sensitiveSkipped`); `memory_status`, the MCP tool descriptions and the
  README disclose that embedding uses the remote `api.minimax.chat` endpoint
  when a MiniMax key is configured (unset the key for local-only bigram mode).

- **Failure corpus v0** — `lib/failure-corpus.mjs` (framework-free record /
  query / stats, fixed 7-class taxonomy, 20 MB rotation) + MCP tools
  `failure_record` / `failure_query` / `failure_stats` + idempotent seed
  script. Every human handoff, verification failure, or agent misjudgment now
  lands in one local JSONL line — the data flywheel behind the roadmap. See
  [docs/failure-corpus.md](./docs/failure-corpus.md).
- `lib/failure-corpus.test.mjs` unit test wired into CI.
- **dsh-memory hygiene** — real mtime-incremental indexing (unchanged files are
  skipped), stale-chunk eviction on file update or deletion, and a fail-closed
  sensitive-string filter on `memory_save` (tokens / API keys / private-key
  blocks are rejected before hitting disk). See
  [plugins/dsh-memory/README.md](./plugins/dsh-memory/README.md).
- `plugins/dsh-memory/test/memory-hygiene.test.mjs` unit test wired into CI.
- **Self-recording failure corpus** — `build_run` code errors, `ui_flow`
  assertion failures, `ui_drive` step failures, and `http_request` connection
  failures now append records automatically (tag `auto`). The corpus is
  system-observed; manual `failure_record` is reserved for what the system
  can't see (e.g. human handoffs).
- **API-capture moat exposed to MCP** —
  `lib/capture-store.mjs` (framework-free
  reader/writer of the panel's day-shard store, shared across MCP + verify) + MCP tools `capture_query` /
  `capture_append`: caller attribution (ViewModel→API→call-chain) is now
  available to any MCP client.
- **Evidence-adjudicated verification report (v1)** — `verify_report` no
  longer records agent self-rating: each claim is adjudicated from evidence
  (`build` reads the per-run build record, `api` queries the capture store,
  `file` checks existence; `manual` is the explicit opt-out). Contradicted
  claims auto-record `agent-misjudge` — the system, not the agent, decides.
- **runId spine** — `build_run(runId)` names the log and writes
  `run-<runId>.json`; `capture_append(runId)` / `capture_query(runId)` carry
  the dimension; failure-corpus and verify-reports are keyed by runId. One id
  now ties build log + captured APIs + report together. See
  [docs/verification-report.md](./docs/verification-report.md).
- `lib/capture-store.test.mjs` and
  `lib/verify/report.test.mjs` unit tests wired into CI.
- **dsh-verify shell** — the closing-summary becomes a claims list: a thin
  DSH plugin registers the same `verify_report` engine (zero logic of its
  own, guarded dynamic import) and its guidance makes "summary = claims +
  verdict" a mandatory workflow. The trigger surface is the summary action
  itself, not a remembered habit.
- **`kind=git` / `kind=gate` adjudicators** — the manual backdoor shrinks:
  git facts are checked against the authoritative source (`ls-remote`, never
  the local tracking refs that URL-token pushes leave stale — the phantom
  "ahead 5" incident); verification commands are checked by exit code. Born
  from the first external-adjudication incident, recorded in the corpus.

## [0.1.0] — 2026-09-07

First public release: the engineering-quality loop monorepo.

### Added

- **8 plugins** under `plugins/`:
  - `dsh-build` — MSBuild as an agent tool (incremental/Rebuild, structured errors)
  - `dsh-ui-drive` — Windows UIA client driver + screenshot-with-vision self-verification
  - `dsh-api-visualizer` — HTTP traffic capture panel, proxy engine, AutoResponder rules, baseline/contract regression
  - `dsh-postman` — host-side HTTP/WebSocket client with JSONL history
  - `dsh-perf` — stutter probe (SendMessageTimeout) + ClrMD dump/heap analysis
  - `dsh-hang-inspector` — hang loop + thread-stack→source mapping
  - `dsh-memory` — vector search + cross-session KV memory
  - `dsh-win-terminal-inspector` — win32 ConPTY terminal inspection
- **MCP server** (`mcp/`) — stdio server exposing 9 tools (`build_run`, `ui_status`,
  `ui_drive`, `http_request`, `memory_index/search/save/recall/status`) to any MCP
  client (Claude Code, Cursor, Cline), reusing the same framework-free `lib/` code.
- **Framework-free core extraction** — `dsh-postman/lib/http.mjs` (sendRequest),
  shared by the DSH plugin and the MCP server.
- **CI gate** (`scripts/check.mjs`) — syntax check + forbidden-private-reference scan
  + nested-dir check; runs on every push/PR.
- **Public roadmap** (`ROADMAP.md`) and architecture notes (`docs/architecture.md`).
- Apache-2.0 LICENSE, CONTRIBUTING.md.

### Security

- All environment-specific values (paths, process names, evidence dirs) moved to
  `DSH_*` environment variables with sane defaults (`~/.dsh-agent-toolchain/`).
- No hard-coded machine paths, credentials, or identifiers in the repository;
  the CI gate enforces this going forward.

