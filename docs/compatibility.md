# Compatibility matrix

How to read this: a cell says which versions of a component are known to work
with which harness. Cells marked *(verified)* were exercised on a real machine;
everything else is by API surface.

## Harness compatibility

| dsh-agent-toolchain | DeepSeek Harness host | `@deepseek-ai/dsh-tools` | Node |
| --- | --- | --- | --- |
| 0.1.0 | `0.1.2-alpha.4` *(verified)* | `0.0.1-rc.1` *(verified)* | 22+ *(verified on 24)* |
| 0.2.0 | `0.2.0-rc.2` *(deployed restart pending)* | host SDK + `0.0.1-rc.1` test profile *(verified)* | `24.15.0` *(verified, Windows x64)* |

The plugins use only the public plugin surface (`defineTool`, `inject`, loopback
web routes); they do not patch harness internals (except
`dsh-win-terminal-inspector`, which wraps the documented `terminalInspector`
test hook and is guarded + reversible).

## Plugin compatibility (0.2.0)

| Plugin | Depends on | Notes |
| --- | --- | --- |
| dsh-build | — | Needs `DSH_BUILD_CLIENT_ROOT`/`DSH_BUILD_REPO_ROOT`; MSBuild auto-detected (VS path / vswhere). Defaults auto-resolve by repo layout (legacy `WholeSolution.sln`+x86 preserved; stock repos get .sln/.slnx + platform detection) |
| dsh-ui-drive | — | Needs `DSH_UI_PROC_NAME` / `DSH_UI_WINDOW_NAME`; `DSH_SNOOP_DIR` for ui_tree |
| dsh-api-visualizer | — | Panel package (`@dsh-agent-toolchain/dsh-api-visualizer`), `node-forge` |
| dsh-postman | — | Panel package, `@grpc/grpc-js` for gRPC helper |
| dsh-perf | procdump + DumpStack (external tools) | Shares `DSH_UI_PROC_NAME` with ui-drive |
| dsh-hang-inspector | hang-loop.ps1 + DumpStack (external tools) | Shares evidence dir conventions with ui-drive |
| dsh-memory | MiniMax `embo-01` embeddings (optional) | Falls back to local bigram search without a key |
| dsh-win-terminal-inspector | Git Bash (optional path rewrite) | Windows-only |

## MCP server (0.2.0)

| Client | Status |
| --- | --- |
| Claude Code 2.1.x | *(verified: registered, connected, tools listed)* |
| Claude Code 2.1.175 plugin | strict manifest validation and hook subprocess tests *(verified)* |
| Codex CLI 0.154.0 | rollout parser and Stop schema *(verified)*; fresh-session hook execution *(unverified)* |
| MCP SDK 1.30.0 | stdio: 55 tools registered, read-only execution *(verified)* |
| Cursor / Cline / any MCP stdio client | by MCP protocol (2024-11-05) |

MCP tools map onto the same `lib/` modules as the DSH plugins; behavior and
safety guardrails (e.g. `allowSideEffects` for UI side effects) are identical.

## 0.3.0 (2026-11-11)

Not re-verified as a whole since 0.2.0. What changed against the rows above:

- 64 tools are registered (`lib/tool-registry.mjs`); 0.2.0 had 55.
- The Stop-hook parts of the rows above (Codex rollout parser and Stop schema) no longer
  apply: the closing-verdict Stop hook was removed on 2026-11-04. `hooks/stop-gate.mjs`
  stays only as a no-op, so a host that cached the old reference does not fail.
- The optional Rust MCP runtime (`npm run build:runtime`) is new since 0.2.0; its validation
  record is [native-runtime-validation.md](./native-runtime-validation.md).

## Versioning policy

- Monorepo tags follow SemVer (`vX.Y.Z`); all plugins ship at the tag version.
- `CHANGELOG.md` records every release; breaking changes bump major (before 1.0.0, the minor
  version).
- A harness/plugin pair not listed here is *unverified*, not *broken* — if you
  run it successfully, a PR adding the row is welcome (see CONTRIBUTING.md).
