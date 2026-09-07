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

## Pull request checklist

1. **Target one plugin** — the repo is a monorepo of independent plugins; keep PRs focused.
2. **No environment leakage** — this repo must remain machine-agnostic:
   - never hard-code paths like `E:\dsh-files\...` or user home directories;
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
