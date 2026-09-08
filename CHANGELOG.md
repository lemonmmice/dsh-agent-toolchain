# Changelog

All notable changes to dsh-agent-toolchain are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Compatibility: see [docs/compatibility.md](./docs/compatibility.md).

## [Unreleased]

### Added

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

