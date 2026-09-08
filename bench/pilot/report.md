# Benchmark pilot — report 1

Date: 2026-09-07 · Harness: `bench/harness/bench.mjs` · Status: **pilot**
(all numbers below are machine-recorded per run in `bench-runs/results.jsonl`,
which is local-only; this report is anonymized and public.)

## 1. Task

- **T2-1**: one real, merged bugfix from a public MIT-licensed WPF repository.
  The task package (repo identity, commits, prompt, patches) is local-only by
  policy — see [../README.md](../README.md) for the reasoning.
- Packaged SWE-bench style: `prompt.md` (bug report the agent sees) +
  `verify.patch` (the test-only part of the real fix, hidden) + `gold.patch`
  (the real fix, hidden). The fix is ~8 lines in one file; the hidden test
  suite is a new test file plus a test window.
- Baseline validated before benchmarking (machine-checked):
  - base commit + `verify.patch` → verify command **fails** (the bug is real)
  - base commit + `verify.patch` + `gold.patch` → verify command **passes**

## 2. Protocol

- Agent CLI: Claude Code (print mode), default model
  (`claude-opus-4-8[1m]`), turn budget 40 per run.
- `baseline`: built-in tools only.
- `toolchain`: built-in tools + the dsh-agent-toolchain MCP server
  (`mcp/server.mjs`, 15 tools: build loop, capture store, memory, failure
  corpus, verify_report, …).
- Anti-gaming: agent checkout has no git remotes; the hidden verification
  patch never touches the agent's workspace; per-run records include whether
  the agent's patch touched the hidden test paths.
- After the agent finishes: `agent.patch` is applied to a clean checkout at
  the task base commit together with `verify.patch`, then the task's verify
  command runs. **Verified = verify command exits 0.**
- Since run 3, every toolchain run is followed by a 1-turn machine probe that
  lists the agent's visible tools; a run where
  `mcp__dsh-agent-toolchain__build_run` is not visible is marked invalid
  (`modeValid: false`) and excluded from the comparison.

## 3. Results

| run | mode | valid | verified | turns | duration | cost USD |
|---|---|---|---|---|---|---|
| 1 | baseline | — (pre-gate) | ✅ | 13 | 4 min | 0.6191 |
| 2 | toolchain | ❌ invalid (MCP not loaded) | ✅ | 15 | 4 min | 0.7752 |
| **3** | **baseline** | ✅ | ✅ | **9** | **3 min** | **0.7635** |
| **4** | **toolchain** | ✅ | ✅ | **14** | **4 min** | **0.8668** |

Runs 1–2 are harness-iteration data (see §5), not comparison data. The valid
head-to-head is runs 3–4: **both modes solved the task and passed hidden
verification.**

Tool use in the valid toolchain run (counted from the session transcript):
`Bash ×7, Read ×4, Grep ×1, Edit ×1` — **zero MCP tool calls**, even though
the probe confirmed all 15 toolchain tools were visible to the agent.

Headline metric (N = 1 per mode — pilot only, no statistical claims):

| mode | cost per verified task |
|---|---|
| baseline | **$0.7635** |
| toolchain | $0.8668 |

## 4. Findings

1. **The pipeline works end-to-end.** Task packaging → baseline validation →
   agent run → patch extraction → hidden verification → per-run evidence
   (log / patch / verify log / probe) all function on Windows with the pinned
   .NET SDK.
2. **The toolchain was visible but not chosen.** On this task the agent
   reached for `Bash` + `dotnet test` instead of any MCP tool. Two
   non-exclusive explanations: (a) the task prompt itself prescribes a shell
   command for verification, so the agent had a complete loop already; (b) the
   MCP tool descriptions do not promise anything a shell loop lacks for a
   single-project SDK-style build. Both point at the same action: give the
   tools a reason to exist in the agent's decision loop (structured
   build/verify feedback that is cheaper than reading raw compiler output),
   and make later task prompts tool-neutral.
