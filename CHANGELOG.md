# Changelog

All notable changes to dsh-agent-toolchain are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Compatibility: see [docs/compatibility.md](./docs/compatibility.md).

## [Unreleased]

### Added

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

