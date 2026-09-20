# dsh-win-terminal-inspector

Windows process inspection for DSH persistent terminals. The JS plugin keeps the
host integration, children-first process trees, 300 ms snapshot cache and ConPTY
Ctrl-C delivery. A small Rust executable replaces the PowerShell/CIM query.

## Build and install

On Windows, install the Rust MSVC toolchain and Visual Studio C++ build tools.
From the repository root:

```powershell
npm run build:terminal-inspector
npm run test:terminal-native
node scripts/run-tests.mjs dsh-win-terminal-inspector
```

The build uses the checked-in Cargo.lock and stages the executable at
`bin/win32-<Node architecture>/dsh-process-table.exe` inside this plugin. Build
with the same Node architecture as the DSH host (x64, arm64 or ia32), with the
corresponding Rust target and MSVC libraries installed. Only Windows x64 is
currently exercised by CI. Build cache stays outside the plugin directory.

Copy the whole plugin, **including bin/**, into the profile. The repository's
`scripts/deploy-plugins.mjs` includes it and refuses to deploy this plugin if its
helper has not been built. Restart the host after deployment. CI publishes the
helper as a workflow artifact; the executable is not committed to Git.

The release build statically links the MSVC runtime. Rust, Cargo, a separate VC++
redistributable, and PowerShell are not required to query processes after deployment.
`taskkill.exe` remains in use for the existing termination behavior.

| Setting | Purpose |
| --- | --- |
| `DSH_TERMINAL_PROCESS_TABLE_EXE` | Optional executable path override; defaults to the plugin's architecture-specific binary. |
| `DSH_BASH_PATH` | Optional Git Bash path for the existing host argv rewrite. |

## Snapshot contract

The helper takes no arguments and emits one JSON array on stdout:

```json
[{"pid":123,"ppid":45,"session":1,"created":"2026-01-01T00:00:00.123Z"}]
```

It uses Toolhelp32 for PID/parent enumeration, GetProcessTimes for UTC creation
time, and ProcessIdToSessionId for the Windows session. It requests only limited
query access and closes all owned handles. It does not change privileges or
read command lines, environment variables, or process memory.

Processes that exit during collection or deny access remain visible with a null
creation time. A missing creation time cannot satisfy `isAlive`/`snapshot.alive`
or authorize `signalProcess`. Snapshot enumeration errors fail the entire query
with a nonzero exit and stderr diagnostic. There is no silent PowerShell fallback;
a missing binary reports the build command. The upstream synchronous snapshot
interface is retained, so collection still briefly blocks Node.

## Verification and timing

The native-backend test compares owned process identities with the previous CIM
backend, checks cache expiry, exited children, unknown identities and copied
plugin paths containing spaces. The existing process-tree test exercises real
child termination. PowerShell exists only in the test reference backend.

```powershell
npm run bench:terminal-inspector
# Optional sample count (3–30):
node plugins/dsh-win-terminal-inspector/test/bench-process-table.mjs 9
```

Timing includes executable startup, collection and JSON parsing. Results are
machine-specific; no timing threshold is used as a correctness test.
See the [migration validation report](../../docs/terminal-inspector-rust.md) for
measured timings and the existing live ConPTY PID-readiness limitation.
