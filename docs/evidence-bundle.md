# Verification evidence bundles

`verify_report({ runId, task, claims, context: { repoRoot }, bundle: true })` also writes
`<DSH_VERIFY_DIR>/<runId>.bundle/` and returns `bundlePath`.

- `manifest.json`: `dsh-evidence-bundle/1`, task/verdict/time/producer/report, optional HEAD,
  artifact paths, kinds, SHA-256 hashes, byte sizes and original sources, plus omissions.
- `trace.jsonl`: time-ordered original claims with adjudication, same-run build records,
  failures whose `context.runId` matches, capture metadata and matching UI evidence.
  Capture request/response bodies stay at their source and are referenced by shard line.
- `payloads/`: copies of the report, build records/logs, file evidence and small screenshots.

Files are limited to 10 MiB and the complete bundle to 50 MiB. Dump files are never copied.
Oversized, unavailable or unscannable sources are listed in `omitted`. UI directory traversal
is capped at 10,000 entries; only explicit runId associations count. Existing UI records
without a runId are not inferred to belong to the report.

When `context.repoRoot` is present, git HEAD and the tracked staged/unstaged diff are collected
with a five-second subprocess timeout. Untracked files are not part of `git diff HEAD`.
Missing git or an invalid repository adds an omission. Bundle failures return and persist
`bundleError` while the verification report and its verdict remain unchanged. Use a unique
runId for each bundle: an existing bundle directory is preserved and reported as an error.
