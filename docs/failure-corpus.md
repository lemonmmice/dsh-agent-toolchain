# Failure corpus

> Roadmap principle 3: **the failure corpus is the moat.** Features are driven
> by recorded failure frequency, not by imagination. Everyone can copy tools;
> nobody can copy your accumulated failure data.

Every time a task fails — a build breaks, verification disagrees with an
agent's claim, a tool malfunctions, or a human has to take over — append one
line to the corpus. Records are local-only (never uploaded) and deliberately
simple, so recording costs almost nothing.

## Storage

- Active file: `~/.dsh-agent-toolchain/failure-corpus/records.jsonl`
  (override with `DSH_FAILURE_CORPUS_DIR`).
- One JSON record per line, appended. The active file rotates to
  `records-<timestamp>.jsonl` at 20 MB.
- Seed script: `node scripts/seed-failure-corpus.mjs` writes the example
  records below into the local corpus (idempotent — skips if records exist).

## Record schema

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | auto | `fc-<date>-<rand>` |
| `ts` | string (ISO 8601) | auto | when it was recorded |
| `task` | string | yes | one-line task name |
| `failureClass` | enum | yes | fixed taxonomy, see below |
| `description` | string | yes | what went wrong — facts, not blame |
| `resolution` | string | — | how it was unblocked |
| `context` | object | — | runtime / tool / model / repo |
| `costMs` | number | — | approximate time wasted |
| `tags` | string[] | — | free-form tags for later mining |

## Failure taxonomy

The vocabulary is **fixed** on purpose: a small, stable set of classes keeps
the data minable. Propose and document a new class before using it.

| Class | Meaning |
| --- | --- |
| `verification-failure` | build / test / CI / UI check actually failed |
| `agent-misjudge` | the agent claimed success, evidence disagreed |
| `human-handoff` | work stopped to ask a human |
| `tool-error` | a toolchain component malfunctioned |
| `flaky` | nondeterministic failure (passes on retry) |
| `doc-gap` | docs / API mismatch caused the failure |
| `design-flaw` | an architecture decision required rework |

## System-recorded failures (the default)

Manual reporting is the fallback, not the norm. The tools themselves know when
a failure happened, so they record it — the system observes, the agent doesn't
have to volunteer (and usually won't):

| Signal | Tool | Auto-recorded class |
| --- | --- | --- |
| build code errors > 0 | `build_run` (MCP + DSH) | `verification-failure` |
| ui_flow assertion failures | `ui_flow` (DSH) | `verification-failure` |
| ui_drive step failed | `ui_drive` (MCP) | `tool-error` |
| request could not be made | `http_request` (MCP) | `tool-error` |
| claim vs evidence mismatch | `verify_report` (MCP) | `agent-misjudge` |

Auto records carry the tags `auto` + the tool name. Manual `failure_record` is
reserved for what the system cannot see: `human-handoff`, and context the
tools don't know.

## Usage

MCP (Claude Code / Cursor / Cline, via the `dsh-agent-toolchain` server):

- `failure_record` — append one record manually (mainly `human-handoff` —
  most classes are auto-recorded, see above)
- `failure_query` — filter by `q` / `failureClass` / `tag` / time range
- `failure_stats` — totals + per-class counts

Programmatically:

```js
import { makeFailureCorpus } from './lib/failure-corpus.mjs'
const c = makeFailureCorpus({}) // dir or DSH_FAILURE_CORPUS_DIR
const rec = c.record({
  task: 'push repo',
  failureClass: 'tool-error',
  description: 'TLS handshake failed through the proxy',
  resolution: 'push with the openssl backend',
  tags: ['git', 'proxy'],
})
c.query({ failureClass: 'tool-error', limit: 10 })
c.stats()
```

## Seed examples

The six records below are real, sanitized events from the toolchain's own
development — they seed every fresh corpus so new agents see the format:

```jsonl
{"id":"fc-20260907-seed1","ts":"2026-09-07T00:00:00.000Z","task":"push repo to GitHub","failureClass":"tool-error","description":"git push failed with TLS handshake errors when going through a local HTTP proxy (schannel backend)","resolution":"push with -c http.sslBackend=openssl -c http.proxy=<proxy>","tags":["git","proxy","tls"],"costMs":900000,"context":{"runtime":"cli","tool":"git push"}}
{"id":"fc-20260907-seed2","ts":"2026-09-07T00:01:00.000Z","task":"commit a CI workflow file","failureClass":"tool-error","description":"OAuth-token push of .github/workflows changes rejected: workflow scope missing","resolution":"device-flow token with repo+workflow scope, one-shot token-URL push","tags":["github","auth","ci"],"costMs":1200000,"context":{"runtime":"cli","tool":"git push"}}
{"id":"fc-20260907-seed3","ts":"2026-09-07T00:02:00.000Z","task":"refresh gh CLI auth through proxy","failureClass":"tool-error","description":"gh auth refresh timed out on TLS handshake; gh ignored the configured proxy","resolution":"lowercase https_proxy/http_proxy; fetched a device code via the REST API manually","tags":["github","proxy","cli"],"costMs":600000,"context":{"runtime":"cli","tool":"gh"}}
{"id":"fc-20260907-seed4","ts":"2026-09-07T00:03:00.000Z","task":"export plugin repo with a clean tree","failureClass":"design-flaw","description":"plugins ended up nested one level deep during extraction, breaking import paths","resolution":"flatten to single-level plugin dirs before publishing","tags":["repo-hygiene"],"costMs":300000,"context":{"runtime":"cli"}}
{"id":"fc-20260907-seed5","ts":"2026-09-07T00:04:00.000Z","task":"publish tests with the repo","failureClass":"verification-failure","description":"a gitignore pattern silently excluded test directories from the public repo","resolution":"replace with runtime-artifact ignores; the CI gate now asserts tests are committed","tags":["git","ci"],"costMs":180000,"context":{"runtime":"ci"}}
{"id":"fc-20260907-seed6","ts":"2026-09-07T00:05:00.000Z","task":"make a new source file compile","failureClass":"doc-gap","description":"legacy build system silently skips source files not registered in the project file, so zero errors did not mean the file compiled","resolution":"hard rule: verify new files are registered before claiming a clean build","tags":["build-system"],"costMs":1500000,"context":{"runtime":"cli","tool":"build"}}
```
