# dsh-verify

The DSH closing-adjudication surface — a thin shell over `lib/verify/report.mjs`
(the same engine as the MCP `verify_report` tool). Zero logic lives here.

## What it changes

Your task-closing summary stops being free text. You hand over a **claims
list** (each claim = statement + evidence reference), and the machine
adjudicates:

- `kind=build` — reads the per-run build record (`run-<runId>.json`)
- `kind=api` — queries the shared capture store (`filter` + `expect.min/all2xx`)
- `kind=file` — checks an evidence artifact exists
- `kind=manual` — explicit opt-out for what the system can't check

Verdict: `pass` / `incomplete` / `fail`. Claims contradicted by evidence
auto-record into the failure corpus as `agent-misjudge` — the only data
source for "caught the agent claiming success while the evidence disagrees".

## The workflow (mandatory)

1. Finish the work.
2. Write down what you claim is done — as structured claims, not prose.
3. Call `verify_report(runId, task, claims)`, get the verdict.
4. Report to the human: summary + verdict.

Skipping step 3 is a claim without verification. The trigger surface is the
closing summary itself — an action you already perform every time — not a
separate habit you have to remember.

See [docs/verification-report.md](../../docs/verification-report.md).
