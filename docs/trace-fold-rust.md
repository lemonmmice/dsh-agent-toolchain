# CPU/allocation trace folding in Rust

## Scope and behavior

`foldDumperCsv` and `foldAllocCsv` now use `native/trace-fold/` through the lazy
Node-API adapter `plugins/dsh-perf/lib/native-fold.mjs`. Existing tool calls,
Promise return types, folded Maps, summary fields and HTML rendering remain.

The first pass streams only the relevant event rows to JS in batches capped at
4096 matches or 8 MiB scanned, plus the last complete line. JS retains the
original process RegExp and PID-set filtering, including global/sticky RegExp
state and lookbehind. Allocation byte parsing and type-name extraction stay in
JS, preserving generic type names containing commas.

The second pass runs in a native worker, scans Stack rows, joins the selected
timestamp/thread keys and emits aggregated folded stacks. It preserves root-to-
leaf reversal, optional adjacent recursion folding, first-cluster deduplication,
insertion order, CPU sample weights and allocation-byte weights. JIT lookup uses
arbitrary-width integer addresses, PID-specific method tables and the existing
half-open interval/binary-search behavior. Invalid address syntax stays unresolved
as it did with JS BigInt; num-bigint's more permissive separators/signs are rejected.

One file handle spans both passes. Size, modification and creation metadata are
checked before/after scanning; input changes produce `TRACE_CHANGED` rather than
a mixed result. Analysis never writes to the trace. Scan/fold tasks run on the
native worker pool; bounded process filtering and final summaries run on JS.
Memory still grows with selected sample keys, JIT methods and unique output
stacks. A very large single line can exceed the normal batch byte target.

xperf collection/export, symbol downloads, JIT XML construction, UI-wait/CLR XML
analysis, existing C# diagnostic tools and flame HTML rendering were not migrated
in this step. Timings below measure only offline CSV processing.

## Measured result

Windows x64, Node.js 24.15.0, Rust 1.98.1. Synthetic 45 MiB CSV, 30000 CPU samples
and allocation ticks, 24 frames per sample, 24000 target samples. Includes
non-target processes and unrelated CSwitch stacks. Five runs per implementation,
alternating baseline/native order, symbols mode. Every timed result is deeply
compared to the frozen JS implementation from Git `6887521`.

| Operation | Previous JS median | Rust-backed median | Ratio |
| --- | ---: | ---: | ---: |
| CPU stack folding | 1603.27 ms | 598.16 ms | 2.68x |
| Allocation stack folding | 1595.79 ms | 634.98 ms | 2.51x |

These are local small-sample results with OS file caching, not an end-to-end ETW
collection speed claim. Small traces may not benefit because native task dispatch
and module loading have fixed costs.

Reproduce:

```powershell
npm run build:trace-fold
npm run bench:trace-fold -- 30000 5
```

## Verification

- Full repository regression: **107 JS test files passed, zero failures**
  (214.1 seconds). A focused perf rerun covers the final malformed-address and
  worker-timer assertions.
- Five Rust tests cover JS numeric parsing, arbitrary-width JIT addresses,
  half-open intervals, first-cluster/byte-weight behavior, CRLF split at the
  stream buffer boundary and changed-file rejection.
- JS differential tests compare every output field and Map order for CPU and
  allocation traces: randomized events, duplicate samples, unmatched waiting
  stacks, global/sticky/lookbehind regexes, PID filtering, overlapping input
  categories, malformed fields, empty files, CR/LF/CRLF, Unicode names, comma-
  containing generic symbols and JIT boundary/malformed-address cases.
- The same test checks folded text/tree equality, missing files, changed input,
  closed readers, JS timer progress during work and unchanged input metadata.
- An isolated deployment fails before copying if its binary is missing, then
  parses successfully from a profile path containing spaces when complete.
- Rustfmt, Clippy and repository sanity checks are run locally. Windows DLL
  dependency inspection lists only system DLLs, without a separate VC runtime.

The reference parser is test-only and is not a production fallback. Missing
native binaries report the build command. Remote CI and non-Windows builds have
not been run; no real ETW capture, live profile deployment or host restart was
performed for this migration.

## Build and distribution

Build with Rust and the platform linker; Windows needs Visual C++ build tools.
Ship `plugins/dsh-perf/bin/<platform>-<Node architecture>/trace-fold.node` with the
plugin, then restart its host. `DSH_TRACE_FOLD_NATIVE` overrides the binary path.
Node-API version 6 is used, and Windows builds statically link the CRT. Windows
x64 is validated. The script also offers Linux GNU/macOS offline-parser targets,
which do not make the Windows xperf collection tools cross-platform.
