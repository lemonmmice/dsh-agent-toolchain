# Roadmap

> **One-line positioning:** the engineering runtime that makes coding agents
> *verifiably accountable* for their own changes.
>
> 让编码 Agent 对自己的修改承担可验证责任的工程运行时。

## Principles

1. **Control plane, not the 9th plugin.** New capability ships as shared
   `lib/` code with thin DSH + MCP shells — never as another siloed plugin.
2. **Evidence over claims.** A "done" should be checkable against machine
   evidence — build records, UI screenshots, API records, perf data — tied
   together by one runId. (The agent-callable closing verdict that enforced
   this was removed on 2026-11-04; the evidence tools and the internal engine
   remain.)
3. **The failure corpus is the moat.** Features are driven by recorded failure
   frequency, not by imagination. Everyone can copy tools; nobody can copy
   your accumulated failure data.

## Done (2026-09)

- 8-plugin toolchain monorepo — sanitized, public, Apache-2.0, repo checks green
- MCP server — the same tools for any MCP client (Claude Code / Cursor / Cline)
- dsh-router-benchmark public — 21 tasks × 3 modes (routed 100% / pro 90% / flash 86%)
- Release discipline — CHANGELOG, v0.1.0 tag + GitHub Release, compatibility matrix
- Failure corpus v0 — lib engine, fixed taxonomy, seed script; data collection started (the corpus is an internal store — records come from the auto-record path, no agent-callable tool)
- dsh-memory hygiene — mtime-incremental indexing, stale-chunk eviction, fail-closed sensitive-string filter
- Self-recording failure corpus — build/ui/http failure paths auto-record; manual recording reserved for human-handoff
- Capture moat exposed — MCP capture_query/capture_append (caller attribution) for any MCP client
- Evidence-adjudicated verification report — claims checked against build records / capture store / files (machine verdicts, not self-rating); contradicted claims auto-record agent-misjudge
- runId spine — build logs + per-run records named by runId; capture records carry runId; verify/corpus keyed by runId
- verify engine (`lib/verify`) — claims adjudicated against evidence, shared by both faces (later kept as an internal engine: the auto-record path and Harness² use it, no agent-callable verify tool)
- msbuild engine generalization — legacy WholeSolution.sln+x86 layout auto-preserved, stock repos get .sln/.slnx + platform auto-detection (Any CPU preferred), ambiguity = explicit error; msbuild always restores; SDK-resolution chains (MSB4236/MSB4276/NETSDK1004) classified as environment, not code

## Done (2026-10 – 2026-11)

- 0.2.0 (2026-10-09) — the repo root installs as an agent plugin (MCP server +
  workflow skills + hooks); MCP approval annotations from the shared registry;
  memory provenance, kinds and expiry; optional control-level UI deny policies
- Background tasks — `asyncJob` + `toolchain_job`; per-domain tool profiles
- Optional Rust MCP runtime with UIA worker reuse (2026-10-19)
- `dev_*` developer tools — C# language server, logs, .NET skills,
  encoding-preserving read/edit, docs lookup, PNG diff
- Harness² — single-round propose → probe → compose under a frozen check, a
  scoped experience store, and validated lessons applied as project skills
  behind a fail-closed regression gate
- Benchmark pilot run end to end — hidden verification, a five-task home-turf
  suite and a Codex cross-model wave ([bench/pilot/report.md](./bench/pilot/report.md))
- `perf_breakdown` — offline CPU-sample breakdown by thread, time window and
  method group
- Removed (2026-11-04): the agent-callable closing verdict (`verify_report`,
  the `failure_*` tools, the Stop hook and the closing-verdict skill) and the
  test/CI scaffolding. The verify engine and the failure corpus stay as
  internal pieces.

## Now

1. **Benchmark** — the pilot ran end to end; results, including the ones later
   retracted, are in [bench/pilot/report.md](./bench/pilot/report.md). It is
   still a pilot: one machine, five tasks, few runs per arm.
2. **Harness² on real tasks** — the loop is implemented (`harness_trial` /
   `harness_experience`) but has not been evaluated on real tasks yet;
   `bench/harness2/` holds the equal-budget comparison helper.
3. **Teaching artifacts** — demo GIF/asciinema, the "20-line first DSH plugin"
   tutorial, blog series.

## Deliberate non-goals (decision log)

- **perf / hang-inspector on the MCP face — reversed.** They were first held
  back because dump attach needs a permission model and a dump runs to
  hundreds of MB. They are exposed now: approval annotations mark which calls
  write or delete evidence, deletions need `confirm=true`, and dumps stay on
  disk with only their paths returned.

## Year 1 — the verifiable closed loop

4. **Unified verification run (full pipeline)** — the v0 report container
   (the `lib/verify` engine, now internal) graduates into
   automatic assembly: `runId` ties together diff, build log, UI screenshots,
   API records, perf data → `verification-report.json/html`.
5. **Scenarios as code** — YAML scenario: launch → navigate → act → assert
   UI/API/perf → cleanup. Record / replay / parametrize; failure-site evidence
   kept. Builds on ui_flow's existing steps.json format.
6. **Capability policy** — declared permissions (read-only / write files /
   spawn processes / click / install CA / change proxy / network), audit log,
   token redaction, retention limits, proxy failure recovery. Partly in place:
   MCP approval annotations, optional control-level UI deny policies, the kill
   switch.

## Year 2 — evaluation and the data flywheel

7. **Benchmark rigor** — N-run variance + confidence intervals, real-patch
   tasks + hidden tests, failure taxonomy, **cost-per-verified-task as the
   headline metric**, cross-version trends. The pilot already uses hidden tests
   and repeated runs (n=3).
8. **Adaptive routing** — model selection driven by task features + failure
   history (beyond today's static tier table).
9. **Memory upgrade** — provenance/version/expiry for chunks; separate
   *fact* vs *project convention* vs *one-off debug conclusion*; recall reasons.
   Done in 0.2.0: provenance, kinds (`fact` / `convention` / `debug`), reasons
   and expiry.

## Year 3 — open platform

10. Open plugin SDK, workflow marketplace, cross-project agent engineering
    platform. Deliberately unspecified until Year-1/2 data decides the shape.

## Portfolio site (tracked here)

- [x] one-page portfolio (personal-portfolio repo)
- [ ] architecture diagram
- [ ] demo videos / asciinema
- [ ] real case studies + metric trends
- [ ] security model page
- [x] this roadmap
