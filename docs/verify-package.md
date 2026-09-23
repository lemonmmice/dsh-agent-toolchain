# Proposal: extracting the verification core as a standalone package

> **Status: proposal — nothing here is implemented.** Written 2026-09-23. Everything marked
> "measured" was read out of the tree on that date; everything marked "unverified" is a task, not a
> claim.

The idea: `lib/verify/report.mjs` + `lib/failure-corpus.mjs` are the most general thing in this
repository — *claims adjudicated against evidence*, plus *a local corpus that records the
disagreements* — and they have nothing to do with Windows, WPF, UI automation or DeepSeek Harness.
Anyone driving an agent in any harness could use them. This document is the plan for shipping them as
a package, including where it is not obviously a good idea.

## 1. What exists today (measured)

| Module | Size | Runtime dependencies | Consumers |
| --- | ---: | --- | --- |
| `lib/failure-corpus.mjs` | 347 lines | Node builtins only (`fs`, `path`, `os`, `crypto`) + `lib/env-fallback.mjs` | `mcp/server.mjs`; `lib/verify/report.mjs`; `plugins/dsh-build`, `plugins/dsh-ui-drive`, `plugins/dsh-verify`; `scripts/seed-failure-corpus.mjs`; tests |
| `lib/verify/report.mjs` | 502 lines | Node builtins (`fs`, `path`, `os`, `child_process`) + `failure-corpus.mjs`, **`capture-store.mjs`**, `env-fallback.mjs`, `compile-membership.mjs` | `mcp/server.mjs`; `plugins/dsh-verify`; `bench/harness/bench.mjs`; tests |
| `lib/env-fallback.mjs` | 210 lines | `node:child_process` + a **Windows registry** read (`readRegistryEnv`) | both of the above |

Exports that would become the public surface:

- `failure-corpus`: `makeFailureCorpus(opts)`, `FAILURE_CLASSES`, `DEFAULT_MAX_FILE_BYTES`, `defaultCorpusDir()`
- `verify/report`: `makeVerificationReport({ runId, task, claims, context, recordFailures })`, `adjudicateClaim(claim, ctx)`, `sanitizeRunId(runId)`, `defaultReportDir()`, `defaultBuildLogsDir()`, `VACUOUS_TEST_PATTERNS`

The claim kinds are already a clean seam: `build` (build record), `api` (capture store), `file`
(filesystem), `compiled` (project-file analysis), `gate` (a command, judged by exit code), `git`
(repository state), `manual` (explicit human verdict).

## 2. The one real obstacle: exactly one native dependency

`verify/report.mjs` imports `capture-store.mjs` **only** to answer `api` claims. That module wraps a
per-platform Rust Node-API binary. Everything else in the pair is portable:

| Piece | Portability | Why |
| --- | --- | --- |
| claim adjudication, verdict, report JSON | portable | pure logic + `fs` |
| failure corpus | portable | JSONL + `fs` |
| `compiled` claims | portable *(unverified)* | reads project files as text |
| **`api` claims** | **native** | `capture-store` is a Rust Node-API module per platform/arch |
| `env-fallback` | portable *(unverified)* | the Windows registry path needs to degrade to "unset" on other platforms — must be tested, not assumed |

So the extraction is not "port 1,500 lines to another language" — it is **one dependency-inversion**:
make the capture reader an injected adapter, and let `api` claims fail closed with a reason when no
adapter is present.

## 3. Proposed shape

```
@dsh-agent-toolchain/failure-corpus      # zero native deps — could ship today
@dsh-agent-toolchain/verify              # depends on the above; capture adapter injected
    ├─ core:    adjudicateClaim / makeVerificationReport / report JSON
    ├─ adapter: { readCapture(query) }   # optional; absent ⇒ api claims report "unverified"
    └─ the same seven claim kinds, same verdict semantics
```

Three rules for the split, each chosen to preserve something that already works:

