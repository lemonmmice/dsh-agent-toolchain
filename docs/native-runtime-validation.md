# Rust runtime validation — 2026-10-19

Local Windows x64 validation of the optional runtime in `native/toolchain`.
Existing host registrations were not changed. The release executable is staged
under `mcp/bin/win32-x64/`; specialized tools still use the compatibility bridge.
The closing `verify_report` run `rust-runtime-20261019` returned `pass` for four
machine-checked claims: release build, MCP integration, Rust unit tests and the
saved live/JS evidence assertions. This verdict applies to those claims only.

## Automated checks

- Existing JavaScript suite, including heavy tests: 219 files, zero failures.
- Rust unit tests: six passed. They cover storage replacement/lock contention,
  resource serialization, bounded admission, queued deadlines, uncertain running
  effects, durable deduplication, restart recovery and protected HTTP endpoints.
- Native MCP integration: initialization/catalog/schema validation, Node-free
  core calls, HTTP streaming limits/UTF-8/gzip headers, redirects, cancellation,
  concurrent status, durable jobs, all 56 bridge tools, report publication,
  automatic HTTP failure recording and caller turn metadata.
- Existing Postman tests with `DSH_HTTP_BACKEND=rust`: five files passed.
- Existing verification-report tests and all 11 plugin load checks passed.
- Cargo Clippy with warnings denied, rustfmt, catalog freshness and repository
  syntax/private-reference/schema checks were also exercised locally.

The full JS suite ran before the final native selector optimization. The native
contract tests and live selector checks were then repeated. CI wiring was added;
no remote CI run or production-profile deployment is claimed.

## Live WPF client

The user supplied an already-running desktop client and explicitly requested
real UI operations. Tests used its PID and window handle, observed controls and
window-scoped screenshots. No client rebuild or restart was needed.

| Operation | Observed result | Executor |
| --- | --- | --- |
| Read and find | Visible controls and exact selectors returned with scope/budget metadata | Rust |
| Single click | Period selection changed from unselected to selected | Rust |
| Page navigation | Switched to the conditions page, later returned to the original strategy page | Rust |
| Input | Numeric field changed from 3 to 4, read back, then restored to 3 | Rust |
| Scroll down/up | Vertical position changed 0 → 72.2139 → 0 percent; screenshots confirmed different visible content | Rust |
| Double click | Input text became selected; final result explicitly carried `UIA_PROVIDER_ROOT_HIT` compatibility metadata | PowerShell compatibility |
| Four-step flow | Native write/read/navigation/restore completed; a later period-switch/read/restore/read flow also completed | Rust |
| Timeout | A forced 1 ms read timeout terminated the worker and did not replay input | Rust |

The first observation following the forced timeout returned a stale-element
error (`0x80040201`); a subsequent fresh observation succeeded. This is not a
claim that every provider request immediately succeeds after cancellation.
The existing executor also failed its first bulk enumeration earlier in the
session. Neither failure was reported as an empty, complete UI tree.

The client's UIA hit test resolved only the window for the tested input field.
Native double-click therefore reported `notExecuted` before sending input.
The existing executor was verified at the same observed location; the integrated
driver then used that compatibility path and labelled it as PowerShell. Native
double-click is not certified for that provider.

High-DPI rectangles were checked against a 2560×1380 window capture. Exact
selectors initially caused thousands of individual node reads. After moving
filtering into UIA, the period observation materialized four matching candidates
and returned two visible controls; one local call decreased from about 10.6 s
to 2.5 s. These single-call observations are not a benchmark against the warm
PowerShell implementation or a general Rust speedup claim.

The original page, input value and scroll position were restored. Live artifacts
remain in the local toolchain evidence directory and the gitignored
`.dsh-agent-toolchain/rust-ui-*.json` files. The saved full JS report and
`verify-rust-live.mjs` in that directory allow the observed assertions to be
checked without replaying UI actions.

Multi-instance switching, secure/locked desktops, all DPI/monitor combinations,
all UIA providers, real ETW collection and CLR diagnostic migration are outside
this acceptance run.

## Follow-up comparison with the existing backend

A subsequent read-only run on the same client and window alternated the old
PowerShell executor and the release Rust executor through the same shared
driver. UI figures are medians of five successful calls per selector and
backend. First-call figures are single samples with new driver instances;
operating-system caches were not cleared. No clicks or input were replayed.

| Operation | Existing backend | Rust backend |
| --- | ---: | ---: |
| First control lookup | 3774.82 ms | 3061.74 ms |
| Repeated exact-selector lookup | 2212.19 ms | 7.72 ms |
| First local HTTP request through the shared adapter | 22.56 ms | 68.55 ms |
| Repeated local HTTP request, median of 30 | 1.14 ms | 0.57 ms |

Every lookup confirmed one matching control. HTTP used an 8192-byte loopback
response and checked its complete body; all samples succeeded. These HTTP
figures do not measure a real backend service or the complete hybrid MCP path.

The first Rust lookup was about 19% faster. After the worker's COM/UIA session
and exact-selector cache were warm, repeated lookup was about 99.7% faster in
this selector-specific run. The cache is bounded and validates process/name/
AutomationId before reuse; a changed page falls back to a fresh query. This is
not a claim about uncached control-tree reads or full `state` snapshots.
Warm local HTTP saved about 0.57 ms, which is not evidence that business API
requests become twice as fast.

The reproducible script and raw samples are in the gitignored
`.dsh-agent-toolchain/bench-native-compare.mjs`,
`.dsh-agent-toolchain/bench-rust-session.mjs` and
`.dsh-agent-toolchain/runtime-comparison/comparison.json`.

After this follow-up run, the user-supplied process exited, so no later live UI
sample is claimed. Offline Rust build, Clippy, protocol and existing UI
regression checks remain the applicable validation for the final cache-boundary
changes.
