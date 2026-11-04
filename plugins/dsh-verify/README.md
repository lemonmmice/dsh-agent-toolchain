# dsh-verify

The DSH toolchain-status and Harness² surface. The name **`dsh-verify`** is retained for
historical / id-stability reasons — it no longer does closing verification. It now hosts four
tools and carries zero logic of its own; each is a thin shell over shared `lib/` code.

## Tools

- `toolchain_status` — environment self-check: is the target client running, is a source root
  configured (that is what decides whether you get `file:line`), are the dump/trace tools present,
  are you admin. Every value is reported **with its source**, and anything it cannot check is
  reported as unchecked. Diagnostics run in bounded workers; completed snapshots are cached for two
  seconds, and `fresh=true` bypasses the cache, with `observedAt`, `completedAt`, `ageMs` and
  `source` on each result.
- `toolchain_job` — read a long-task status/result or request cancellation by `jobId`. Accepted is
  not completed, and unknown side effects are never replayed.
- `harness_trial` — run or inspect a bounded single-round Propose–Probe–Compose trial. Trials accept
  a local absolute JSON configuration, execute the bounded Harness² orchestration through the shared
  core, and persist status/result under `DSH_HARNESS_DIR` (default
  `~/.dsh-agent-toolchain/harness`). Frozen machine checks decide adoption; unknown effects are never
  replayed.
- `harness_experience` — query or export scoped Harness² lessons and record evidence-backed
  validate/retire transitions. Queries are scoped; validation requires independent supporting trials,
  and model confidence alone cannot promote a lesson.

When the Rust runtime is native-only, `harness_trial` and `harness_experience` are hybrid-only.

## Notes

The failure corpus and the `lib/verify` engine still exist, but they are **internal** now: the
MCP server records failures automatically and the Harness² feature reuses the engine. There is no
longer an agent-callable verification or failure-corpus tool on either face.

See [docs/harness2-integration-design.md](../../docs/harness2-integration-design.md) and
[docs/harness2-executor.md](../../docs/harness2-executor.md).
