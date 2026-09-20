# Contributing to dsh-agent-toolchain

Thanks for your interest in improving the agent-visible quality loop!

## Ways to contribute

- **Report a bug** — open an issue with a minimal repro (plugin, harness version, OS, env vars set).
- **Propose a feature** — describe the agent workflow gap it closes and which plugin fits.
- **Send a pull request** — for code, docs, or tests. See the checklist below.

## Development setup

```bash
git clone https://github.com/lemonmmice/dsh-agent-toolchain.git
cd dsh-agent-toolchain
node --check plugins/<plugin>/lib/*.mjs   # syntax gate (no build step required)
```
Plugins are ESM Node.js with zero runtime deps except where noted in each `package.json`.
The Windows terminal inspector also requires its Rust helper: run
`npm run build:terminal-inspector` before testing or deploying that plugin.
Build prerequisites are the Rust MSVC toolchain and Visual C++ build tools;
`npm run test:terminal-native` runs the Rust tests.
Capture storage uses a Rust Node-API module: `npm run build:capture-store`
builds it for the current platform/Node architecture, and
`npm run test:capture-native` tests the storage core without loading Node.
Memory vectors use a separate Node-API module: `npm run build:memory-store` and
`npm run test:memory-native`. Run `node scripts/run-tests.mjs dsh-memory` for
the JS adapter, indexing and persistence regressions.
CPU/allocation CSV folding uses `npm run build:trace-fold` and
`npm run test:trace-native`. Its JS differential tests run with
`node scripts/run-tests.mjs dsh-perf` against a frozen pre-migration oracle.

## Pull request checklist

1. **Target one plugin** — the repo is a monorepo of independent plugins; keep PRs focused.
2. **No environment leakage** — this repo must remain machine-agnostic:
   - never hard-code absolute paths or user home directories;
   - configure via environment variables (`DSH_*`) with sane defaults;
   - never commit API keys, tokens, or company identifiers.
3. **Syntax-check** — `node --check` every `.js`/`.mjs` you touch.
4. **Add or update a test** — each plugin has a `test/` dir with offline self-tests where feasible.
5. **Update the plugin README** — env vars table, tool description, behavioral change notes.

## Code style

- ESM (`import`/`export`), no build step, no framework.
- `lib/*.mjs` modules must not import `@deepseek-ai/dsh-tools` — keep them testable standalone;
  the plugin wrapper (`index.js`) owns tool definitions and DSH integration.
- Windows PowerShell scripts: UTF-8 **with BOM** (PowerShell 5.1 requirement) when touching
  `.ps1` files that embed non-ASCII; check with `node test/fix-bom.mjs <file>` in dsh-ui-drive.

## Commit messages

Concise, imperative, plugin-prefixed: `dsh-ui-drive: fix exit-code regression on click guard`.

## License

By contributing you agree that your contributions are licensed under Apache-2.0.
