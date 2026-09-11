/**
 * dsh-agent-toolchain MCP server — stdio transport.
 *
 * Exposes the engineering-quality tools of the toolchain (build / ui-drive /
 * http_request / memory / failure corpus) to any MCP client:
 * Claude Code, Cursor, Cline, ...
 *
 * Env config follows the toolchain convention (DSH_* variables), e.g.:
 *   DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE  (ui tools)
 *   DSH_BUILD_CLIENT_ROOT / DSH_BUILD_REPO_ROOT / DSH_BUILD_MSBUILD / DSH_BUILD_LOGS_DIR / DSH_BUILD_PLATFORM (build)
 *   DSH_MEMORY_DIR (memory data dir, default ~/.dsh/memory)
 *   DSH_FAILURE_CORPUS_DIR (failure corpus, default ~/.dsh-agent-toolchain/failure-corpus)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { makePerf } from '../plugins/dsh-perf/lib/perf.mjs'
import { makeHangInspector } from '../plugins/dsh-hang-inspector/lib/hang.mjs'
import { sendRequest } from '../plugins/dsh-postman/lib/http.mjs'
import { DshMemory } from '../plugins/dsh-memory/lib/memory.mjs'
import { makeFailureCorpus, FAILURE_CLASSES } from '../lib/failure-corpus.mjs'
import { queryPage, appendRecords } from '../lib/capture-store.mjs'
import { makeVerificationReport } from '../lib/verify/report.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const server = new McpServer({
  name: 'dsh-agent-toolchain',
  version: '0.1.0',
})

// ---------------------------------------------------------------- shared

const text = (s) => ({ content: [{ type: 'text', text: s }] })

/**
 * Serialize a tool result AND set the protocol-level isError flag when the
 * payload itself says the call failed. Without this an MCP client sees
 * `isError: false` for `{ok:false}` / `{verdict:"fail"}` payloads and scores a
 * failed call as success — the system knows it failed, the agent does not.
 * (Reported by two independent external agents during the toolchain loop.)
 */
const jtext = (o) => {
  const isError = o !== null && typeof o === 'object' && (o.ok === false || o.verdict === 'fail')
  const r = text(JSON.stringify(o, null, 1))
  if (isError) r.isError = true
  return r
}

let driver = null
function drv() {
  if (!driver) {
    driver = makeDriver({
      scriptsDir: join(root, 'plugins', 'dsh-ui-drive', 'scripts'),
      procName: process.env.DSH_UI_PROC_NAME || '',
      windowName: process.env.DSH_UI_WINDOW_NAME || '',
      clientExe: process.env.DSH_UI_CLIENT_EXE || '',
      evidenceDir: process.env.DSH_UI_EVIDENCE_DIR || '',
    })
  }
  return driver
}

/**
 * Does this action require allowSideEffects? Single source of truth: the driver's
 * classifyAction owns the one action→kind table (read / effect / coord-effect /
 * input; unknown verbs default to 'effect'). We reuse it instead of re-listing
 * actions on the MCP surface — the previous pre-check hard-coded
 * ['click','setvalue','key'] and DRIFTED, silently missing type/drag (and drag is
 * a coordinate side effect, which is *more* dangerous, not less). By keying off
 * classifyAction the MCP pre-check can never miss a verb the driver already treats
 * as a side effect. We only name which *kinds* need auth here — a tiny, stable
 * predicate — not the action list. Applies to the ui_drive/ui_act vocabularies;
 * ui_flow adds read-only pseudo-actions (wait/expect) that classifyAction does not
 * know, so it keeps its own list (see the note there).
 */
const needsSideEffectAuth = (action) => ['effect', 'coord-effect'].includes(drv().classifyAction(action))

let memory = null
function mem() {
  if (!memory) memory = new DshMemory({})
  return memory
}

let perf = null
function prf() {
  if (!perf) {
    perf = makePerf({
      scriptsDir: join(root, 'plugins', 'dsh-perf', 'scripts'),
      procName: process.env.DSH_UI_PROC_NAME || '',
      windowName: process.env.DSH_UI_WINDOW_NAME || '',
      evidenceDir: process.env.DSH_PERF_EVIDENCE_DIR || '',
      srcRoot: process.env.DSH_PERF_SRC_ROOT || '',
    })
  }
  return perf
}

let corpus = null
function fc() {
  if (!corpus) corpus = makeFailureCorpus({})
  return corpus
}

let hang = null
function hng() {
  if (!hang) hang = makeHangInspector({})
  return hang
}

/**
 * System-recorded failure: the tool already knows the failure happened, so it
 * appends the record itself — the agent does not have to volunteer (and it
 * usually won't). The corpus must never break the tool it observes.
 */
