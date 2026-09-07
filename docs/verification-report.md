# Verification report

The physical carrier of "evidence over claims". One `runId` ties a task's
claims to the evidence backing them; the report **adjudicates** each claim
from that evidence — it does not record the agent's self-rating.

## Claim kinds

| kind | Adjudication rule | Pass | Fail | Unverified |
| --- | --- | --- | --- | --- |
| `build` | reads `run-<runId>.json` (or `last.json`) in the build-logs dir | record `ok:true` | record exists, `ok:false` | no record for that run |
| `api` | queries the shared capture store with `filter` (+ `runId`) | ≥ `expect.min` (default 1) matches, all 2xx when `all2xx:true` | store has records but none meet the criteria | store is empty (capture was not active) |
| `file` | checks path existence | exists | missing | no path given |
| `manual` | agent-supplied status | supplied `pass` | supplied `fail` | anything else |

`manual` is the explicit opt-out for what the system cannot check (visual
judgment, human handoff). Everything else is machine-adjudicated.

## runId spine

One id threads through every store, so a failed report can answer "which APIs
fired during this run, which build log, which screenshots" by following the
same id:

- `build_run(runId)` → log `build-<runId>-<ts>.log` + per-run record `run-<runId>.json`
- `capture_append(runId)` attaches the id to records; `capture_query(runId)` filters by it
- `verify_report(runId)` → `verify-reports/<runId>.json`
- failure-corpus records carry `context.runId` (both auto-recorded and verdict-fed)
- ui_flow evidence dirs: pass `tag = <runId>` (screenshots + steps.json land in a run-named dir)

## Verdict

`pass` (every claim adjudicated pass) / `incomplete` (some unverified) /
`fail` (any claim contradicted by evidence). Each contradicted claim
auto-records an `agent-misjudge` in the failure corpus — the system observes
the mismatch, not the agent.

## Usage

- **DSH**: `verify_report` tool (dsh-verify plugin) — the guidance makes the
  closing summary itself the trigger: finish work → write claims → adjudicate
  → report summary + verdict. Skipping it is a claim without verification.
- **MCP**: `verify_report { runId, task, claims: [{ statement, kind, ... }] }`
  (any MCP client).
- Programmatic: `makeVerificationReport(...)` from `lib/verify/report.mjs`.
