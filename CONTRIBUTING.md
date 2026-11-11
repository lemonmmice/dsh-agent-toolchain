# Contributing to dsh-agent-toolchain

Thanks for your interest in improving the agent-visible quality loop!

## Ways to contribute

- **Report a bug** — open an issue with a minimal repro (plugin, harness version, OS, env vars set).
- **Propose a feature** — describe the agent workflow gap it closes and which plugin fits.
- **Send a pull request** — for code or docs. See the checklist below.

## Development setup

```bash
git clone https://github.com/lemonmmice/dsh-agent-toolchain.git
cd dsh-agent-toolchain
node --check plugins/<plugin>/lib/*.mjs   # syntax gate (no build step required)
npm run check                             # the repo gate
```
Plugins are ESM Node.js with zero runtime deps except where noted in each `package.json`.
The Windows terminal inspector also requires its Rust helper: run
`npm run build:terminal-inspector` before deploying that plugin.
Build prerequisites are the Rust MSVC toolchain and Visual C++ build tools.
Capture storage uses a Rust Node-API module: `npm run build:capture-store`
builds it for the current platform/Node architecture.
Memory vectors use a separate Node-API module: `npm run build:memory-store`.
CPU/allocation CSV folding uses `npm run build:trace-fold`.

## Pull request checklist

1. **Target one plugin** — the repo is a monorepo of independent plugins; keep PRs focused.
2. **No environment leakage** — this repo must remain machine-agnostic:
   - never hard-code absolute paths or user home directories;
   - configure via environment variables (`DSH_*`) with sane defaults;
   - never commit API keys, tokens, or company identifiers.
   - private-reference rules in `scripts/lib/private-references.mjs` retain lowercase SHA-256
     fingerprints and lengths, not the private terms; scanning is case-insensitive and includes
     substrings in identifiers, paths and Unicode words.
3. **Run the repo gate** — `npm run check` (syntax, forbidden references, tool schemas, PowerShell BOM).
   There is no unit-test suite at the moment, so say in the PR how you verified a behavioral change.
4. **Update the plugin README** — env vars table, tool description, behavioral change notes.

## Code style

- ESM (`import`/`export`), no build step, no framework.
- `lib/*.mjs` modules must not import `@deepseek-ai/dsh-tools` — keep them testable standalone;
  the plugin wrapper (`index.js`) owns tool definitions and DSH integration.
- Windows PowerShell scripts: UTF-8 **with BOM** (PowerShell 5.1 requirement) when touching
  `.ps1` files that embed non-ASCII.

## Commit messages

Conventional-commit style with the plugin or area as scope, e.g.
`fix(ui-drive): re-resolve the main window after a login window is replaced`.
History on `main` is linear: rebase onto `main`; merges are fast-forward only.

## License

By contributing you agree that your contributions are licensed under Apache-2.0.
