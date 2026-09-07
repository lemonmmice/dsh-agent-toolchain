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

*Filled in after the critic session completes — see §8 for attribution rules.*

## 8. Attribution rules

- Numbers in §3 come from `bench-runs/results.jsonl` (machine-recorded).
- §7 is an external agent's opinion, machine-triggered and verbatim-distilled;
  it is not the author's claim. Facts inside it were re-checked where cheap
  (tool returns are reproducible by re-running).
