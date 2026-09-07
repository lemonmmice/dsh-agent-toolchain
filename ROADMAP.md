# Roadmap

> **One-line positioning:** the engineering runtime that makes coding agents
> *verifiably accountable* for their own changes.
>
> 让编码 Agent 对自己的修改承担可验证责任的工程运行时。

## Principles

1. **Control plane, not the 9th plugin.** New capability ships as shared
   `lib/` code with thin DSH + MCP shells — never as another siloed plugin.
2. **Evidence over claims.** Every "done" ships with a verification report:
   diff + build log + UI screenshots + API records + perf data, one runId.
3. **The failure corpus is the moat.** Features are driven by recorded failure
   frequency, not by imagination. Everyone can copy tools; nobody can copy
   your accumulated failure data.

## Done (2026-09)

- 8-plugin toolchain monorepo — sanitized, public, Apache-2.0, CI green
- MCP server — the same tools for any MCP client (Claude Code / Cursor / Cline)
- dsh-router-benchmark public — 21 tasks × 3 modes (routed 100% / pro 90% / flash 86%)

## Now — next 1–2 weeks

1. **Release discipline** — `CHANGELOG.md`, `v0.1.0` tag, harness compatibility
   matrix (DSH version × plugin version).
2. **Failure corpus v0** — every human handoff / verification failure appends a
   JSONL record (task, run context, failure class, resolution). Minimal
   classifier + panel later; start collecting data immediately.
3. **dsh-memory hygiene** — stale-chunk eviction when a source file's mtime
   changes; sensitive-string filter (tokens/keys) on save.

## Year 1 — the verifiable closed loop

4. **Unified verification run** — `runId` ties together diff, build log, UI
   screenshots, API records, perf data → `verification-report.json/html`.
   Shipped as `lib/verify` + MCP tool first, DSH shell after.
5. **Scenarios as code** — YAML scenario: launch → navigate → act → assert
   UI/API/perf → cleanup. Record / replay / parametrize; failure-site evidence
   kept. Builds on ui_flow's existing steps.json format.
6. **Capability policy** — declared permissions (read-only / write files /
   spawn processes / click / install CA / change proxy / network), audit log,
   token redaction, retention limits, proxy failure recovery.

## Year 2 — evaluation and the data flywheel

7. **Benchmark rigor** — N-run variance + confidence intervals, real-patch
   tasks + hidden tests, failure taxonomy, **cost-per-verified-task as the
   headline metric**, cross-version trends.
8. **Adaptive routing** — model selection driven by task features + failure
   history (beyond today's static tier table).
9. **Memory upgrade** — provenance/version/expiry for chunks; separate
   *fact* vs *project convention* vs *one-off debug conclusion*; recall reasons.

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