3. **Toolchain mode costs more without visible return on this task**
   (+$0.10, +5 turns), consistent with the tools being loaded (context cost)
   but unused.
4. **The harness found a real CLI trap:** `--bare` silently drops MCP servers.
   Runs launched with `--bare` therefore never exposed the toolchain. The
   per-run visibility probe (§2) now makes this failure class machine-detectable
   instead of silent. Recorded in the local failure corpus (`tool-error`).

## 5. Transparency: harness iterations

- Run 1/2 were launched with the CLI's `--bare` flag. Baseline still worked
  (built-in tools suffice), but the toolchain run's MCP never connected —
  a 1-turn probe (`List every tool available to you…`) returned only
  `Bash, Edit, PowerShell, Read`. Without `--bare`, the same probe lists all
  15 `mcp__dsh-agent-toolchain__*` tools.
- Fix: `--bare` removed from both modes (the modes must differ only in
  `--mcp-config`), plus the per-run probe gate.

## 6. Next steps

1. Agent self-assessment: a dedicated critic session (same CLI, same MCP) was
   asked to self-test every tool against this task's repository and write a
   harsh review. Its findings are distilled into §7.
2. Scale to 5 tasks (T1–T3 spread) once the tool surface is improved.
3. Tool-neutral prompts for future tasks (state the bug and the definition of
   done; do not prescribe shell commands).
