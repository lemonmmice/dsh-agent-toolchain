# Every tool, at a glance

55 tools, all generated from [`lib/tool-registry.mjs`](../lib/tool-registry.mjs) so the DSH plugin
face and the MCP face cannot drift apart. `Read` = the registry marks it read-only (safe to call with
no permission); `Write` = it can change something — a file, a process, a client window, a running
capture — and therefore carries the gate described in
[docs/ui-drive-safety-boundary.md](./ui-drive-safety-boundary.md) (UI actions additionally require
`allowSideEffects=true`).

> Two faces, one registry: on the MCP face the `capture_*` family is named identically, and every
> other name matches. Parity is asserted by `lib/toolface-parity.test.mjs`, not by discipline.

## Orientation — start here

| Tool | | What it does |
| --- | --- | --- |
| `toolchain_status` | Read | Environment self-check: is the target client running, is a source root configured (that is what decides whether you get `file:line`), are the dump/trace tools present, are you admin. Every value is reported **with its source**, and things it cannot check are reported as unchecked. |

## Build

| Tool | | What it does |
| --- | --- | --- |
| `build_run` | Write | Runs MSBuild or `dotnet build` and returns structured errors (`file/line/col/code/message`). Incremental by default; `Rebuild` for the final verdict; can run in the background. |
| `build_status` | Read | Last build result: target, duration, error count, log path. |
| `build_errors` | Read | Re-parses errors/warnings out of the **last** build log — and says so, because "last" is not necessarily "yours" when several agents share a machine. |
| `build_compile_check` | Read | Whether one source file is actually **in the compilation set**. Legacy projects do not auto-include new files, so "0 errors" can coexist with "your file was never compiled". Three states: in, provably not, or **cannot be read**. |

## UI — observe (read-only)

| Tool | | What it does |
| --- | --- | --- |
| `ui_observe` | Read | The read-only entry point: `find` / `read` (real values of inputs) / `state` (window + focus + interactive controls) / `windows` / `waitfor` / `expectwindow` / `expecttext` / `waitany` / `shot`. |
| `ui_state` | Read | One-step snapshot of "what is on screen": focus, interactive controls with `#index`, AutomationId, enabled flag and the real value of inputs. |
| `ui_windows` | Read | All top-level windows of the target process **plus nested window elements inside the main window** — the login/modal dialogs that never appear in a top-level list but do cover your controls. |
| `ui_tree` | Read | In-process visual tree: real control types, Name, AutomationId, DataContext type. Falls back to a UIA hierarchy dump when the injector is unavailable — and says which one you got. |
| `ui_status` | Read | Process and window existence only (running / PID / title / geometry). Deliberately **not** a statement about what is inside, or whether it is responsive. |
| `ui_live` | Write | Starts a background loop that keeps capturing window frames so the agent can *see* the UI change; not foreground-stealing, does not restore a minimised window. |

## UI — act (gated)

| Tool | | What it does |
| --- | --- | --- |
| `ui_act` | Write | One real action: `click` / `setvalue` / `key` / `type` / `drag` / `pattern` (invoke the UIA pattern the element actually exposes) / `scroll` / `selecttext` / `clickat`. Requires `allowSideEffects=true`; values are read back and verified. |
| `ui_drive` | Write | The full single-step driver, same gate as `ui_act`, plus read actions and per-action waits. |
| `ui_flow` | Write | A step sequence with assertions, evidence and screenshots, executed in one process; emits `replay.json`. |
| `ui_jev` | Write | Jev-driven UI decisions: sends a **sanitized** control list to Jev, which picks one bounded candidate, then the same deterministic executor and gates perform it. Every action is guarded by `requireUnique` (exactly one match) and a drift gate (window handle + element rectangle), so a decision made a second or two ago cannot land on a screen that has since changed. It stops rather than retries on low confidence, deferral, ambiguity or drift — and reports how many controls it could not address at all. |
| `ui_replay` | Write | Replays a `ui_flow` recording, re-checking application identity and authorisation. |
| `ui_launch` | Write | Starts the target client and waits for its main window. `force=true` kills a running instance first — do that **only after** capturing the evidence you cannot get back. |

## Performance and hangs

