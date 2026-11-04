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
| `fingerprint` | string | auto | sha256 prefix of class + task + description with paths / ids / numbers normalized away; older records get it computed on read |
| `producer` | object | — (auto records: yes) | who wrote it: `runtime`, MCP `client` (clientInfo), `agentTurn` (host session/turn ids — Codex sends them in `_meta`), `toolchain` (`version` + commit `sha`), `test: true` for test processes. Identifiers only, never arguments or output |

## Failure taxonomy

The vocabulary is **fixed** on purpose: a small, stable set of classes keeps
the data minable. Propose and document a new class before using it.

| Class | Meaning |
| --- | --- |
| `verification-failure` | build / CI / UI check actually failed |
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
| claim contradicted by evidence (adjudicated from build / api / file checks) | the verify engine (`lib/verify/report.mjs`, internal) | `agent-misjudge` |

Auto records carry the tags `auto` + the tool name. The `human-handoff` class,
and context the tools don't know, are what manual recording was reserved for —
there is no longer an agent-callable corpus tool (see **Access** below).

### What is *not* recorded, and why (2026-10)

A review of the real corpus found 811 `tool-error` records of which ~94% were three
repeated messages — "unknown snapshotId, refused", "target process not configured",
and a raw `Get-Process` error from the same unconfigured path — arriving in 248 bursts
of exactly three records two seconds apart. They came from MCP-server-spawning checks that did not isolate the corpus directory. Two changes followed:

- **Expected refusals are not malfunctions.** A gate doing its job (policy deny, missing
  `allowSideEffects`, stale / expired / unknown snapshot) or an unconfigured target is
  not a `tool-error` and is no longer auto-recorded
  (`plugins/dsh-ui-drive/lib/refusal.mjs`; `ui_jev` argument/precondition codes likewise).
  A queue timeout *is* still recorded — congestion is a real signal.
- **Repeats are counted, not multiplied.** Auto records pass `dedupe: true`: within
  `DSH_FAILURE_DEDUPE_HOURS` (default 24, `0` = off) a fingerprint gets one full record;
  later occurrences append a compact `recurrence` event to `recurrences.jsonl` (a separate
  file, so older readers see exactly what they saw before). Reads expose
  `recurrences` / `lastSeenAt` per record and rank `topRecurring`.
  Manual records and verify-engine misjudgements are never folded.

## Access

Host deployments record toolchain version, twelve-character commit SHA and dirty state in
`.dsh-toolchain-deploy.json`. Failure producers use this stamp with `source: deploy-stamp`;
an unrelated profile's package version is never treated as the toolchain version.

The corpus is **internal** now — there is no agent-callable record/query/stats tool on either the
MCP or the DSH face. The runtime writes records itself (the auto-record mechanism in
`mcp/server.mjs`, see above) and the Harness² feature reads them through the engine. Code that needs
to record, query or aggregate uses the module directly:

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
{"id":"fc-20260907-seed5","ts":"2026-09-07T00:04:00.000Z","task":"publish the repo","failureClass":"verification-failure","description":"a gitignore pattern silently excluded the compiled helper from the public repo","resolution":"replace with runtime-artifact ignores; the repo gate now keeps them committed","tags":["git","ci"],"costMs":180000,"context":{"runtime":"ci"}}
{"id":"fc-20260907-seed6","ts":"2026-09-07T00:05:00.000Z","task":"make a new source file compile","failureClass":"doc-gap","description":"legacy build system silently skips source files not registered in the project file, so zero errors did not mean the file compiled","resolution":"hard rule: verify new files are registered before claiming a clean build","tags":["build-system"],"costMs":1500000,"context":{"runtime":"cli","tool":"build"}}
```