4. Build tool v2: SDK-style/dotnet support with sane defaults for any repo
   (not only the author's client build layout), and output structured enough
   to beat raw compiler text.

## 7. Agent self-assessment (critic session)

A separate session of the same CLI (62 turns) was given the MCP config, the
toolchain source and a live checkout, and told to self-test every tool and
write a harsh review. Raw review is local-only; the findings below were each
**re-verified by the author** before adoption (the critic's own first-pass
"leaked machine path" claim was wrong and it retracted it after `od -c`).

### Confirmed and fixed (all four re-produced before patching)

| # | Finding | Author verification | Fix (commit) |
|---|---|---|---|
| 1 | `build_run` returned `ok:false` with `errors:[]` — top-level MSB errors (MSB1009/MSB4126) and positionless NuGet errors (NU1301) were dropped; summary count disagreed with the structured list. Defaults (x86 / `WholeSolution.sln` / VS MSBuild) fail on stock SDK repos. | Reproduced: `errorCount:0` while the build failed; log held `MSBUILD : error MSB1009` | `ERR_TOP`/`ERR_PLAIN` regexes; summary falls back to parsed counts; new `engine=dotnet` (`dotnet build`, restore-by-default, Any CPU, `NuGetAudit=false`) — verified green on the stock repo (3.7 s) |
| 2 | `verify_report kind=gate` certified `pass` on a run where **zero tests matched** the filter (`dotnet test` exits 0 there) | Reproduced: verdict `pass`, `mismatchCount 0` on a no-match filter | `checkGate` now fails exit-0 vacuous runs (CN/EN patterns + 0/0 counts); 3 new unit tests |
| 3 | `memory_index` wiped 23 pre-existing chunks when indexing a second root (eviction keyed on "inside current root"), and the index path had no secret screening while embedding egresses to `api.minimax.chat` | Reproduced in code + the critic session demonstrably damaged the local store | Chunk keys carry absolute paths; eviction judges disk existence (multi-root safe); index path runs the fail-closed sensitive filter (`sensitiveSkipped`); egress disclosed in `memory_status` + README + tool descriptions |
| 4 | `ui_drive` error output was mojibake (GBK decoded as UTF-8) and the garbage was auto-recorded into the corpus | Confirmed in code (`driver.mjs` decoded per-chunk as UTF-8) | Shared `lib/decode.mjs` (UTF-8→GBK) now used by builder + driver; `ui_status` distinguishes `unconfigured` |

> **Follow-up (later session):** the msbuild engine itself was then
> generalized instead of staying doc-scoped to `engine=dotnet`
> (`lib/build-resolve.mjs`): repos containing `WholeSolution.sln` keep the
> legacy defaults byte-for-byte; stock repos get `.sln`/`.slnx` +
> platform auto-detection (Any CPU preferred), ambiguity is an explicit
> error; the engine always passes `/restore`; SDK-resolution chains
> (MSB4236/MSB4276/NETSDK1004) classify as environment errors. Verified
> green on the stock repo through VS MSBuild (auto-detected
> `src/MahApps.Metro.sln` + `Any CPU`, 0 errors).

### Accepted, deferred (not fixed yet)

- Fit-and-finish: `memory_recall` nested shape, gate `detail` too thin on
  failure, `perf.mjs` powershell path lacks an env override, cross-platform
  honesty (the build/ui/perf half is Windows-only) — tracked for later.
- The pilot cost finding (§4) — needs more tasks before acting.

### Verdict line (the critic's own words, machine-triggered)

> "Split, but net NO for the whole toolchain as-is… YES, cautiously, to the
> evidence spine (verify_report + failure corpus + capture store); NO to
> build_run and memory_index in their current state."

As of this commit, the two "NO" tools have been reworked per the review and
re-verified; re-adjudication is the next pilot run's job.

## 9. Pilot 2 — neutral prompts, 3 tasks, web access hard-blocked

Changes vs pilot 1: task prompts no longer prescribe any shell command ("verify
with the repository's own build and test tooling"); WebSearch/WebFetch are
excluded at the tool level; two more tasks packaged from real merged fixes in
the same public repository (each validated: base + hidden tests fail, gold
fix makes them pass); the MCP-visibility probe was hardened (no-tool-calls
instruction, 2-turn budget, 3 retries, `--mcp-debug` stderr evidence).

| task (tier) | baseline | toolchain (MCP visible) | MCP tool calls |
|---|---|---|---|
| T2-1 (hotkey event semantics) | 35 turns / $1.70 / ✅ | 39 turns / $1.71 / ✅ | **0** |
| T2-2 (dialog owner lifetime) | 22 turns / $1.72 / ✅ | 29 turns / $1.58 / ✅ | **0** |
| T2-3 (transition event spam) | 12 turns / $0.79 / ✅ | 20 turns / $1.03 / ✅ | **0** |
| **total / avg** | 69 turns / **$4.21** / 3-0 | 88 turns / **$4.32** / 3-0 | **0 of all tool calls** |

Cost per verified task: baseline **$1.40** vs toolchain **$1.44** (+3%).
Tool-call census from the session transcripts of the three toolchain runs:
`Bash ×31, Read ×20, Glob ×15, Edit ×8, Grep ×11, PowerShell ×5, Write ×3` —
every `mcp__dsh-agent-toolchain__*` tool unused across all three runs.

**Conclusion (now replicated):** the toolchain MCP was connected, verified
visible, and prompt-neutralized — and agents still chose a plain shell loop
for every task. Two readings, both actionable:

1. *Wrong task shape.* These tasks are single-file SDK-library bugfixes; the
   toolchain's unique value (desktop-client build layout, UI drive, API
   capture, adjudicated closing) is dead weight on them. The benchmark should
   next use a task where the shell cannot do what the toolchain does — its
   home turf: a desktop-client change (x86 MSBuild layout, capture moat,
   UI-driven verification).
2. *No pull yet.* The tools that DO generalize (build loop, verify_report)
   were not worth switching to in the agent's judgment: `build_run`'s output
   has to beat raw `dotnet test` text at least once, visibly, before any agent
   prefers it.

Both readings agree on the same next step: task shapes must match the tool,
not the other way around.

## 10. Harness validity notes

- One toolchain run in pilot 2 was invalidated by a flaky MCP connection
  (probe showed the server unconnected); re-run connected and verified. The
  probe now retries 3× and the agent stderr carries `--mcp-debug` connection
  evidence, so "MCP was connected" is machine-attested per run.
- Web tools were hard-blocked in pilot 2 (`--allowedTools`); pilot 1 numbers
  predate that block, which is why the two pilots are reported separately.

## 11. Review loop (rounds 2–3)

After pilot 2, the external reviewer re-tested everything. Round 2 verdict:
**NOT SATISFIED** — 3 of 4 previous fixes held; two new must-fixes found:

1. `build_run` counted MSBuild's double-printed errors twice (`errorCount` 2×
   the summary line, on both engines). Fixed by deduping on
   (file,line,col,code); re-verified on real logs (80 raw lines → 6 unique
   errors; counts now agree).