| Tool | | What it does |
| --- | --- | --- |
| `perf_probe` | Write | Measures UI-thread message-pump latency (P50/P95/P99 + over-threshold stall events). **Only** the UI thread; each report prints what the method cannot see. |
| `perf_report` | Read | The last probe report, with its own timestamp and a staleness warning. |
| `perf_dump` | Write | Takes a full dump of the current moment and analyses it: UI-thread managed stack + top lock holders, with source mapping when a source root is configured. |
| `perf_analyze` | Read | Runs the ClrMD analysis over an existing dump. |
| `perf_heap` | Read | Managed-heap type statistics (count + bytes) for leak screening — heap only, and it says so. |
| `perf_gcroot` | Read | GC-root retention paths: **who is keeping this object alive**, layer by layer. |
| `perf_trace` | Write | ETW sampling: `start` → reproduce → `stop`/`run`. Optional parallel CLR, allocation and JIT-method sessions. |
| `perf_hotstacks` | Write | Hottest functions plus a butterfly view (callers ⟷ callees) from a trace — the answer to "what keeps calling this". |
| `perf_flame` | Write | CPU flame graph (self-contained HTML + folded stacks) from a trace. |
| `perf_allocflame` | Write | Allocation flame graph: who is creating GC pressure. |
| `perf_clrevents` | Write | GC counts/pauses, managed heap and lock contention summarised from a CLR-enabled trace. |
| `perf_uifreeze` | Write | UI-freeze view (how many freezes, how long each, which managed call chain) in the style of dotTrace/PerfView. |
| `perf_clean` | Write | Deletes large evidence (`.dmp`/`.etl`) after listing what would go; `confirm=true` required. |
| `hang_run` | Write | Starts hang **monitoring** (it never clicks). When the hang happens it collects an evidence pack automatically. |
| `hang_status` | Read | Is monitoring running — pid, exit code, log tail. |
| `hang_stop` | Write | Stops monitoring; collected packs are kept. |
| `hang_packs` | Read | Lists evidence packs (newest first) with dump size, screenshot presence and analysis state. |
| `hang_pack` | Read | Full contents of one pack: summary, timeline, process info, net-trace tail, tool logs. |
| `hang_analyze` | Write | Managed thread stacks from the pack's dump, mapped to project source when a source root is configured. |
| `hang_delete` | Write | Deletes evidence packs locally and irreversibly; requires `confirm=true`. |

## Network capture and HTTP

| Tool | | What it does |
| --- | --- | --- |
| `capture_start` | Write | Starts live capture by tailing the client's System.Net trace log — and says up front whether that log exists, instead of looking like it is capturing. |
| `capture_status` | Read | Whether capture is running, how big the trace log is, how many records were parsed, whether caller attribution is available, and a duplicate-write self-check. |
| `capture_stop` | Write | Stops capture (and says that subsequent queries return history, not live traffic). |
| `capture_query` | Read | Queries the capture store: method, host, status, duration, size, body, caller attribution, errors, time range. |
| `capture_append` | Write | Appends records to the store (used when importing traffic from an external tool). |
| `http_request` | Write | Sends an HTTP request from the host (no browser CORS) and returns status, headers, body and duration. |

## Memory (cross-session)

| Tool | | What it does |
| --- | --- | --- |
| `memory_save` | Write | Stores a scoped key → value memory; refuses content that looks like a secret. |
| `memory_recall` | Read | Reads one key back. |
| `memory_forget` | Write | Deletes one key. |
| `memory_index` | Write | Indexes a directory incrementally (by mtime) so it can be searched semantically. |
| `memory_search` | Read | Semantic search over indexed content, returning the matching fragments and their source files. |
| `memory_status` | Read | Index size, KV count, **and which embedding backend is in use** — because that decides whether content leaves the machine. |

## Failure corpus

| Tool | | What it does |
| --- | --- | --- |
| `failure_record` | Write | Records one failure manually — for what the system cannot see (human handoffs, tool misbehaviour). Facts, not blame. |
| `failure_query` | Read | Queries the corpus by text, class, tag or time; retracted records are excluded by default and reported. |
| `failure_stats` | Read | Totals, recency and per-class counts, with the accounting for rotated shards so a shrinking total is explainable. |
| `failure_retract` | Write | Marks a record as wrongly filed — append-only, and a reason is mandatory. |

## Adjudication and optional layers

| Tool | | What it does |
| --- | --- | --- |
| `verify_report` | Write | Turns a closing summary into a claims list and adjudicates each claim against machine evidence (build record / capture store / file / compiled / command / git / manual) → one verdict: `pass`, `incomplete` or `fail`. Contradicted claims land in the failure corpus as `agent-misjudge`. |
| `jev_decide` | Write | Optional advisory typed decision layer. Off the network unless `allowRemoteData=true`; never executes the selected action. |

---

**Reading the `Write` column correctly:** it is the registry's own classification, not a severity
scale. `perf_hotstacks` and `hang_analyze` are marked `Write` because they *produce files* (a report,
a cached analysis), not because they touch your client. The tools that actually change the world are
the `ui_act`-family and `perf_clean` / `hang_delete` — and those are the ones with an explicit gate.
