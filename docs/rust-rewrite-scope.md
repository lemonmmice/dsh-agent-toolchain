# Remaining Rust migration assessment

Decision: stop after the four completed components for now. The remaining
candidates do not have enough demonstrated benefit to justify another migration.
This assessment changes no production implementation.

## Remaining XML parsing cost

Measured on Windows x64, Node.js 24.15.0, three runs per size. Synthetic XML was
generated from the checked-in JIT-rundown and CLR-GC fixtures. Each generated
event/method count was verified after parsing. JIT timing includes file reading,
method extraction, BigInt addresses and per-process sorting; CLR timing includes
file reading, event parsing and summary generation. The OS file cache was not
flushed. These are isolated parser timings, not measurements of user traces or
the whole ETW workflow.

| Dataset | Size | Median |
| --- | ---: | ---: |
| JIT, 2000 methods | 3.13 MiB | 56.64 ms |
| JIT, 20000 methods | 31.28 MiB | 325.58 ms |
| JIT, 100000 methods | 156.40 MiB | 1843.35 ms |
| CLR, 2000 events | 2.19 MiB | 29.55 ms |
| CLR, 20000 events | 21.91 MiB | 234.57 ms |
| CLR, 100000 events | 109.56 MiB | 1108.84 ms |

Both production paths first invoke tracerpt for ETL decoding. JIT already reads
XML as a stream, and this assessment found no real workload establishing either
parser as the dominant current cost. A rewrite might reduce the isolated times,
but no Rust comparison was built, and no end-to-end improvement is claimed.

## Other candidates

- UI waiting: both `plugins/dsh-perf/index.js` and `mcp/server.mjs` call
  `prf().uiFreeze`, implemented in `plugins/dsh-perf/lib/perf.mjs`. That path uses
  PerfView and the C# UiFreezeStacks tool. The older `uifreeze.mjs` CSV analyzer
  remains exported through `makeTrace`, but is not the backend selected by those
  public tool entry points. Optimizing it would miss their active path.
- C# diagnostics: UiFreezeStacks uses Microsoft.Diagnostics.Tracing.TraceEvent;
  HeapRoots uses Microsoft.Diagnostics.Runtime (ClrMD). Retaining these engines
  avoids reimplementing specialized CLR/ETW decoding and symbol behavior.
- UI automation: `driver.mjs` already enables a persistent PowerShell process
  and batches operations. A Rust rewrite would require reproducing UIA, WPF
  integration and lifecycle behavior; no remaining startup bottleneck was
  demonstrated here.
- Build/MCP/report orchestration and browser panels: these coordinate external
  operations or present results. No measured CPU bottleneck supports rewriting
  those layers.

Revisit XML/native migration if real traces repeatedly spend a material share
of analysis time in these parsers, or if large XML causes measured memory
pressure. At that point capture read/parse/decode timings and peak memory
separately, then compare a bounded prototype against the existing behavior.

The completed migrations remain: terminal process collection, capture storage,
memory vectors, and CPU/allocation CSV folding. Their individual reports contain
performance results, validation and deployment requirements. No live profile,
trace session or user data was changed during this assessment.