2. `memory_index` wiped a legacy-format store (relative-path keys) to 0 chunks
   on the first post-upgrade index call, and `DSH_MEMORY_DIR` was documented
   but never honored. Fixed: the eviction sweep skips non-absolute stored
   paths; `defaultDataDir()` honors `DSH_MEMORY_DIR`. Round-3 re-verification
   (isolated harnesses + live tool): **SATISFIED**. Remaining items are
   should-fix/nice-to-have only (see §7 deferred list).

Both rounds' evidence, the reviewer's disclosures (it demonstrated the legacy
wipe on a real store and said so), and its final verdict are on record in the
local review files. The author re-verified every finding before fixing —
external review can be wrong too, and evidence-first cuts both ways.

## 12. Attribution rules

- Numbers in §3/§9/§13 come from `bench-runs/results.jsonl` (machine-recorded).
- §7 is an external agent's opinion, machine-triggered and verbatim-distilled;
  it is not the author's claim. Facts inside it were re-checked where cheap
  (tool returns are reproducible by re-running).

## 13. Pilot 3 — the home-turf task (UI-driven hidden verification)

The meta-criticism ("task shapes must match the tool; two pilots show the
tools have no pull") is answered by a task on the toolchain's home turf: a
desktop-client-shaped change whose hidden verification is a **UIA probe** —
`verify.patch` adds a minimal WPF host + probe script, `verifyCommand` builds
the host, launches the real window and asserts the rendered control text.
The task also declares `agentEnv` (`DSH_UI_PROC_NAME`, `DSH_UI_WINDOW_NAME`),
which the harness injects into the agent process and the toolchain MCP server
(harness support added for this; `bench/README.md` documents the shape).
Task identity local-only (same privacy policy).

| mode | turns | cost | dur | verified | MCP tool calls (from session transcript) |
|---|---|---|---|---|---|
| baseline | 31 | $1.51 | 6m | ✅ | — |
| toolchain | 41 | $2.84 | 11m | ✅ (hit the 40-turn cap) | **`ui_status` ×2, `ui_drive` ×3** |

Census of the toolchain session: `Bash ×10, PowerShell ×10, Write ×7,
Read ×3, Edit ×2, Grep ×2, mcp__ui_drive ×3, mcp__ui_status ×2`. First MCP
tool usage across all pilots (0 in the previous six runs): on a task where
the bug is only observable in a live window, the agent reached for the
UI tools to launch-check-read the rendered text. `build_run` was still not
used — the build-loop pull remains the open question (structured errors must
beat raw `dotnet` output at least once, visibly).

Cost note: toolchain cost more and hit the turn cap while still verified —
the tools pulled, but the run budget is not yet the win. That is the honest
baseline to optimize against, not a victory lap.

Also recorded: the first prompt draft triggered a **cyber-safeguard refusal**
before turn 1 (the "int saturation / 32-bit" wording of a benign rendering
bug read as cyber-related). The prompt was reworded to neutral user-facing
terms (same bug, same fix); the refusal is recorded in the failure corpus as
a prompt-design lesson for benchmark authoring.

## 14. Review loop (round 4) — fresh adversarial pass

A fresh independent review round (52 turns, evidence-first, all deterministic
suites re-run, adversarial probes written in-repo): verdict **SATISFIED**,
**0 must-fix**. It reproduced and disproved the primary benchmark cheat
(agent patch clobbering the hidden tests fails to apply → `verified=false`),
and found 4 should-fix items, all author-reproduced and fixed this session:

- **S1** `verify kind=api` certified `pass` for `expect.min ≤ 0` with zero
  evidence → now `unverified` (anti-green-wash, same discipline as the gate).
- **S2** vacuous-gate missed the .NET wordings `No test is available in the
  specified test containers` / `Tests run: 0` / `OK (0 tests)` → added.
- **S3** bench `verified` was a raw exit-0 with no runtime vacuous guard →
  in-harness vacuous-output check (reuses the same pattern list) +
  `patchedTests` now downgrades `verified`.
- **S4** `/source/open` treated a different-drive path as inside its root
  (`path.relative` returns an absolute path across drives) → rejected; the
  `start` invocations now quote the target.

Notes N1–N6 accepted and recorded in the review file (parity is a discipline
not a runtime invariant; CI test hard-codes the Git-Bash path; http_request
SSRF-by-design; external repo claims not live-verified). The review round
cost ≈ $5.10. A parallel third-party (Codex) review was started but deferred
by the author's user ("bring it along in a later optimization pass").

## 15. Home-turf suite (5 tasks): first MCP pull, then the guidance fix that made the build loop engage

The 1-task pilot grew into a 5-task home-turf suite: four pure UI-probe
tasks (`autosuggest-bind`, `toggleswitch-template`, `checkbox-padding`,
`numeric-hex` — real upstream commits, hidden WPF host + UIA probe) plus one
real compile-error task (`maxby-build` — a MaxBy break fixed by a later
upstream commit, gated by the library's own multi-TFM build). All task
packages are local-only (gitignored, never published); results below are
anonymized aggregates.

### 15.1 Real-bugfix tasks, original plan (toolchain arm = bare MCP, no guidance)

| task | baseline | toolchain | toolchain MCP pulls | verdict |
| --- | --- | --- | --- | --- |
| autosuggest-bind | 11 t / $1.04 | 34 t / $2.06 | 0 | lost |
| toggleswitch-template | 34 t / $2.50 | 24 t / $1.40 | 0 | **won** |
| checkbox-padding | 22 t / $1.96 | 46 t / $4.03 | build_run x2, verify_report x1, ui_status x2, ToolSearch x1 | lost |
| maxby-build | 7 t / $0.40 | 13 t / $0.63 | 0 | lost |
| numeric-hex | 36 t / $2.16 | 41 t / $2.94 | ui_status x2, ToolSearch x1 | lost |

All runs `verified=true`. Toolchain won 1/5 on turns. Two honest reads:
`checkbox-padding` produced the **first-ever MCP pulls** (the UI tools, then
`build_run`, then the `verify_report` closing check — the toolchain's full
loop, at last), yet lost turns; `toggleswitch-template` won with **zero**
MCP calls — a raw-agent win, not a toolchain win. The pull matrix closed its
gaps (build_run / verify_report / ui_status / ToolSearch all pulled >= 1
across the suite; capture / memory / http_request never pulled — the server
is exposed as-is and those tools are irrelevant to these tasks, by design).

### 15.2 The build-loop open question, answered by a harness fidelity fix

`build_run` stayed unpulled on both build-centric tasks (0 calls, 3 runs) —
the agent preferred 9 raw `dotnet build` Bash calls over the structured tool.
Root cause: a **fidelity gap in the harness**, not in the tool. The
toolchain arm attached the MCP server with no guidance, while a real dsh
install injects plugin system-prompt sections describing the loop (build_run
hard rules, verify_report as the closing check). Bare tools with no context
get ignored; a real user never sees that condition.

Fix: `bench/harness/toolchain-guidance.md` (a condensed mirror of the real
plugin guidance) is now prepended to the task prompt in toolchain mode, and
each result row records `toolchainGuidance: true/false` so mixed-condition
history stays groupable. Baseline arm unchanged. Re-ran both build tasks:

| task | baseline | toolchain (guidance) | MCP pulls | verdict |
| --- | --- | --- | --- | --- |
| synth-buildbreak (disclosed synthetic) | 18 t / $0.59 | 15 t / $0.67 | build_run x1, verify_report x1, ToolSearch x1 | won at N=1 (retracted in 15.4) |
| maxby-build (real) | 7 t / $0.40 | 14 t / $0.95 | build_run x1, verify_report x1, ToolSearch x1 | lost |

With guidance, **both** agents ran the structured loop: `build_run`
(discover structured errors -> fix -> Rebuild to 0 errors) then
`verify_report`, whose machine check adjudicated the build claim from
evidence (verdict pass) — and raw Bash builds dropped 9 -> 3. On the
synthetic task the toolchain arm won 15 < 18 turns **with the loop
engaged**: the first datapoint where structured build errors beat raw
`dotnet` output, visibly. On `maxby-build` it still lost: the baseline
solves it in 3 edits without ever building (the prompt names the error
text, and 7-turn tasks are too cheap to amortize verification discipline).
That asymmetry is itself the finding — the toolchain pays off on noisy,
multi-error, build-gated failures, and costs overhead on trivial ones.

Disclosure: `synth-buildbreak` is a planted-break task (three scattered
semantic compile errors, local-only, prompt does not quote the errors). It
is reported here as a controlled experiment for the structured-error claim
and is **excluded** from real-bugfix aggregates. Its baseline (18 t) and
unguided toolchain (15 t, 0 MCP) ran before the guidance fix.

### 15.3 Bottom line

- Pull matrix closed across all tool families; the full loop
  (build_run -> Rebuild -> verify_report pass) ran end-to-end six times
  under guidance (15.4).
- "Structured errors win once over raw output": **yes at N=1** (synth-buildbreak,
  15 < 18 with the loop engaged) — but see 15.4: the statistical repeats
  retract the win and keep the pull-rate finding.
- Next steps: repeats for variance, a task with genuinely noisy build
  output (the shape where structure should win by more), and the deferred
  third-party (Codex) cross-model run.

### 15.4 Statistical repeats of the guidance condition — the win does not survive

Both build-centric tasks were repeated to n=3 per condition (baseline and
guidance toolchain; all `verified=true`):

| condition | n | turns | median | cost median |
| --- | --- | --- | --- | --- |
| synth baseline | 3 | 15, 16, 18 | 16 | $0.56 |
| synth toolchain (guidance) | 3 | 15, 15, 19 | 15 | $0.71 |
| maxby baseline | 3 | 7, 7, 11 | 7 | $0.44 |
| maxby toolchain (guidance) | 3 | 14, 14, 17 | 14 | $0.98 |

Two conclusions, both stronger than the N=1 story:

1. **The pull is robust; the turn win is not.** Every guidance run (6/6)
   pulled `build_run` and `verify_report`, versus 0/4 unguided runs — the
   guidance injection is the real, reproducible effect. But the earlier
   single-pair "15 < 18 win" sits inside baseline noise: synth medians are
   16 vs 15, overlapping, and the toolchain costs more. The "structured
   errors beat raw output" claim of 15.2/15.3 is therefore **retracted** as
   unsupported at n=3 (lesson recorded in the failure corpus: a noisy agent
   cannot be judged on one paired run).
2. **Toolchain overhead is real on trivial tasks.** maxby-build median 14
   vs 7 turns and roughly double the cost — the loop's verification
   discipline does not amortize when the baseline fixes the bug in a few
   edits without ever building.

What the guidance condition earned honestly: 100% structured-loop
engagement (`build_run` -> Rebuild -> `verify_report` adjudication) instead
of ad-hoc Bash builds — observable behavior the baseline cannot show. A
turn/cost advantage still needs a task whose build output is genuinely
noisy (multi-project, dozens of errors) and >= 5 repeats per condition
before any claim is made.
