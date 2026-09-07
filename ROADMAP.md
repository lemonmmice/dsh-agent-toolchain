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
- Release discipline — CHANGELOG, v0.1.0 tag + GitHub Release, compatibility matrix
- Failure corpus v0 — lib + MCP record/query/stats, fixed taxonomy, seed script; data collection started
- dsh-memory hygiene — mtime-incremental indexing, stale-chunk eviction, fail-closed sensitive-string filter
- Self-recording failure corpus — build/ui/http failure paths auto-record; manual recording reserved for human-handoff
- Capture moat exposed — MCP capture_query/capture_append (caller attribution) for any MCP client
- Evidence-adjudicated verification report — claims checked against build records / capture store / files (machine verdicts, not self-rating); contradicted claims auto-record agent-misjudge
- runId spine — build logs + per-run records named by runId; capture records carry runId; verify/corpus keyed by runId
- dsh-verify shell — the DSH closing-adjudication surface: closing summary becomes a claims list, same engine as MCP

## Now — next 1–2 weeks

1. **Tier 1-② benchmark pilot** — in progress: harness landed
   (`bench/harness/bench.mjs`, baseline vs toolchain MCP on a real T2 bugfix
   from a public MIT WPF repo; task identity local-only, public repo ships
   methodology + anonymized numbers). Next: pilot runs, report, then scale to
   5 tasks.
2. **Teaching artifacts** — demo GIF/asciinema, the "20-line first DSH plugin"
   tutorial, blog series.

## Deliberate non-goals (decision log)

- **perf / hang-inspector are NOT in the MCP server yet.** Reason: dump attach
  needs a permission model and heavy payloads (hundreds of MB per dump);
  expose them after the capability policy lands (Year-1 #6). api-visualizer
  IS exposed — lightweight store reads, highest leverage first. This is a
  choice, not an omission.

## Year 1 — the verifiable closed loop

4. **Unified verification run (full pipeline)** — the v0 report container
   (lib/verify + verify_report, MCP + DSH shells shipped) graduates into
   automatic assembly: `runId` ties together diff, build log, UI screenshots,
   API records, perf data → `verification-report.json/html`.
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