function autoRecord(failureClass, tool, message, extra = {}) {
  try {
    fc().record({
      task: tool,
      failureClass,
      description: String(message).slice(0, 300),
      tags: ['auto', tool],
      context: { runtime: 'mcp', tool, ...(extra.context ?? {}) },
    })
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- build

server.tool(
  'build_run',
  'Run a build (incremental Build or full Rebuild) and return structured errors. ' +
    'Use after changing code to verify it compiles. Requires DSH_BUILD_CLIENT_ROOT/DSH_BUILD_REPO_ROOT (solution dir) or the clientRoot/repoRoot argument. ' +
    'Both engines auto-detect the default solution when project is empty: a repo containing WholeSolution.sln keeps the legacy client defaults (WholeSolution.sln + platform x86); otherwise the .sln/.slnx is detected (repo root, then one level deep) and the platform comes from the solution (Any CPU preferred) — ambiguity is an explicit error asking for project. engine=msbuild (default) uses VS MSBuild; engine=dotnet builds with `dotnet build` (restores by default) — prefer it for modern .NET repos. (dotnet only: a repo with no solution at all falls back to the cwd default.)',
  {
    target: z.enum(['Build', 'Rebuild']).default('Build').describe('Build (incremental, fast) or Rebuild (full)'),
    project: z.string().optional().describe('Optional csproj/sln path relative to the repo root; empty = auto-detected default solution (both engines; dotnet falls back to the cwd default when the repo has no solution)'),
    configuration: z.string().default('Debug'),
    platform: z.string().optional().describe('msbuild engine: default auto (legacy x86 for the WholeSolution.sln layout, otherwise detected from the solution); dotnet engine: ignored'),
    engine: z.enum(['msbuild', 'dotnet']).optional().describe('Build engine; env DSH_BUILD_ENGINE sets the default'),
    clientRoot: z.string().optional().describe('Solution root dir (env DSH_BUILD_CLIENT_ROOT)'),
    repoRoot: z.string().optional().describe('Repository root dir (env DSH_BUILD_REPO_ROOT)'),
    killClient: z.boolean().optional().describe('Kill the running client process before building (breaks the user UI — confirm first)'),
    runId: z.string().optional().describe('Optional run id: the build log and the per-run record (run-<runId>.json) are named with it — the evidence-pack spine'),
  },
  async (args) => {
    const b = makeBuilder({
      clientRoot: args.clientRoot || process.env.DSH_BUILD_CLIENT_ROOT || '',
      repoRoot: args.repoRoot || process.env.DSH_BUILD_REPO_ROOT || '',
      msbuild: process.env.DSH_BUILD_MSBUILD || '',
      engine: args.engine || process.env.DSH_BUILD_ENGINE || 'msbuild',
      logsDir: process.env.DSH_BUILD_LOGS_DIR || '',
    })
    const r = await b.build({
      target: args.target,
      project: args.project,
      configuration: args.configuration,
      platform: args.platform,
      killClient: args.killClient,
      runId: args.runId,
    })
    if (r.errorCount > 0) {
      const first = (r.errors && r.errors[0]) || (r.envErrors && r.envErrors[0]) || {}
      autoRecord('verification-failure', 'build_run', `build failed with ${r.errorCount} error(s); first: ${first.code ?? ''} ${String(first.message ?? '').slice(0, 160)}`, { context: { target: r.target ?? 'Build', engine: r.engine ?? '', code: first.code ?? '', ...(args.runId ? { runId: args.runId } : {}) } })
    } else if (r.ok === false) {
      // Failures that carry no parsed error (client-lock guard, missing SDK,
      // environment block) used to escape the corpus entirely.
      autoRecord('verification-failure', 'build_run', `build did not run: ${String(r.error ?? 'unknown').slice(0, 200)}`, { context: { target: r.target ?? 'Build', engine: r.engine ?? '', clientRunning: r.clientRunning === true, ...(args.runId ? { runId: args.runId } : {}) } })
    }
    return jtext(r)
  }
)

// ---------------------------------------------------------------- ui-drive

server.tool(
  'ui_status',
  'Check the target desktop client process / main-window status (read-only). Configure the client via DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE.',
  {},
  async () => jtext(await drv().status())
)

const uiAction = z.enum(['find', 'read', 'state', 'windows', 'shot', 'waitfor', 'click', 'setvalue', 'key', 'type', 'drag'])

server.tool(
  'ui_state',
  'UI snapshot (read-only, one step to see "what is on screen right now"): current main window + focused element + ' +
    'the interactive control list (buttons/edits/tabs/checkboxes/list items with #index, aid, enabled and the real input value). ' +
    'Prefer this over repeated read (which returns hundreds of text lines). match filters by control name regex; max caps the list (default 40).',
  {
    match: z.string().optional().describe('Regex filter on control names (e.g. 登录|验证码)'),
    max: z.number().optional().describe('Max controls returned, default 40'),
  },
  async (args) => jtext(await drv().drive({ action: 'state', match: args.match || '', max: args.max || 40 }))
)

server.tool(
  'ui_windows',
  'List every top-level window of the target client process (type / title / handle / position / offscreen). ' +
    'Read-only. The login window, a captcha popup or a modal dialog is often NOT the "main window" — check this first ' +
    'when driving a dynamic UI (login, page switch, popup), then decide where to act.',
  {},
  async () => jtext(await drv().drive({ action: 'windows' }))
)

server.tool(
  'ui_drive',
  'Drive the running desktop client via Windows UIA (real-time, stateful). Actions: find (locate a control) / ' +
    'read (visible controls, with the real input value and a #index reusable as `index`) / windows (all top-level windows) / ' +
    'shot (PNG; describe=true returns a vision description) / waitfor (wait until a condition holds: state=appear|gone|enabled|disabled) / ' +
    'click / setvalue (ValuePattern) / key (clipboard paste for CJK) / type (SendKeys sequence: {ENTER} {TAB} {ESC} {DOWN} ^a …) / ' +
    'drag (mouse drag, e.g. a slider captcha). ' +
    'For dynamic UIs: pass waitFor={ms,interval,state,match,index} on click/setvalue/key/type/find/expect to wait for the condition ' +
    'BEFORE acting (no more guessing sleeps); use index for the Nth same-named control and inAid/inName to scope the search to a container. ' +
    'find / read / windows / shot / waitfor are read-only; click / setvalue / key / type / drag are real side effects and REQUIRE allowSideEffects=true.',
  {
    action: uiAction,
    name: z.string().optional().describe('Control Name'),
    aid: z.string().optional().describe('AutomationId'),
    value: z.string().optional().describe('Value for setvalue/key/type (type accepts SendKeys syntax, e.g. 1234{ENTER})'),
    ascii: z.boolean().optional().describe('key: send ASCII directly instead of clipboard paste; type: treat {}^%~() as literal'),
    match: z.string().optional().describe('read: regex filter; on find/click: regex the control name matches (with index)'),
    index: z.number().optional().describe('Which match to use (0-based; reuse the #index from read)'),
    inAid: z.string().optional().describe('Scope the search to the subtree of this AutomationId container'),
    inName: z.string().optional().describe('Scope the search to the subtree of this Name container'),
    waitFor: z.record(z.string(), z.any()).optional().describe('Wait before acting: {ms?:5000, interval?:150, state?:"appear"|"gone"|"enabled"|"disabled", match?, index?}'),
    state: z.string().optional().describe('waitfor: appear (default) | gone | enabled | disabled'),
    keys: z.string().optional().describe('type: key sequence (same as value, clearer intent)'),
    fromX: z.number().optional().describe('drag: start X (client-area coords)'),
    fromY: z.number().optional().describe('drag: start Y'),
    toX: z.number().optional().describe('drag: end X'),
    toY: z.number().optional().describe('drag: end Y'),
    steps: z.number().optional().describe('drag: interpolation steps (default 12)'),
    holdMs: z.number().optional().describe('drag: pause before press/release (default 120)'),
    label: z.string().optional().describe('Screenshot file label (shot mode)'),
    describe: z.boolean().optional().describe('shot mode: also return a vision description of the screen'),
    waitMs: z.number().optional(),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true for click/setvalue/key/type/drag'),
    snapshotId: z.string().optional().describe('W1 freshness token returned by a prior read/state. When set, a side-effect action is rejected if the snapshot is stale (a newer read happened: staleSnapshot) or expired (client/serve restarted: expiredSnapshot). Omit to skip the freshness gate (legacy, zero-regression).'),
    diff: z.boolean().optional().describe('read only: return an incremental diff {added,removed,unchanged} vs the last full read instead of just the flat list'),
  },
  async (args) => {
    // Pre-check reuses the driver's classifyAction (single source) so it can never
    // drift from the write-side gate — this is what previously missed type/drag.
    if (needsSideEffectAuth(args.action) && !args.allowSideEffects) {
      return text('Blocked: action "' + args.action + '" is a real side effect. Re-call with allowSideEffects=true after confirming with the user.')
    }
    const r = await drv().drive({
      action: args.action,
      name: args.name,
      aid: args.aid,
      value: args.value,
      ascii: args.ascii,
      match: args.match,
      label: args.label,
      describe: args.describe,
      waitMs: args.waitMs,
      allowSideEffects: args.allowSideEffects,
      // W1 freshness token + read diff — forwarded so the driver's snapshot gate
      // actually receives them (before this they were undeclared and dropped:
      // the freshness gate was permanently no-snapshot on the MCP surface).
      snapshotId: args.snapshotId,
      diff: args.diff,
    })
    if (!r.ok) autoRecord('tool-error', 'ui_drive', `ui_drive ${args.action} failed: ${String(r.error ?? 'unknown error').slice(0, 200)}`)
    return jtext(r)
  }
)

server.tool(
  'ui_flow',
  'Run a whole UI verification sequence and collect evidence (find/read/windows/shot/wait/waitfor/expect are read-only; ' +
    'click/setvalue/key/type/drag need allowSideEffects=true). Steps: {action, name?, aid?, value?, keys?, ascii?, match?, index?, inAid?, inName?, waitFor?, state?, fromX?/fromY?/toX?/toY?, waitMs?, label?, expectEnabled?, expectMatch?}. ' +
    'waitFor on any action waits for a condition first (state=appear|gone|enabled|disabled); expect/waitfor count toward passed/failed. ' +
    'The sequence runs inside ONE PowerShell process (no per-step process start), so a 10-step flow takes ~1-2s. ' +
    'Every step output + screenshot is written to the evidence dir (steps.json); the returned transcript has passed/failed counts. ' +
    'For flows that must look at the screen between steps (login, captcha, branch on UI state), use ui_drive step by step instead.',
  {
    steps: z.array(z.object({
      action: z.enum(['find', 'click', 'setvalue', 'key', 'type', 'drag', 'read', 'state', 'windows', 'shot', 'wait', 'waitfor', 'expect']),
      name: z.string().optional(),
      aid: z.string().optional(),
      value: z.string().optional(),
      keys: z.string().optional(),
      ascii: z.boolean().optional(),
      match: z.string().optional(),
      index: z.number().optional(),
      inAid: z.string().optional(),
      inName: z.string().optional(),
      waitFor: z.record(z.string(), z.any()).optional(),
      state: z.string().optional(),
      fromX: z.number().optional(),
      fromY: z.number().optional(),
      toX: z.number().optional(),
      toY: z.number().optional(),
      waitMs: z.number().optional().describe('Post-action settle time; find/read/shot/expect/windows default to 0'),
      label: z.string().optional(),
      expectEnabled: z.boolean().optional().describe('expect: assert enabled state'),
      expectMatch: z.string().optional().describe('expect: regex the control detail must match'),
    })).describe('Step sequence'),
    tag: z.string().optional().describe('Evidence dir label (default flow)'),
    failFast: z.boolean().optional().describe('Stop at the first failed assertion'),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true when the sequence contains click/setvalue/key/type/drag'),
  },
  async (args) => {
    // Why this keeps its own list instead of reusing needsSideEffectAuth: flow's step
    // vocabulary includes the read-only pseudo-actions `wait` and `expect`, which are NOT in
    // the driver's classifyAction table — classifyAction would default them to 'effect' and so
    // wrongly demand allowSideEffects for a read-only flow. The driver applies the same
    // wait/expect exemption in flow()'s own gate. Keep this list in sync with the driver's real
    // side-effect verbs (click/setvalue/key/type/drag); the driver's flow() is the enforcing gate.
    const hasSideEffects = (args.steps || []).some((s) => ['click', 'setvalue', 'key', 'type', 'drag'].includes(s.action))
    if (hasSideEffects && !args.allowSideEffects) {
      return text('Blocked: the sequence contains a real side effect (click/setvalue/key/type/drag). Re-call with allowSideEffects=true after confirming with the user.')
    }
    const r = await drv().flow({
      steps: args.steps,
      tag: args.tag || 'flow',
      failFast: args.failFast === true,
      allowSideEffects: args.allowSideEffects === true,
    })
    if (r.failed > 0) autoRecord('verification-failure', 'ui_flow', `ui_flow assertion failure: ${r.failed}/${r.totalSteps} steps failed (evidence: ${r.stepsJson || r.evidenceDir || '?'})`)
    return jtext(r)
  }
)

// ---------------------------------------------------------------- ui observe / act (semantic split)

server.tool(
  'ui_observe',
  'Read-only UI observation (recommended entry point; no allowSideEffects needed). Actions: find / read (controls + real input values) / ' +
    'state (snapshot: window + focus + interactive controls) / windows / waitfor / expectwindow / expecttext / waitany / shot. ' +
    'The dynamic-UI loop is: ui_observe -> decide -> ui_act -> ui_observe. ' +
    'waitany is how you adjudicate a login: bet on "main window appeared", "error text appeared" and "login window still there" at once ' +
    'and get back which one hit (with stableCount confirmation to avoid transient states).',
  {
    action: z.enum(['find', 'read', 'state', 'windows', 'waitfor', 'expectwindow', 'expecttext', 'waitany', 'shot']),
    name: z.string().optional(),
    aid: z.string().optional(),
    match: z.string().optional(),
    textRe: z.string().optional().describe('expecttext / waitany(text): text regex (e.g. ErrorInfo)'),
    titleRe: z.string().optional().describe('expectwindow / waitany(window): window title regex'),
    gone: z.boolean().optional().describe('expectwindow: true = wait until the window disappears'),
    ms: z.number().optional().describe('Timeout ms (default 5000; waitany 15000)'),
    interval: z.number().optional(),
    state: z.string().optional().describe('waitfor condition: appear|gone|enabled|disabled'),
    waitFor: z.record(z.string(), z.any()).optional(),
    conds: z.array(z.record(z.string(), z.any())).optional().describe('waitany conditions: [{kind:"window"|"text"|"appear"|"gone"|"enabled"|"disabled", titleRe?, textRe?, name?, aid?, label?}]'),
    stableCount: z.number().optional().describe('waitany: consecutive confirmations before a hit counts (default 2)'),
    index: z.number().optional(),
    inAid: z.string().optional(),
    winTitle: z.string().optional().describe('Scope the search to the window whose title matches'),
    max: z.number().optional(),
    label: z.string().optional(),
    describe: z.boolean().optional().describe('shot: also return a vision description'),
  },
  async (args) => {
    const r = await drv().drive({ ...args, action: args.action })
    return jtext(r)
  }
)

server.tool(
  'ui_act',
  'Real UI action (side effects; allowSideEffects=true required): click / setvalue (use this for key-filtered fields such as a phone box) / ' +
    'key / type ({ENTER} {TAB} sequences) / drag (slider captcha). ' +
    'Input is read back and verified — a value that did not land is ok:false, never a silent success. Password/captcha fields are never echoed. ' +
    'Trading controls (buy/sell/order/pay) are hard-denied in the driver: allowSideEffects cannot unlock them. ' +
    'observe=true attaches a UI snapshot after the action. Credentials: pass ${cred:name}; the driver expands DSH_CRED_name from its own environment, ' +
    'so the secret never enters the model context or the evidence files.',
  {
    action: z.enum(['click', 'setvalue', 'key', 'type', 'drag']),
    name: z.string().optional(),
    aid: z.string().optional(),
    value: z.string().optional().describe('setvalue/key/type content; supports ${cred:name}'),
    keys: z.string().optional(),
    ascii: z.boolean().optional(),
    match: z.string().optional(),
    index: z.number().optional(),
    inAid: z.string().optional(),
    winTitle: z.string().optional(),
    waitFor: z.record(z.string(), z.any()).optional(),
    expectValue: z.string().optional().describe('type: expected value for the read-back check'),
    secret: z.boolean().optional().describe('Mask the value in output/evidence'),
    fromX: z.number().optional(),
    fromY: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    observe: z.boolean().optional(),
    observeMatch: z.string().optional(),
    waitMs: z.number().optional(),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true'),
    snapshotId: z.string().optional().describe('W1 freshness token from a prior read/state. When set, the action is rejected if the snapshot is stale (staleSnapshot) or expired (expiredSnapshot). Omit to skip the freshness gate. (ui_act forwards all args to the driver, so this reaches the same write-side gate as ui_drive.)'),
  },
  async (args) => {
    if (args.allowSideEffects !== true) {
      return text('Blocked: ui_act performs real side effects. Re-call with allowSideEffects=true after confirming with the user.')
    }
    const r = await drv().drive(args)
    if (!r.ok) autoRecord('tool-error', 'ui_act', `ui_act ${args.action} failed: ${String(r.error ?? 'unknown').slice(0, 200)}`)
    return jtext(r)
  }
)

// ---------------------------------------------------------------- perf

server.tool(
  'perf_probe',
  'Measure UI stutter: loops a window-message round trip against the target client main window, ' +
    'reports P50/P95/P99 and every event over the threshold. capture=log (default) only records; ' +
    'capture=shot screenshots the stall; capture=dump grabs a full dump on the first stall (hundreds of MB).',
  {
    seconds: z.number().default(60).describe('Sampling duration in seconds'),
    thresholdMs: z.number().default(500).describe('Stutter threshold in ms'),
    capture: z.enum(['log', 'shot', 'dump']).default('log'),
    intervalMs: z.number().default(300).describe('Sampling interval in ms'),
  },
  async (args) => {
    const r = await prf().probe(args)
    // perf reports stalls as stutterCount (not stallCount) — read the real field
    // or a genuine UI stall never reaches the failure corpus (external review).
    const stutters = r && (r.stutterCount ?? r.stallCount ?? 0)
    if (stutters > 0) autoRecord('verification-failure', 'perf_probe', `perf_probe saw ${stutters} stall(s) over ${args.thresholdMs}ms (p99=${r.p99Ms ?? '?'}ms, max=${r.maxMs ?? '?'}ms)`)
    return jtext(r)
  }
)

server.tool(
  'perf_report',
  'Read the most recent perf_probe report (P50/P95/P99 + stall events).',
  {},
  async () => jtext(prf().report())
)

// ---------------------------------------------------------------- hang inspector
//
// The panel's one-click hang workflow, on the MCP surface: start the hang-loop
// monitor (it never clicks anything itself — the human drives the client),
// then read the evidence packs it collected and run the ClrMD stack analysis.

server.tool(
  'hang_status',
  'Hang-inspector status (read-only): whether the hang monitor is running, its pid/exit code, and the last 150 log lines. ' +
    'Evidence packs live in DSH_HANG_EVIDENCE_DIR (default ~/.dsh-agent-toolchain/hang-evidence); list them with hang_packs.',
  {},
  async () => jtext(hng().runStatus())
)

server.tool(
  'hang_run',
  'Start the hang monitor (hang-loop.ps1): it watches the target client main-window responsiveness WITHOUT clicking anything — ' +
    'the user reproduces the freeze and the monitor collects an evidence pack on detection (frozen screenshot, timeline, process info, ' +
    'net-trace tail, probe/procdump logs, full dump). Returns immediately; poll hang_status / hang_packs. ' +
    'Set maxSeconds>0 to auto-stop (0 = run until hang_stop or the script exits).',
  { maxSeconds: z.number().optional().describe('Auto-stop after N seconds (0 = unlimited, max 86400)') },
  async (args) => jtext(hng().startRun({ maxSeconds: args.maxSeconds ?? 0 }))
)

server.tool(
  'hang_stop',
  'Stop the hang monitor (kills its process tree). Evidence packs already collected are kept.',
  {},
  async () => jtext(hng().stopRun())
)

server.tool(
  'hang_packs',
  'List collected hang evidence packs, newest first: id, timestamp, file list, dump size, screenshot presence, ' +
    'analysis status, and the first line of summary.txt / process-info.txt. Use hang_pack for the full text evidence.',
  {},
  async () => {
    const items = hng().listPacks()
    return jtext({ total: items.length, evidenceDir: hng().packsDir(), items })
  }
)

server.tool(
  'hang_pack',
  'Read one evidence pack in full (read-only): every text evidence file (summary / process-info / net-trace tail / probe + procdump logs, ' +
    'each capped at 512KB), the file list, and the cached analysis.json. The frozen screenshot is a PNG on disk inside the pack dir ' +
    '(frozen-screen.png) — pass that path to an image-reading tool to look at it.',
  { id: z.string().describe('Pack id from hang_packs') },
  async (args) => {
    const detail = hng().packDetail(args.id)
    if (detail === null) return text('pack not found: ' + args.id)
    return jtext(detail)
  }
)

server.tool(
  'hang_analyze',
  'Run the ClrMD (DumpStack) analysis on a pack frozen.dmp: managed thread stacks, the suspect/UI thread, a diagnosis line, ' +
    'and the suspect method mapped to project source (DSH_HANG_SRC_ROOT) with line numbers. ' +
    'wait=true blocks until the analysis finishes (up to waitMs) and returns the report — the usual choice for an agent; ' +
    'wait=false returns immediately and the panel/poller reads the cached analysis.',
  {
    id: z.string().describe('Pack id from hang_packs (must contain frozen.dmp)'),
    wait: z.boolean().optional().describe('Wait for the analysis to finish (default true)'),
    waitMs: z.number().optional().describe('Max wait in ms when wait=true (default 300000)'),
  },
  async (args) => {
    const r = await hng().analyze(args.id, { wait: args.wait !== false, waitMs: args.waitMs ?? 300000 })
    if (r.ok === false && r.status === 'error') {
      autoRecord('tool-error', 'hang_analyze', `hang analysis failed: ${String(r.error ?? 'unknown').slice(0, 200)}`)
    }
    return jtext(r)
  }
)

server.tool(
  'hang_delete',
  'Delete hang evidence packs (LOCAL, irreversible — dumps are hundreds of MB). confirm=true is required. ' +
    'Give id to delete one pack, or all=true to clear every pack.',
  {
    id: z.string().optional().describe('Pack id to delete'),
    all: z.boolean().optional().describe('Delete every pack in the evidence dir'),
    confirm: z.boolean().describe('Must be true — deletion is irreversible'),
  },
  async (args) => {
    if (args.confirm !== true) {
      return text('Blocked: hang_delete is irreversible. Re-call with confirm=true after confirming with the user.')
    }
    if (args.all === true) return jtext({ deleted: hng().removeAllPacks(), all: true })
    if (typeof args.id === 'string' && args.id !== '') {
      const ok = hng().removePack(args.id)
      return jtext(ok ? { deleted: args.id } : { ok: false, error: 'pack not found: ' + args.id })
    }
    return text('Nothing to do: pass id=<pack> or all=true.')
  }
)

// ---------------------------------------------------------------- http
server.tool(
  'http_request',
  'Send an HTTP request from the host (server-side, no browser CORS) and return status / headers / body. ' +
    'A non-2xx status is a normal result; ok:false means the request could not be made.',
  {
    method: z.string().default('GET').describe('HTTP method'),
    url: z.string().describe('Absolute http(s) URL'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('Request body (ignored for GET/HEAD)'),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    const r = await sendRequest({
      method: args.method,
      url: args.url,
      headers: args.headers,
      body: args.body,
      timeoutMs: args.timeoutMs,
    })
    if (r.ok === false) autoRecord('tool-error', 'http_request', `request could not be made: ${String(r.error ?? '').slice(0, 200)}`, { context: { url: String(args.url).slice(0, 120) } })
    return jtext(r)
  }
)

// ---------------------------------------------------------------- memory

server.tool(
  'memory_index',
  'Index a local directory into the long-term memory vector store (incremental: skips unchanged files by mtime; skips bin/obj/node_modules). ' +
    'PRIVACY: when a MiniMax API key is configured, file chunks are embedded via the REMOTE api.minimax.chat endpoint — indexed content leaves this machine. ' +
    'Fail-closed: files containing tokens/secrets are skipped before embedding and counted as sensitiveSkipped. Multiple roots coexist; indexing one directory never deletes another directory\'s chunks.',
  { path: z.string().describe('Absolute directory to index') },
  async (args) => jtext(await mem().indexWorkspace(args.path))
)

server.tool(
  'memory_search',
  'Semantic search over indexed documents/code. Returns relevant snippets with source files. ' +
    'PRIVACY: queries are embedded via the configured backend — remote (api.minimax.chat) when a MiniMax API key is set, local bigram otherwise.',
  { query: z.string(), k: z.number().default(5).describe('Results count, max 10') },
  async (args) => {
    const k = Math.min(Math.max(Math.round(args.k || 5), 1), 10)
    const hits = await mem().search(args.query, k)
    return jtext({
      embed: mem().embed.label,
      hits: hits.map((h) => ({ file: h.meta.file, chunk: h.meta.chunkIndex, score: +h.score.toFixed(3), text: String(h.meta.text).slice(0, 400) })),
    })
  }
)

server.tool(
  'memory_save',
  'Save a cross-session key-value memory (per scope, e.g. a project name). Same key+scope overwrites. ' +
    'Fail-closed: values containing tokens/API keys/secrets are rejected.',
  { key: z.string(), value: z.string(), scope: z.string().default('global') },
  async (args) => {
    try {
      return jtext(mem().remember(args.key, args.value, args.scope))
    } catch (e) {
      return text('memory_save rejected: ' + e.message)
    }
  }
)

server.tool(
  'memory_recall',
  'Read a saved key-value memory.',
  { key: z.string(), scope: z.string().default('global') },
  async (args) => {
    const v = mem().recall(args.key, args.scope)
    // Flat shape: value is the stored string, not a nested row object.
    return jtext(v == null ? { found: false } : { found: true, key: v.key, value: v.value, scope: v.scope })
  }
)

server.tool(
  'memory_status',
  'Memory store status: chunk count, KV entries, data dir, embedding backend.',
  {},
  async () => jtext(mem().status())
)

// ---------------------------------------------------------------- failure corpus

server.tool(
  'failure_record',
  'Record one failure / human-handoff event into the local failure corpus (JSONL, local-only, never uploaded). ' +
    'Call this every time a task fails, verification disagrees with a claim, a tool malfunctions, or a human had to take over. Facts, not blame.',
  {
    task: z.string().describe('One-line task name'),
    failureClass: z.enum(FAILURE_CLASSES).describe('Failure class from the fixed taxonomy: ' + FAILURE_CLASSES.join(' | ')),
    description: z.string().describe('What went wrong'),
    resolution: z.string().optional().describe('How it was unblocked'),
    context: z.record(z.string(), z.string()).optional().describe('Runtime context (runtime / tool / model / repo)'),
    tags: z.array(z.string()).optional().describe('Free-form tags for later mining'),
    costMs: z.number().optional().describe('Approximate time wasted in ms'),
  },
  async (args) => {
    try {
      return jtext(fc().record(args))
    } catch (e) {
      return text('failure_record rejected: ' + e.message)
    }
  }
)

server.tool(
  'failure_query',
  'Query the local failure corpus: substring q (task/description/resolution), failureClass, tag, time range. Returns newest-first records.',
  {
    q: z.string().optional(),
    failureClass: z.enum(FAILURE_CLASSES).optional(),
    tag: z.string().optional(),
    fromTs: z.number().optional().describe('Earliest ts (epoch ms)'),
    toTs: z.number().optional().describe('Latest ts (epoch ms)'),
    limit: z.number().optional().describe('Max records, default 50, max 500'),
    offset: z.number().optional(),
  },
  async (args) => jtext(fc().query(args))
)

server.tool(
  'failure_stats',
  'Failure corpus stats: total, last 7/30 days, per-class counts, corpus dir.',
  {},
  async () => jtext(fc().stats())
)

// ---------------------------------------------------------------- api capture

server.tool(
  'capture_query',
  'Query the local API-capture store (the same day-shard JSONL the dsh-api-visualizer capture panel writes): ' +
    'method/url/status/duration plus caller attribution (which ViewModel/API fired each request). ' +
    'Use to analyze captured client traffic: slow calls, errors, one host, or requests fired by one ViewModel.',
  {
    limit: z.number().optional().describe('Max records (default 50, max 500)'),
    offset: z.number().optional(),
    q: z.string().optional().describe('Substring match against url/note'),
    method: z.string().optional().describe('HTTP method filter (GET/POST/...)'),
    source: z.string().optional().describe('Capture source: realtime / proxy / agent / etw'),
    status: z.string().optional().describe('Exact code or 2xx/3xx/4xx/5xx'),
    host: z.string().optional().describe('Comma-separated hostnames'),
    minDurationMs: z.number().optional().describe('Only records at least this slow (ms)'),
    minBytes: z.number().optional(),
    maxBytes: z.number().optional(),
    fromTs: z.number().optional().describe('Earliest record ts (epoch ms)'),
    toTs: z.number().optional(),
    sessionId: z.string().optional(),
    traceId: z.string().optional(),
    runId: z.string().optional().describe('Filter by the run id carried on records (evidence-pack spine)'),
    errors: z.boolean().optional().describe('Only HTTP 4xx/5xx records'),
    noNoise: z.boolean().optional().describe('Hide static-resource/heartbeat noise'),
    bodyQ: z.string().optional().describe('Substring inside request/response bodies/headers'),
    caller: z.string().optional().describe('Caller attribution substring (viewModel / apiMethod / stack frame)'),
    includeBody: z.boolean().optional().describe('Include bodies (off by default)'),
  },
  async (args) => jtext(queryPage(args))
)

server.tool(
  'capture_append',
  'Append captured API-call records into the local API-capture store (the same store the capture panel reads; appears live in the GUI).',
  {
    records: z.array(z.object({ method: z.string(), url: z.string() }).passthrough()).describe('Records: method+url required; status/durationMs/reqBody/resBody/note/caller optional. Bodies ≤ 2MB.'),
    runId: z.string().optional().describe('Attach this run id to every appended record (evidence-pack spine)'),
  },
  async (args) => jtext(appendRecords(args.records, { runId: args.runId }))
)

// ---------------------------------------------------------------- verification report

server.tool(
  'verify_report',
  'Assemble the verification report for one runId and adjudicate each claim FROM EVIDENCE, not self-rating: ' +
    'kind=build reads the per-run build record (run-<runId>.json), kind=api queries the capture store (filter + expect.min/all2xx), ' +
    'kind=file checks path existence, kind=manual is an explicit agent-supplied status. ' +
    'Verdict: pass / incomplete / fail. Evidence-contradicted claims auto-record as agent-misjudge in the failure corpus. ' +
    'This is the physical carrier of "evidence over claims" — call it before declaring a task done.',
  {
    runId: z.string().describe('Unique run id (e.g. task-2-toolchain-1)'),
    task: z.string().describe('One-line task name'),
    claims: z.array(z.object({
      statement: z.string().describe('The claim being made'),
      kind: z.enum(['build', 'api', 'file', 'git', 'gate', 'manual']).optional().describe('Adjudication rule; defaults to manual'),
      runId: z.string().optional().describe('For kind=build/api: which run the evidence belongs to'),
      path: z.string().optional().describe('For kind=file: path to check'),
      filter: z.record(z.string(), z.any()).optional().describe('For kind=api: capture-store filter (q/method/host/status/...)'),
      expect: z.object({ min: z.number().optional(), all2xx: z.boolean().optional() }).optional().describe('For kind=api: pass criteria (default min=1)'),
      repo: z.string().optional().describe('For kind=git: repo dir (default cwd)'),
      check: z.string().optional().describe("For kind=git: 'clean' (working tree) or 'pushed' (ls-remote, authoritative)"),
      ref: z.string().optional().describe("For kind=git check=pushed: ref to compare (default HEAD)"),
      gitConfig: z.array(z.string()).optional().describe("For kind=git: extra git -c flags (e.g. ['-c','http.sslBackend=openssl'])"),
      cmd: z.string().optional().describe('For kind=gate: verification command (exit 0 = pass)'),
      cwd: z.string().optional().describe('For kind=gate: working dir'),
      status: z.enum(['pass', 'fail', 'unverified']).optional().describe('For kind=manual: supplied status'),
      evidence: z.string().optional().describe('For kind=manual: backing evidence'),
    })).describe('Claims adjudicated from evidence'),
    context: z.record(z.string(), z.string()).optional().describe('Runtime context (repo / model / mode)'),
  },
  async (args) => {
    try {
      return jtext(makeVerificationReport(args))
    } catch (e) {
      return text('verify_report rejected: ' + e.message)
    }
  }
)

// ---------------------------------------------------------------- boot

const transport = new StdioServerTransport()
await server.connect(transport)
