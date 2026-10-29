# Rust MCP runtime

`native/toolchain` builds `dsh-toolchain`, a standalone stdio MCP server. HTTP,
bounded background jobs, job evidence and atomic report publication run in Rust.
The existing DSH panels and plugin registrations stay in JavaScript. Windows UIA
operations run in isolated Rust worker processes behind the existing JS driver.

## Build and launch

Development requires Rust 1.88+, the platform linker, Node and the existing MCP
SDK installation. Node is used to verify the generated tool catalog at build
time; the standalone executable does not need Node at runtime.

```powershell
npm install --prefix mcp
npm run build:runtime
& .\mcp\bin\win32-x64\dsh-toolchain.exe --native-only
```

Register that executable directly as an MCP command. Stdout contains only
newline-delimited JSON-RPC messages. Individual input messages are capped at
8 MiB and at most 32 foreground requests are admitted concurrently. The native-only catalog contains
`http_request`, `toolchain_job`, `toolchain_status` and the read-only UIA subset
of `ui_observe`. Its status tool reports runtime readiness; it does not certify
ETW, dump tools or source mapping. UIA requires Windows.

To retain all 68 existing tools, use the compatibility bridge:

```powershell
& .\mcp\bin\win32-x64\dsh-toolchain.exe --legacy-server "$PWD\mcp\server.mjs"
```

The legacy Node server starts only when an operation needs it. Hybrid HTTP uses
the existing JS tool wrapper with the Rust HTTP adapter, retaining automatic
failure-corpus recording and call provenance. Native-only HTTP returns failures
directly and does not enable the legacy failure corpus. Specialized
build, capture, memory, CLR diagnostics and verification rules continue using
their existing implementations. Hybrid UI observations also go through the JS
driver so observation IDs, snapshot authority, redaction, authorization and
action evidence remain in the same session. The driver delegates supported
execution to Rust. This mode still needs Node and the relevant existing tools;
68 available tools does not mean 68 tools have been reimplemented in Rust. Harness² trial and experience tools are hybrid-only: native-only returns an explicit unavailable result because the Node orchestration core and scoped experience store remain the source of truth.

The embedded catalog is generated from the actual Node MCP `tools/list`,
including its complex schemas and annotations. After changing tool interfaces:

```powershell
node scripts/export-native-tools.mjs
node scripts/export-native-tools.mjs --check
```

## Existing plugin integration

Existing launchers keep their current defaults. Enable individual adapters in
the host environment and restart that host:

| Variable | Value and purpose |
| --- | --- |
| `DSH_RUNTIME_EXE` | Absolute path to the built executable; required when the host profile does not contain `mcp/bin` |
| `DSH_RUNTIME_BACKEND` | `rust` enables HTTP, task and report-storage adapters together |
| `DSH_HTTP_BACKEND` | `rust` or `js`, overrides the shared backend selection |
| `DSH_TASK_BACKEND` | `rust` or `js`, overrides the shared backend selection |
| `DSH_EVIDENCE_BACKEND` | `rust` or `js`, controls report publication, not adjudication rules |
| `DSH_UI_BACKEND` | `rust` enables the supported UIA executor paths |
| `DSH_LEGACY_MCP_SERVER` | Absolute path to `mcp/server.mjs` for specialized task execution |
| `DSH_NODE_EXE` | Optional Node executable for the compatibility bridge |

The Rust CLI loads the existing `DSH_ENV_FILE` convention. The file overrides
inherited `DSH_*` string settings and rejects `DSH_CRED_*`. Unlike the JS host's
environment helper, the CLI does not read the Windows environment registry:
pass settings through the MCP registration, process environment or env file.
No existing MCP registration or running host is switched by building this crate.

## Task and storage behavior

- Two execution slots and at most 32 additional admitted tasks; resource locks
  serialize UI, build, memory-index and ETW jobs. Saturation returns `TASK_BUSY`.
- `asyncJob`, `requestKey` and `jobTimeoutMs` preserve the existing task flow.
  The Rust HTTP tool also accepts these parameters. `toolchain_job` polls,
  returns the result artifact path or requests cancellation.
- Request keys bind to the tool and arguments across restarts. Different
  arguments return `TASK_KEY_CONFLICT`. Unfinished records from another process
  become `unknown`; they are never resumed or replayed automatically.
- Deadlines include queueing. A queued cancellation never invokes the executor.
  Cancellation of a running effect may produce `unknown`, never an unsupported
  claim that a remote operation was undone.
