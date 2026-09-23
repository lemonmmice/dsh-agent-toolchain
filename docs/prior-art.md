# Prior art, provenance and acknowledgements

> Why this file exists: this repository cites its sources in code comments — and a reader could
> never see them collected in one place. This is that place: **what we learned from, what we took,
> what we deliberately did not take, and where each borrow landed in this codebase.**
>
> Written 2026-09-23. Every claim below is either a `file:line` in this repository, or an artifact
> described by the path it lives at.

## How this project was built

This is not a solo-typing project, and saying so is the point — the repository is a working
example of the thing it advocates.

- **One implementer, two independent reviewers, and the reviewers are a different vendor's model.**
  Work is implemented here, then handed read-only to **Codex** and **Claude** separately, each with a
  task brief that asks for *falsification* rather than agreement ("the valuable output is what I
  claimed without evidence, and counter-examples that break it"). Findings are answered one at a
  time: accepted and fixed, or rebutted with evidence. The reviewer may not be agreed with — several
  rounds end with two accepted findings and two rebuttals.
- **Every accepted finding is pinned as a test**, not as a paragraph. That is why dozens of test
  files name the round and the finding (`Codex r30`, `Codex r37`, `@codex r54`, `Codex 第十二轮` …):
  a review conclusion that is not executable decays immediately.
- **Review results are adjudicated, not asserted.** The review outcome itself was run through the
  same claims-vs-evidence machinery this repository ships: see the local `verify_report` records
  `review-round-20260911`, `codex-review-20260911`, `w2-codex-claim-audit-20260911`.
- **The failure corpus records who found what.** `docs/failure-corpus.md` defines the taxonomy that
  stores these outcomes, including the one class a machine can catch on its own: `agent-misjudge`
  ("the agent claimed success, the evidence disagreed").

**Where the review reports live:** the reports themselves were working documents kept **outside this
repository** on purpose (they quote local paths and are not written for publication). The record that
survives *in* this repository is: the findings that changed code, each pinned by a test, plus the
outcome lists in the plugin docs. If you are looking for the raw reports, they are not here — see
[Review records: what exists and what does not](#review-records-what-exists-and-what-does-not).

## OpenAI Codex — codex-rs (github.com/openai/codex, Apache-2.0, Copyright 2025 OpenAI)

A **76-file subset** of the `codex-rs` workspace was kept locally for study while these mechanisms
were designed; the directories retained were `core`, `core-plugins`, `guardian-context`, `ext`,
`tools`, `protocol`, `app-server-protocol`, `config`, `features`, `tui`.

**No Codex source is vendored into this repository and no file was copied.** What was taken is
*interface shape, policy structure and naming discipline*; every implementation here is an
independent re-implementation in TypeScript / PowerShell / Rust. Evidence for that claim, and its
limit: a scan of this repository for copied-source markers finds none, and `native/**/*.rs` contains
zero Codex references — that is evidence of absence for *stated* copying, **not** a formal
code-provenance audit.

| Codex area (upstream path) | What it does upstream | What this repository took | Where it landed here |
| --- | --- | --- | --- |
| `core/src/tools/call_trace.rs` | a trace milestone per direct / code-mode tool call: **identifiers and names only, never arguments or output** | the same discipline, from the same motive (a trace that cannot leak a payload) | `lib/tool-trace.mjs`, wired at `mcp/server.mjs:63` |
| `tools/src/tool_spec.rs`, `core/src/tools/handlers/*_spec.rs`, `core-plugins/src/tool_suggest_metadata.rs` | a tool described **once, as data** — spec, schema and suggestion metadata — instead of hand-wired per surface | one shared metadata registry per tool, with both surfaces generated from it so they cannot drift | `lib/tool-registry.mjs` (55 tools; parity asserted by `lib/toolface-parity.test.mjs`) |
| `core/src/tools/code_mode/execute_spec.rs` + `wait_spec.rs` | separate "start long work" from "wait for it", so a caller holds a handle instead of blocking | the yield-or-handle execution shape for long builds | `plugins/dsh-build/lib/builder.mjs:773`, `build_run` `background` |
| `core/src/tools/handlers/view_image_spec.rs` (+ `features/src/lib.rs`) | an image returns as an **image content block**, not as a path the model must then go and read | the same shape: append an MCP image block on top of the existing text result | `mcp/inline-image.mjs` |
| `core/src/guardian/*` — `approval_request`, `coverage`, `decision`, `input_budget`, `request_budget`, `prompt`, `review`, `review_session*`, `reviewer_config` | the approval layer: **policy is chosen elsewhere, core enforces permissions**; every approval keeps its issuing context and its cancellation; coverage, risk level and input/request budgets bound the reviewer | the whole write-side gate design: explicit `allowSideEffects=true` for anything that clicks or types, an operational kill switch above every action, a deny-first policy table, and a freshness gate that rejects actions aimed at a stale UI | `plugins/dsh-ui-drive/lib/evidence.mjs`, the policy/estop implementation, `docs/ui-drive-safety-boundary.md` |
| `guardian-context/*` — especially `enforcement.rs`, `budget.rs`, `composition.rs`, `transcript.rs` | fit composed evidence into the remaining request allowance; **optional evidence leaves first, required action evidence is never truncated**, every reduction reserves an omission notice and preserves source order | reduction order and the "never silently shrink required evidence" rule; truncation is announced with the original size | `lib/output-budget.mjs` and its tests |
| `ext/guardian-v2/src/async_scorer/*` | an asynchronous second-model scorer wired into the decision path (score → approval → authorization), with its own config and classifier instructions | the idea that a review verdict is a *separate, reviewable artifact* with its own budget, not a sentence inside the main flow | `lib/verify/report.mjs` (verdict + per-claim detail + evidence), `docs/verification-report.md` |
| `config/src/computer_use.rs`, `config/src/browser_computer_use_requirements.rs`, `app-server-protocol/src/protocol/v2/{computer_use,browser_use}_config.rs` | computer-use access control: a default allow/deny, then **per-target rules — macOS by bundle id, Windows by AUMID plus exe publisher / product / binary name** | identify the target application *before* acting, and treat version metadata as an optional second constraint rather than the primary identity (the driver's own comment records measuring an agent CLI's exe metadata and finding it empty) | `plugins/dsh-ui-drive/scripts/ui-drive-batch.ps1` process-identity checks |
| the CUA action vocabulary (`performSecondaryAction`, `scroll(index, …)`, `selectText`) | act on the element's *exposed capability* instead of a screen coordinate | the same principle: invoke the UIA pattern an element actually exposes (`Expand` / `Collapse` / `Increment` / `Toggle` / `Select` / `ScrollIntoView` …), and refuse the action when the element does not expose it | the `pattern` action in `plugins/dsh-ui-drive`; `plugins/dsh-ui-drive/test/input-primitives.test.mjs` |
| `core/src/mcp_tool_exposure.rs`, `core/src/session/mcp.rs`, `protocol/src/mcp.rs` | one tool set, exposed consistently to MCP clients | "one toolchain, every agent": one registry drives both surfaces, enforced by a parity test rather than by discipline | `mcp/server.mjs`, `lib/toolface-parity.test.mjs` |
| `tui/src/history_cell/*` (`exec`, `mcp`, `mcp_result`, `patches`, `computer_activity`, `search`) | render layer shaped by the **producing event type**, one cell kind per activity kind | render-vs-producer alignment: every producer `action` must have a render branch, asserted per plugin so a new branch cannot be added without its renderer | the `render-*.test.mjs` suites under `plugins/*/test/` |
| `core/src/context/world_state/tools.rs`, `core/src/function_tool.rs` | the model's view of the available tools is a *context section*, not global mutable state | keep the tool surface declarative and derivable, so "what the model sees" is reproducible | `lib/tool-registry.mjs` |

### Deliberately not taken

A review round also produced an explicit **"do not copy" list**, and it is the more useful half:
`tool_search` / deferred loading (this toolchain is far below the scale where discovery needs a
retrieval round trip), the v1/v2 dual-protocol split, OS-level sandbox profiles, TUI rendering
internals, and long governance prose in tool descriptions.

### Three identifiers we cite that are *not* in the local subset

Our comments name `truncate_middle`, `performSecondaryAction` and `selectText`. None of them appears
in the 76-file copy kept locally — they come from other parts of Codex (or another version) that were
not retained. The truncation mechanism *is* present under different names
(`codex_utils_output_truncation::truncate_text`, `protocol::TruncationPolicy`). This is noted so the
next reader does not conclude the local subset is the whole basis of the borrows.

## Codex as a subject, not only a source

`bench/harness/bench.mjs` implements a full Codex CLI adapter — `--agent codex`, parsing the
`exec --json` JSONL stream, `$CODEX_HOME/<profile>.config.toml` layering, and the knowledge that
Codex has no `--max-turns`. `bench/pilot/report.md` §16 reports a cross-model wave against it, and
deliberately discloses the asymmetry: a Codex `exec` turn can contain many tool calls and it reports
no USD cost, so **turn counts and cost are not comparable across agents** — the report says so rather
than ranking them.

## Other prior art

- **Harness engineering as a discipline** — the framing this project works inside comes from
  Anthropic's writing on harness design for long-running agents and OpenAI's on harness engineering,
  plus Mitchell Hashimoto's formulation that the unit of progress is *"whenever you find the agent
  making a mistake, spend the time to design a solution so it never makes that mistake again"*.
  This repository's failure corpus is that sentence turned into storage.
- **PerfView** — the perf plugin's trace, hotstacks, flame and GC views are built against PerfView
  as the reference implementation, including where they still fall short. See
  [docs/perfview-parity.md](./perfview-parity.md) — it lists the remaining gaps rather than only the
  matches.
- **ClrMD / DumpStack, ETW (xperf/WPR), WinDbg (cdb)** — the dump and trace routes are wrappers with
  parsing around these tools; `docs/native-stacks.md` records the four traps that cost real time
  (including that the Store-packaged `cdb` cannot be executed from its install directory).

## Review records: what exists and what does not

Honest inventory, because a citation to a file that cannot be produced is worse than no citation.

- **In this repository:** the *findings* are here — as code comments naming the round
  (`Codex r30`, `Codex r37`, `@codex r54`, `Codex 第十二轮`), as assertions pinned in tests, and as
  the numbered fix list in `plugins/dsh-ui-drive/README.md`.
- **Not in this repository, by design:** the raw review reports. They were written as local working
  documents.
- **A gap we cannot explain:** the local review directory that held the 2026-09-11 reports
  (`review-codex-20260911.md`, `review-claude-20260911.md`, `review-outcome-20260911.md`) **is no
  longer on disk**, and the two cleanup records we can find do not account for it:
  the large-file cleanup manifest lists only dumps and traces, and the `bench-runs` archive manifest
  covers a different directory (and documents reverted content rather than removals). Searching the
  whole evidence root for those filenames returns nothing. **Their disposal is currently
  unexplained.** Some of their content survives outside the repository, in the 2026-09-11 chat-room
  archive, which still contains one review report verbatim and the other's conclusions.
- **What we changed as a result:** the plugin documentation no longer points readers at those two
  filenames; it states the findings instead. See `plugins/dsh-ui-drive/README.md`.

## Appendix: the studied subset, module by module

Why an appendix: the borrow table above answers "what did you take". This answers the question a
developer actually asks next — **"what was in the box, and what does each part do?"** The subset kept
locally was 76 files across ten packages of the `codex-rs` workspace.

How to read it. Descriptions quoted in the *What it does* column are **upstream's own module doc
comments** (`//!`), copied from the local subset — they are the authors' words, not our summary.
Where a module carries no doc comment, the description is the module name plus, for the
`handlers/*_spec.rs` family, the pattern verified by reading `view_image_spec.rs`
(`create_*_tool(...) -> ToolSpec`, building a JSON schema and a tool definition). The *Used here?*
column is our own status and never a claim about upstream.

Legend: **✔ borrowed** (see the table above) · **◐ partly** · **○ read, not adopted** ·
**— studied, not applicable to us**.

### `core/src/guardian/` — approvals and the isolated reviewer (13 modules)

| Module | What it does | Used here? |
| --- | --- | --- |
| `mod.rs` | "Hosts approval decisions and the isolated synchronous reviewer. The extension chooses policy and evidence; core enforces permissions and mandatory review requirements. Each approval retains its issuing context and cancellation." | ✔ the separation itself (policy elsewhere, enforcement in the core) |
| `decision.rs` | "Calls the decision extension for each approval and enforces host constraints. The synchronous service captures one action; no outcome is stored by tool-call ID." | ✔ per-action decisions with host-enforced constraints |
| `coverage.rs` | "Supplies action categories to the review extension and enforces host-owned requirements." | ◐ categories + host-owned requirements |
| `approval_request.rs` | The shape of an approval request (no module doc). | ✔ the request envelope |
| `input_budget.rs` | "Finalizes a pending reviewer input after tools and turn context are resolved." | ✔ budgeted reviewer input |
| `request_budget.rs` | "Measures and checks complete synchronous requests after wire prefix assembly. Includes reused history, tool definitions, output format and continuations." | ✔ the "measure the whole request, not the delta" rule |
| `prompt.rs` | Reviewer prompt assembly (no module doc). | ○ |
| `review.rs` | "Supplies host review preparation, interruption and runtime configuration. Guardian's extension owns the synchronous review loop and pool." | ◐ |
| `review_request.rs` | "Captures and reports one review on the host's original action and authorization state." | ✔ the reviewable artifact |
| `review_session_context.rs` | "Owns sync reviewer checkpoint and invalidation policy for both context modes." | ○ |
| `review_session_factory.rs` | "Prepares opaque session inputs for the extension-owned reviewer pool." | ○ |
| `reviewer_config.rs` | "Applies extension-owned reviewer settings to host configuration and builds context. Managed constraints, live network rules and policy prompt construction stay in the host." | ○ |
| `revisit_session_context.rs` | Reviewer session revisit handling (no module doc). | ○ |

### `guardian-context/` — composing bounded evidence for a reviewer (9 modules)

| Module | What it does | Used here? |
| --- | --- | --- |
| `enforcement.rs` | "Fits newly composed evidence into the remaining complete-request allowance. **Required action evidence is never truncated.** Optional evidence leaves first; hosts may shorten historical instructions after compaction cannot make room. Every reduction reserves an omission notice and preserves source order." | ✔ the reduction order and the never-silently-shorten rule |
| `budget.rs` | "Payload-free accounting for composed sections and complete Guardian requests. Text and image bytes stay separate." | ✔ separate text/image accounting |
| `composition.rs` | "Composes collected evidence into ordered sections with explicit delivery. Profiles retain the host-selected transcript slice; composition owns framing, message boundaries and section placement, without retaining history." | ◐ |
| `transcript.rs` | "Collects bounded conversation evidence before consumer-specific rendering. Both Guardian consumers receive the same role and tool-source attribution." | ○ |
| `action.rs` | "Planned-action prompt framing shared by the two production reviewers. Hosts serialize complete actions; whole-request admission bounds the input." | ✔ complete actions, bounded input |
| `authorization.rs` | "Shared root-conversation and host-verified answer sections. Hosts resolve and bound these inputs before collection." | ○ |
| `images.rs` | "Bounded image selection shared by Guardian consumers. Keeps source order and evicts oldest images using the existing count/byte caps." | ○ |
| `profile.rs` | "Resolved Guardian evidence profiles and pure transcript retention. Sync keeps recent entries; async protects approvals/final answers and evicts in cacheable chunks." | ○ |
| `node_repl.rs` | "Renders a borrowed, bounded host snapshot of completed REPL responses." | ○ — we host no JS REPL; shell sessions go through `dsh-win-terminal-inspector` |

### `ext/guardian-v2/src/async_scorer/` — the asynchronous second-model scorer (6 modules)

| Module | What it does | Used here? |
| --- | --- | --- |
| `extension.rs` | The extension that wires an asynchronous scorer into the decision path (no module doc). | ◐ the idea of a separate, reviewable verdict artifact |
| `approval.rs` | "Owns approval routing and the choice between cached evidence and a fresh assessment. **Registration does not depend on the async scorer starting successfully.**" | ✔ degradation is not a failure |
| `action.rs` | "Renders complete planned-action JSON or rejects it for synchronous review. Action arguments cannot be shortened to fit the asynchronous classifier budget." | ✔ never shrink the thing being judged |
| `authorization.rs` | "Binds cached classifier results to the user authorization and model policy they evaluated." | ✔ a cached verdict is bound to the policy version that produced it |
| `config.rs` | Scorer configuration (no module doc). | ○ |
| `classifier_instructions.md` | The classifier's instructions, shipped as an asset. | ○ |

### `app-server-protocol/` and `protocol/` — the wire types

| Module | What it does | Used here? |
| --- | --- | --- |
| `app-server-protocol/schema/typescript/v2/Guardian{ApprovalReview,ApprovalReviewAction,ApprovalReviewStatus,RiskLevel,UserAuthorization}.ts`, `AllowDenyRequirement.ts` | Generated TypeScript schemas ("GENERATED CODE! DO NOT MODIFY BY HAND!") for review status, risk level, user authorization and allow/deny requirements. | ◐ the vocabulary: status, risk, authorization, allow/deny as first-class typed values |
| `protocol/src/mcp.rs` | "Types used when representing Model Context Protocol (MCP) values inside the Codex protocol." | ○ |
| `protocol/src/openai_models/guardian.rs` | "Model-owned Guardian coverage. Missing policy preserves legacy behavior; **unknown modes retain synchronous review and never enable the fast path**." | ✔ unknown → the safe path, never the fast one |

### `config/` — computer-use access control

| Module | What it does | Used here? |
| --- | --- | --- |
| `computer_use.rs` | `ComputerUseConfigToml`: a **default allow/deny**, then per-target rules — macOS by `bundle_ids`, Windows by `aumids` and `exes` carrying `publisher_name` / `product_name` / `binary_name`. Read in full during this study. | ✔ identify the target before acting; version metadata as a second constraint |
| `browser_computer_use_requirements.rs` | The requirement model that backs those per-target decisions (`allow_locked_computer_use`, …). | ◐ |

### `core/src/tools/` — the tool layer (and the tool set itself)

| Module | What it does | Used here? |
| --- | --- | --- |
| `call_trace.rs` | "Trace milestones for every direct or code-mode tool call handled by core. **These events contain call identifiers and names, never arguments or output.**" | ✔ `lib/tool-trace.mjs` |
| `code_mode/execute_spec.rs`, `code_mode/wait_spec.rs` | The code-mode execute and wait tools — start work, then wait on a handle. | ✔ the yield-or-handle shape (`build_run` background) |
| `executed_tool_calls/seen_ids.rs` | "Tracks seen call and runtime cell IDs with bounded memory. **Bits are never cleared: collisions can withhold a proof, but cannot make an observed ID appear fresh again.**" | ✔ fail-safe by construction (a false "seen" is acceptable, a false "fresh" is not) |
| `handlers/shell_spec.rs` | The shell tool's definition (`exec_command`). | ✔ yield-or-handle |
| `handlers/view_image_spec.rs` | The image tool: `create_view_image_tool(...) -> ToolSpec`; images come back as image content blocks, not as paths to go read. | ✔ `mcp/inline-image.mjs` |
| `handlers/apply_patch_spec.rs` | The patch-application tool's definition. | ○ |
| `handlers/plan_spec.rs` | The planning tool. | ○ |
| `handlers/request_user_input_spec.rs` | The tool that asks the human a question. | ◐ (human handoffs exist here as a failure-corpus class rather than a tool) |
| `handlers/tool_search_spec.rs` | Tool discovery / deferred loading — needed when a tool set is large enough that the definition itself is the context cost. | ○ — explicitly on the "do not copy" list; this tool set is 55 tools shown in full |
| `handlers/mcp_resource_spec.rs` | Reads MCP resources. | ○ |
| `handlers/multi_agents_spec.rs` | Sub-agent spawning and messaging. | ○ |
| `handlers/get_context_remaining_spec.rs` | Reports the remaining context budget. | ○ |
| `handlers/extension_tools.rs` | Tools contributed by extensions. | ◐ (our plugins contribute tools, but through one registry) |
| `handlers/list_available_plugins_to_install_spec.rs`, `handlers/request_plugin_install_spec.rs` | Plugin discovery and install request. | ○ |

### The remaining packages

| Module | What it does | Used here? |
| --- | --- | --- |
| `tools/src/tool_spec.rs` | The tool-spec type itself — one definition per tool, as data. | ✔ `lib/tool-registry.mjs` |
| `core-plugins/src/tool_suggest_metadata.rs` | Suggestion metadata attached to tools. | ◐ |
| `core/src/function_tool.rs` | The function-tool representation. | ○ |
| `core/src/mcp_tool_exposure.rs`, `core/src/session/mcp.rs` | How MCP tools are exposed into a session. | ✔ one tool set, exposed consistently |
| `core/src/context/world_state/tools.rs` | The model's view of available tools as a context section. | ◐ |
| `core/src/context/guardian_tool_descriptions.rs` | "**Bounded, untrusted** descriptions for the exact MCP action under review." | ✔ text coming back from the UI/MCP side is treated as untrusted input |
| `core/src/turn_metadata.rs` | Per-turn metadata. | ○ |
| `core/assets/guardian/policy.md`, `policy_template.md`, `node_repl_policy.md` | The Guardian policy documents shipped as assets — including the rule to treat truncation markers as omitted data. | ◐ policy as a reviewable file |
| `features/src/lib.rs` | "Centralized feature flags and metadata." | ◐ |
| `tui/src/history_cell/{mod,base,exec,mcp,mcp_result,patches,computer_activity,search}.rs` | The transcript cell model: "A `HistoryCell` is the unit of display in the conversation UI"; `mcp_result.rs` keeps "width-independent display content retained after an MCP call completes", validating multi-megabyte bodies. | ✔ render layer shaped by producer type — the `render-*.test.mjs` suites here |

### What the subset deliberately leaves out

The local copy is a slice, not a mirror: the rest of the workspace (model clients, sandboxing,
auth, the TUI's rendering internals) was never retained, and the review round's "do not copy" list
lives on in the borrow table above.

