# Development backends shared by DSH and MCP

## Documentation, screenshot comparison and plugin precheck

The existing build plugin and MCP server also share four optional tools through
`lib/recommended-tools.mjs` and `plugins/dsh-build/recommended-runtime.mjs`:

| Tool | Backend and boundary |
| --- | --- |
| `dev_docs_search` | Resolve a public library ID through the official Context7 MCP service. Requires the installed `dsh-mcp-context7` bridge package. |
| `dev_docs_read` | Read documentation by the returned library ID. Queries go to Context7; do not send private code or credentials. |
| `dev_vision_diff` | Reuse the installed `dsh-vision-diff` PNG/diff/HTML modules. Writes a new report, difference image and self-contained comparison page. |
| `dev_plugin_check` | Reuse the locally verified precheck metadata checker. Returns Node/DSH/peer findings without installing packages or running scripts. |

`dev_plugin_check` reports `scope=metadata-only` and `trialBoot=not-run`.
Unknown requirements remain incomplete. Full isolated install/boot checking is
available through the installed DSH precheck panel; a metadata match is not a
successful boot. The local Windows precheck build fixes pnpm entry execution,
absolute Windows paths, runtime dependency lookup and child-process cleanup.

The Context7 connection uses the installed DSH MCP client and is lazy; it does
not add another SDK dependency. `CONTEXT7_API_KEY` is optional. Documentation
results are bounded to 60,000 characters. Query and library-version coverage
must be assessed from the returned sources, particularly for old frameworks.

Screenshot inputs must be absolute PNG paths, at most 64 MiB and 16 million
pixels each. `ignoreJson` is a JSON array of up to 100 rectangles. Rejected
regions cause an error rather than silently weakening comparison. Evidence
goes to `DSH_VISION_DIFF_DIR` or the DSH home's `vision-diff/mcp` directory. The
MCP adapter creates new run directories and does not automatically delete prior
evidence. Pixels changing does not establish that the new UI is incorrect.

Run `node mcp/recommended.integration.mjs <profile>` for real MCP discovery,
known-image differences, ignored regions, dimension changes, corrupt-input
rejection and compatible/incompatible metadata fixtures. Add `--live-docs`
to verify Context7 search and source-backed Prism documentation retrieval.

The existing `dsh-build` plugin and the toolchain MCP server expose the same six
`dev_*` tools through `lib/development-tools.mjs`. Optional runtime integration
lives in `plugins/dsh-build/development-runtime.mjs`; loading the toolchain does
not require those third-party packages to be installed.

| Tool | Operation |
| --- | --- |
| `dev_status` | Discover the four installed packages and report versions; this is not an execution check. |
| `dev_csharp` | Definition, reference, implementation and hover queries with one-based UTF-16 positions. |
| `dev_logs` | Filter one absolute log path by a Chinese time expression or date, with bounded lines and level statistics. |
| `dev_skills` | Search .NET skill descriptions or load a skill by exact name. It returns instructions, not a build result. |
| `dev_read` | Read a workspace file, reporting encoding, BOM, line endings and SHA-256. |
| `dev_edit` | Exact text replacement, requiring `allowWrite=true` and the hash from `dev_read`. |

## Dependencies and configuration

Install `dsh-fs-encoding`, `dotnet-skills`, `@dsh-lsp-packs/dsh-lsp-csharp`, and
`dsh-logtimeline` into a DSH profile, with versions compatible with that profile's
runtime. The C# integration also needs the matching `@deepseek-ai/dsh-lsp`,
`@deepseek-ai/dsh-lsp-stdio`, and `@deepseek-ai/dsh-tool-lsp` packages and an actual
language-server executable. A package being listed does not prove that its
executable or its project dependencies work.

| Variable | Meaning |
| --- | --- |
| `DSH_DEV_PROFILE_DIR` | Profile containing the installed backends. Falls back to `DSH_PROFILE_DIR`, then `$DSH_HOME/profiles/web`. |
| `DSH_CSHARP_SERVER` | Optional language-server executable override. Otherwise read `lsp-csharp.config.command` from the profile patch, then use `omnisharp`. |
| `DSH_LOG_PYTHON` | Optional Python executable override. Otherwise read `logtimeline.config.pythonBin`, then use `python`. |

The C# adapter reads server arguments and settings from the profile's
`lsp-csharp` row. OmniSharp 2 uses `--languageserver --encoding utf-8`; the old
language pack's `--stdio` default does not select this protocol. The adapter
retains one workspace's language-server context and disposes it when changing
workspaces or closing the MCP connection. C# queries have a configurable
1–120 second deadline. Log queries have a 30 second deadline and run Python with
UTF-8 output, no shell, no LLM, and no bytecode-cache writes.

Set `DSH_TOOL_PROFILE=dev` to expose these tools plus the common infrastructure;
the default profile exposes all tools. The distinct `dev_*` names avoid
collisions with standalone DSH plugins. Installing this bridge does not replace
the host's built-in file tools. Encoding protection on the MCP side applies
when the caller uses `dev_read` and `dev_edit`.

## Scope and output limits

`repoRoot` is explicit for C# and encoding operations. File realpaths must remain
inside that root. Encoding operations accept existing files up to 2 MiB. Reads
return up to 1,000 lines; text results are capped at 60,000 characters with a
truncation flag. C# locations are capped at 200. Log output is capped at 500
lines; `maxLines=0` returns statistics. Returned source or logs become agent
input and are not a promise of offline model processing.

Edits reject absent write authorization, stale hashes, ambiguous text matches,
unsupported encodings and workspace escapes. The upstream filesystem's version
guard checks for changes during the read/edit operation. Errors are returned as
`ok:false` and MCP `isError:true`; missing packages are `state:unconfigured`.
Preserving edits reject a backend configured with `normalizeToUtf8=true`.

## Licensing and deployment

The toolchain adapter contains no vendored third-party source. The encoding,
.NET skills and language-pack packages retain their MIT notices. LogTimeline
remains a separately installed GPL-3.0 package; the adapter runs its Python CLI
as a subprocess and consumes JSON. It does not copy that implementation into
the toolchain or change its license.

Deploy the existing build plugin and shared library files with
`node scripts/deploy-plugins.mjs --only dsh-build`. Reload the DSH plugin to use
the new wrapper. MCP connections already running older code need reconnecting;
`tools/list` on a newly started server is the authoritative registration check.

## Verification

- `node lib/development-tools.test.mjs` checks missing dependencies, write
  authorization, stale hashes, workspace boundaries and cancellation offline.
- With `DSH_DEV_PROFILE_DIR` pointing at installed, compatible backends, run
  `node mcp/development.integration.mjs` on Windows with .NET Framework 4.5.2
  reference assemblies. It starts the actual MCP server, checks discovery and
  annotations, exercises all four C# operations on a legacy x86 WPF-reference
  fixture, queries Chinese logs, and edits GBK/BOM/CRLF fixtures while rejecting
  stale or unauthorized writes.
  The profile path can also be supplied as the first command-line argument.
- The integration test isolates its logs, files and failure corpus. It does not
  compile or modify a user's application.