- `harness_trial` never uses the Rust task adapter: `runTaskTool`
  (`lib/task-tool-support.mjs`) routes it to the JS task service even when
  `DSH_RUNTIME_BACKEND=rust`. The Rust runtime models no `harness:<dir>`
  resource and its deduplication identity omits the submitted config
  fingerprint, so routing it there would drop per-directory serialization and
  the "config changed after submission is refused" guard. The JS path keeps
  both. Revisit this exclusion if the Rust adapter gains harness resources and
  identity fields.
- Task records live in `<DSH_TASK_DIR>/rust-v1` (default beneath the toolchain
  home). The separate directory avoids mixing old and new lock protocols.
  Task IDs and results from the old service remain owned by that service.
- Report JSON keeps the existing format and `DSH_VERIFY_DIR`. Rust writes and
  flushes a same-directory staging file before atomically replacing each JSON
  file. This is not a multi-file database transaction or a power-loss guarantee.
  Failure-corpus adjudication, recurrence processing and report bundles remain
  in the JS layer.

## HTTP behavior

Rust preserves the 2 MiB retained-body budget, streamed decompression, original
response headers, UTF-8 boundary handling, final/requested URLs and redirect
reporting. Non-2xx responses are successful transport results. Timeouts include
response-body reads; caller cancellation closes the response. Every redirect
rechecks the existing operator-control endpoint rule, and cross-origin
redirects remove authorization, cookies and host headers. Transport errors do
not echo request URLs or header values. There are no automatic request retries.

## UIA scope

Native execution supports exact-name/AutomationId `find`, `read`, `state`,
`state-live`, `click`, `setvalue`, `doubleclick` and semantic `scroll`.
Value writes are read back; scroll reports before/after percentages. Double
click uses physical screen coordinates, live identity/hit checks and bounded
input sequences. Process DPI awareness is configured before opening UIA.

The Rust UIA worker is a per-driver line protocol server. Its COM apartment,
`IUIAutomation`, cache request, window handles and successful exact-selector
targets are reused across serial requests. Window and target caches are bounded
to 32 and 64 entries; cached targets are revalidated for process, name and
AutomationId before reuse. A changed page or stale provider falls back to a
fresh UIA query. `warmStatus` exposes the native worker's alive/queued state.

Each request has its own worker. A stuck provider can be terminated without
blocking the MCP loop; a timed-out effect is reported as unknown and never
replayed. Window ambiguity is rejected until the caller supplies a handle.
Controls are looked up again for every action; disabled/offscreen controls are
not acted on. Enumeration budgets, skipped properties and narrowed scope are
reported. Sensitive input values are not returned, and the focused-control
check is independent of the enumeration limit.

The JS driver still applies its authorization, snapshot and emergency-stop
rules. Regex/scoped/waiting selectors, target references, credential expansion,
screenshots, keyboard/drag actions and configured per-control deny policies use
the existing executor, selected before dispatch. When a double-click provider
can resolve only the window, Rust returns `notExecuted` before sending input;
the driver can then use the existing executor and explicitly reports
`backend=powershell` and `nativeFallback=UIA_PROVIDER_ROOT_HIT`. Other failures,
timeouts and unknown outcomes are never replayed. C# WPF injection and CLR
diagnostics are unchanged.

## Validation

Local results and the live UI acceptance boundaries are recorded in
[native-runtime-validation.md](native-runtime-validation.md).

```powershell
npm run test:runtime-native
npm run test:runtime
node scripts/export-native-tools.mjs --check
cargo fmt --manifest-path native/toolchain/Cargo.toml --check
cargo clippy --locked --manifest-path native/toolchain/Cargo.toml --all-targets -- -D warnings
```

The integration suite starts loopback HTTP fixtures and isolated evidence
directories. It verifies native-only operation with an unavailable Node command,
protocol schemas, concurrent status during blocked I/O, response caps, gzip
header parity, cancellation, deduplication/restart and the 68-tool bridge.
`scripts/native-ui-check.mjs` accepts an explicit target PID and one JSON action
for authorized live validation. `DSH_NATIVE_UI_REPORT` optionally saves the
result; screenshots remain in the normal UI evidence directory.

Large UI trees still incur UIA provider/COM costs. The Rust implementation has
not established a general speedup over the existing warm PowerShell executor.
Windows x64 is the validation target; other platforms are not certified here.
