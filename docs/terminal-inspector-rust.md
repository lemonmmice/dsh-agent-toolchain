# Terminal inspector Rust migration

Validated on 2026-09-20, Windows x64, Node.js 24.15.0, Rust 1.98.1.

## Scope

The process-table backend now uses a plugin-local Rust executable instead of
starting PowerShell/CIM. The host plugin, synchronous inspector interface,
300 ms cache, process-tree ordering and ConPTY signal routing remain in JS.
Unknown creation times cannot satisfy an identity match. The native collector
also rejects identities created after snapshot collection began, to avoid
pairing a recycled PID with an earlier parent row.

Source: `native/windows-process-table/`. Build and installation instructions:
[plugin README](../plugins/dsh-win-terminal-inspector/README.md).

## Measured result

Each sample starts a fresh helper and includes collection plus JSON parsing.
The two backends alternate order. Approximately 272 processes were present;
these are small-sample local timings, not general throughput claims.

| Backend | Median | Min | Max |
| --- | ---: | ---: | ---: |
| Rust release, static CRT | 34.39 ms | 32.75 ms | 35.61 ms |
| Previous PowerShell/CIM | 1369.24 ms | 1339.02 ms | 1458.09 ms |

Median speedup: **39.8x**. The synchronous contract still blocks Node during
collection. The staged executable is 244224 bytes; `dumpbin /DEPENDENTS`
reported only Windows system DLLs, without VCRUNTIME140.dll.

## Verification

- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`: passed.
- Deployment test: a temporary source checkout missing its binary fails before
  copying any plugin; a complete checkout deploys and runs from a profile path
  containing spaces, with a different working directory.
- Repository sanity gate: passed.

## Live ConPTY limitation

The installed DSH runtime's full terminal check did **not** pass. Its
`LocalTerminalHandle` copies `terminal.pid` before node-pty publishes the PID:
both start at 0, but after 300 ms node-pty has a valid PID while the handle still
contains 0 and has no root identity. Foreground inspection/interrupt therefore
fails. An isolated comparison reproduced the same sequence with **both** the
Rust backend and the previous PowerShell/CIM backend.

The fixture was updated to supply the current runtime's logger,
`terminalType` and `shellDialect` fields. The PID readiness issue remains in the
installed runtime and is outside this collector migration. No live profile was
deployed or restarted during verification.