1. **`api` claims fail closed, never silently pass.** With no adapter: status `unverified`, detail
   "no capture adapter configured". That is the existing three-state discipline extended to a missing
   capability — and it is the difference between a package that is honest on day one and one that
   quietly reports `pass` for checks it never ran.
2. **This repository becomes a consumer, not a copy.** `lib/verify/report.mjs` turns into a thin
   re-export. Two copies of adjudication logic would drift, and drift between two implementations of
   "did the evidence agree?" is the worst possible place for it. (The repo already runs a parity test
   over the two tool faces for exactly this reason — see `lib/toolface-parity.test.mjs`.)
3. **No new dependencies.** Node builtins only, ESM, Node 20+, no framework. The package's whole
   value proposition is that it can be dropped into a hook script.

## 4. Migration steps

| Step | Work | Verification |
| --- | --- | --- |
| 1 | Move `failure-corpus.mjs` + `env-fallback.mjs` into the package; repo re-exports | the existing `lib/failure-corpus.test.mjs` + `lib/verify/report.test.mjs` run unchanged against the package |
| 2 | Confirm `env-fallback` degrades on non-Windows *(unverified)* | run the suite on Linux/macOS CI; assert "registry read unavailable ⇒ treated as unset", never as an empty-string value |
| 3 | Invert the capture dependency: `makeVerificationReport({ capture })` | a test where `api` claims report `unverified` *with a reason* when no adapter is passed |
| 4 | Move the verify core; keep `compile-membership` and `gate`/`git` claim handling beside it | a **parity test**: the same claim list adjudicated by the in-repo path and the packaged path must produce byte-identical reports (modulo timestamps) |
| 5 | Publish `0.1.0` with the repo's existing conventions | `mcp/package.json` is the template (Apache-2.0, `repository.directory`, `"type": "module"`) |

## 5. Distribution: two doors, and only one of them needs the DSH ecosystem

- **As an npm package** — the ordinary path: `npm i @dsh-agent-toolchain/verify`, import, call.
- **Into the DSH plugin market** — if it should also be installable by `dsh plugin add`, the ecosystem
  validates a plugin package by reading its default-branch tree and requiring `package.json` **plus a
  `dsh.bundle.patch` field and the patch file it names, in the same tree** (`dsh-plugin` topic is what
  the catalogues auto-collect). That is a packaging detail, not a redesign — but it must be decided
  deliberately, because the MCP server package in this repo does not currently declare it either.

## 6. Risks, stated plainly

| Risk | Assessment |
| --- | --- |
| **Nobody wants it** | The honest default. There is currently **no evidence of external demand** — no issue asking for it, no third-party consumer. Extracting on spec spends real effort against a hypothesis. |
| `gate` claims execute arbitrary commands | Correct for a local trust-the-caller tool; it needs a loud sentence in the README of a *published* package, not just in ours. |
| Report-path/env defaults on other platforms | Today's defaults assume a user profile layout. Needs one pass on Linux/macOS before "cross-platform" is claimed. |
| Losing the monorepo's cross-checking | The claim kinds are checked against the two tool faces here. A standalone package loses that net unless the parity test comes along. |

## 7. Recommendation

**Do the reversible 80% now, publish when a consumer appears.**

- **Do now (cheap, no publishing):** steps 1 and 3 — move the two pure modules behind a re-export and
  invert the capture dependency. Both make the boundary explicit while the code still has one owner,
  and the parity test from step 4 protects it.
- **Wait for a trigger to publish:** a third-party consumer, an issue asking for it, or the first time
  this logic is wanted in a *non-DSH* harness (a Claude Code hook, a Codex/CI check). The repository
  already applies exactly this rule to its own features — "features are driven by recorded failure
  frequency, not by imagination" ([failure-corpus.md](./failure-corpus.md)) — and a published package
  should clear the same bar.
- **Never:** maintain two copies of the adjudication logic.
