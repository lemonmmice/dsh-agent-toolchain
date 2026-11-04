# dsh-agent-toolchain (MCP) — usage guidance

A local toolchain MCP server (`dsh-agent-toolchain`) is attached to this
session. It packages the coding verification loop as structured tools.
Prefer it over re-implementing the same loop by hand in Bash:

- **Build loop**: after changing code, run `build_run` (default: incremental
  Build). It returns a structured error list (file/line/col/code/message) and
  the log path. Fix errors and re-run until the list is empty. Hard rules:
  never claim compilation success while `build_run`/`build_errors` still
  report errors; a final "the solution builds" conclusion requires a
  successful Rebuild (`target=Rebuild`); an incremental Build success only
  supports an "incremental build passed" claim. `build_status` reads the last
  build result, `build_errors` re-parses errors from the last log.
- **UI verification**: when a desktop UI is involved, `ui_status` reports the
  target process/window state; `ui_drive` performs single-step UI automation
  (find/read/shot are read-only; click/setvalue/key are real side effects).
- **Also available**: `http_request` (server-side HTTP), `capture_append` /
  `capture_query` (record/query API traffic), `memory_*` (long-term memory).

This guidance mirrors what a real dsh-agent-toolchain installation injects
into the agent's system prompt; it is not task-specific.
