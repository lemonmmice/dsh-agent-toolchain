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
import { envOr } from '../lib/env-fallback.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { checkCompileMembership } from '../lib/compile-membership.mjs'
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { makeLive } from '../plugins/dsh-ui-drive/lib/live.mjs'
import { sanitizeLive } from '../plugins/dsh-ui-drive/lib/render.mjs'
import { makePerf } from '../plugins/dsh-perf/lib/perf.mjs'
import { makeTrace } from '../plugins/dsh-perf/lib/trace.mjs'
import { cleanEvidence } from '../plugins/dsh-perf/lib/evidence-clean.mjs'
import { makeHangInspector } from '../plugins/dsh-hang-inspector/lib/hang.mjs'
import { sendRequest } from '../plugins/dsh-postman/lib/http.mjs'
import { DshMemory } from '../plugins/dsh-memory/lib/memory.mjs'
import { makeFailureCorpus, FAILURE_CLASSES } from '../lib/failure-corpus.mjs'
// 捕获控制面的"人话总结"：**与 DSH 工具 / 面板路由共用同一份实现**（本仓第 38 类：同一逻辑许两份必然漂移）。
// 之所以要在这里算而不是只信路由返回：**运行中的宿主不会热加载**，旧宿主的路由里没有 summary 字段，
// 于是"新工具 + 旧宿主"这个组合下 MCP 面会拿不到那句关键提示（实测过：summary=undefined）。
import { captureStatusSummary as summarizeCapture, doubleWriteVerdict, sampleDeltaVerdict } from '../plugins/dsh-api-visualizer/lib/capture-control.mjs'
// E3 / F-042：环境自检（toolchain_status）—— **与 DSH 面共用同一条实现**（lib/），
// 不在这里再写一份（第 24 类缺陷：同一件事不许有第二份实现）。
import { buildToolchainStatus } from '../lib/toolchain-status.mjs'
import { queryPage, appendRecords, readAll, readRetention } from '../lib/capture-store.mjs'
import { buildQueryView, freshnessNote, callerAttributionNote, retentionNote } from '../plugins/dsh-api-visualizer/lib/query-view.mjs'
import { makeVerificationReport } from '../lib/verify/report.mjs'
import { attachInlineImage } from './inline-image.mjs'
import { makeToolTrace, wrapToolArgs } from '../lib/tool-trace.mjs'
import { makeOutputBudget, outputMaxTokens } from '../lib/output-budget.mjs'
// W1：工具描述/参数结构收进单一真源（lib/tool-registry.mjs）；MCP 侧的 zod shape 由 mcp/registry-zod.mjs 生成。
// 工具名仍以字面量出现在下面各 server.tool 调用的第一个实参（守卫要求名字是字面量、静态扫描须等于运行时）。
import { mcpDescription, mcpAnnotations } from '../lib/tool-registry.mjs'
import { mcpShape } from './registry-zod.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const server = new McpServer({
  name: 'dsh-agent-toolchain',
  version: '0.1.0',
})

// W2 —— 工具调用追踪（见 CODEX-STEAL-ANALYSIS-20260916.md / lib/tool-trace.mjs）。
// 单一 chokepoint：包住 server.tool 的 handler，记录 {tool, runId, 起止时间, ms, ok, errorCode}
// 到 tool-trace.jsonl（**不记参数/输出**，隐私安全，对齐 Codex call_trace）。
// 默认关（env DSH_TOOL_TRACE 未开 → wrap 是恒等，注册的仍是原 handler，零开销/零回归）。
const _toolTrace = makeToolTrace({
  enabled: /^(1|true|yes|on)$/i.test(process.env.DSH_TOOL_TRACE || ''),
  dir: process.env.DSH_TOOL_TRACE_DIR || join(homedir(), '.dsh-agent-toolchain', 'tool-trace'),
})
// W2（第二块）—— 统一输出预算信封（token-budget，见 lib/output-budget.mjs）：同一 chokepoint 上把 handler
// 的返回结果过一遍 token 预算，超了就截并追加 originalTokenCount 说明块。默认关（DSH_OUTPUT_MAX_TOKENS 未设/<=0
// → 恒等，零回归）。与追踪 compose：预算改结果、追踪观测——两者都关时净身份，注册的仍是原 handler。
const _outputBudget = makeOutputBudget({ maxTokens: outputMaxTokens({}, process.env) })
const _origTool = server.tool.bind(server)
// P1-1c —— 只读工具注解（readOnlyHint）。单一 chokepoint 同处注入：从注册表读该工具是否只读，
// 是则在 handler 前插入 { readOnlyHint: true } 作 annotations 实参（SDK 支持 tool(name,desc,shape,annotations,cb)
// 且注解原样进 tools/list，已实证；非只读工具不注解）。客户端据此可对只读工具并行分发。名字仍取自第一个字面量实参。
// 注入在 wrapToolArgs 之前：wrapToolArgs 只包**最后一个函数**参数，注解对象在其之前，互不影响。
function injectAnnotations(args) {
  const name = typeof args[0] === 'string' ? args[0] : null
  const ann = name ? mcpAnnotations(name) : undefined
  if (!ann) return args
  const last = args.length - 1
  if (last >= 0 && typeof args[last] === 'function') {
    // 在 handler 之前插入 annotations（若调用方已自带 annotations 对象则不重复插）
    const prev = args[last - 1]
    const hasAnn = prev && typeof prev === 'object' && ('readOnlyHint' in prev || 'destructiveHint' in prev || 'openWorldHint' in prev)
    if (!hasAnn) args.splice(last, 0, ann)
  }
  return args
}
server.tool = (...args) => _origTool(...wrapToolArgs(injectAnnotations(args), (name, handler) => _toolTrace.wrap(name, _outputBudget.wrap(name, handler))))

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

// W5 —— 截图内联（见 CODEX-STEAL-ANALYSIS-20260916.md / mcp/inline-image.mjs）。
// UI 只读/动作结果的统一出口：文本 JSON（含截图 path，零回归）之上，按需（env DSH_UI_INLINE_IMAGE，
// 默认关）追加一个 MCP image 块，让有视觉能力的客户端一步看到界面，省掉「回路径→再开读图工具」两轮往返。
const uiJtext = (r) => attachInlineImage(jtext(withHint(r)), r)

let driver = null
function drv() {
  if (!driver) {
    driver = makeDriver({
      scriptsDir: join(root, 'plugins', 'dsh-ui-drive', 'scripts'),
      procName: envOr('DSH_UI_PROC_NAME'),
      windowName: envOr('DSH_UI_WINDOW_NAME'),
      clientExe: envOr('DSH_UI_CLIENT_EXE'),
      evidenceDir: envOr('DSH_UI_EVIDENCE_DIR'),
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

/**
 * Attach a machine-readable `hint` to a failed driver result, at the MCP boundary.
 *
 * Why here and not only in the plugin's render layer: `renderDrive`/`renderState` are consumed
 * exclusively by the DSH plugin's `output.render`, so the "next step" text they add never reaches
 * an MCP client. This server returns the driver's object verbatim via jtext(), so without this the
 * most common call path (an agent calling ui_drive over MCP) gets a bare failure and has to guess.
 *
 * The hint goes in a FIELD rather than being wrapped around the JSON: these results are parsed
 * programmatically (and my own probes rely on that), so prose must not break the contract. Adding a
 * field is the same shape the repo already uses for completeness reporting (`skipped`, `warn`,
 * `observationWarning`) - a bare error is an incomplete observation, and this says so explicitly.
 *
 * Keyed on shapes the driver actually produces (verified against driver.mjs), not on guesses:
 * `staleSnapshot`/`expiredSnapshot` flags, the gate's allowSideEffects message, and the two
 * not-found messages. Anything unrecognised still gets a generic pointer, so no failure is silent.
 */
function withHint(r) {
  if (!r || typeof r !== 'object') return r
  // find-not-found is a "failure" the driver reports as ok:true + found:false; treat it as one.
  const failed = r.ok === false || r.found === false
  if (!failed) return r
  if (r.hint) return r // the driver already gave one
  const err = String(r.error || '')
  let hint
  if (r.expiredSnapshot) {
    hint = '客户端或常驻进程已重启，旧 snapshotId 全部失效：重新 ui_observe(state/read) 取一个新 snapshotId 再动作。'
  } else if (r.staleSnapshot) {
    hint = '界面在你上次读取之后已刷新（' + r.staleSnapshot + '），旧 snapshotId 已过期：重新 ui_observe(state/read) 拿最新快照再动作。'
  } else if (r.unknownSnapshot) {
    hint = '这个 snapshotId 无法解析（可能来自别的进程或已被清理）：省掉 snapshotId 直接重发，或重新 ui_observe(state/read) 取一个新的。'
  } else if (/allowSideEffects/.test(err)) {
    hint = '这是真实副作用动作，驱动要求显式授权：确认目标无误后重发并带 allowSideEffects=true。'
  } else if (r.notFound || /未找到目标控件/.test(err) || r.found === false) {
    hint = '控件没找到，别用同一个写法反复试：先 ui_observe(action=state) 看当前界面上实际有哪些控件与准确 Name，再放宽 match 正则或去掉 inAid/inName 容器限定后重试；连续三次定位失败就停下报告。'
  } else if (/未找到主窗口/.test(err)) {
    hint = '目标进程当前没有可取的主窗口：先 ui_status，若客户端没在运行就 ui_launch；也确认 procId 指对了进程。'
  } else if (/客户端 exe 不存在|未配置目标进程/.test(err)) {
    hint = '客户端可执行文件/目标进程没有配置好：设置 DSH_UI_CLIENT_EXE（或 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME）后重试。'
  } else if (r.timedOut || r.timeout) {
    hint = '这次调用超时。副作用动作超时后驱动**不做任何重试**（避免重复致效）：先用 find/read 复核控件状态，再决定是否重发。'
  } else if (/无输出|批量脚本不存在/.test(err)) {
    hint = '驱动脚本没产出结果：确认 profile 里的 dsh-ui-drive/scripts 已部署（node scripts/deploy-plugins.mjs），以及当前有可用的 PowerShell。'
  } else {
    hint = '调用失败。先 ui_observe(action=state) 确认当前界面与目标控件，再重试；定位类失败连续三次就停下报告，不要盲试。'
  }
  return Object.assign({}, r, { hint })
}

let memory = null
function mem() {
  if (!memory) memory = new DshMemory({})
  return memory
}

/**
 * Live-view singleton. `makeLive` starts an interval-driven frame grabber, so it MUST be a
 * single instance — two of them would double-write latest.png. (The DSH plugin keeps the same
 * guarantee with a module-level singleton.)
 */
let live = null
function liveCtl() {
  if (!live) live = makeLive({ driver: drv() })
  return live
}

let perf = null
function prf() {
  if (!perf) {
    perf = makePerf({
      scriptsDir: join(root, 'plugins', 'dsh-perf', 'scripts'),
      procName: envOr('DSH_UI_PROC_NAME'),
      windowName: envOr('DSH_UI_WINDOW_NAME'),
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR'),
      srcRoot: envOr('DSH_PERF_SRC_ROOT'),
    })
  }
  return perf
}

let corpus = null
function fc() {
  if (!corpus) corpus = makeFailureCorpus({})
  return corpus
}

/**
 * ETW tracer（F-003 / E4：DSH 面早就有 perf_trace/perf_hotstacks，MCP 面此前没有）。
 * 与 `plugins/dsh-perf/index.js` 的 `trc()` **同参构造** —— 两面的行为必须一致（E4 的判据）。
 */
let tracer = null
function trc() {
  if (!tracer) {
    tracer = makeTrace({
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      procName: envOr('DSH_UI_PROC_NAME'),
    })
  }
  return tracer
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

/** Shared builder instance. Its constructor options are env-derived; build status and the last
 *  error list are read back from the logs dir on disk, so build_status/build_errors see the same
 *  state that build_run wrote even across calls. */
let builder = null
function bld() {
  if (!builder) {
    builder = makeBuilder({
      clientRoot: envOr('DSH_BUILD_CLIENT_ROOT'),
      repoRoot: envOr('DSH_BUILD_REPO_ROOT'),
      msbuild: envOr('DSH_BUILD_MSBUILD'),
      engine: process.env.DSH_BUILD_ENGINE || 'msbuild',
      // 注意：这里**不能**用 '' 当默认值去覆盖 —— 传空串会让 makeBuilder 内部的默认/推导被顶掉。
      logsDir: envOr('DSH_BUILD_LOGS_DIR'),
    })
  }
  return builder
}

server.tool(
  'build_run',
  mcpDescription('build_run'),
  mcpShape('build_run'),
  async (args) => {
    // Per-call argument overrides (clientRoot/repoRoot/engine) still win; the shared instance
    // supplies the env-derived defaults. build() does no I/O at construction, so reusing it is safe.
    const b = args.clientRoot || args.repoRoot || args.engine
      ? makeBuilder({
        clientRoot: args.clientRoot || envOr('DSH_BUILD_CLIENT_ROOT'),
        repoRoot: args.repoRoot || envOr('DSH_BUILD_REPO_ROOT'),
        msbuild: envOr('DSH_BUILD_MSBUILD'),
        engine: args.engine || process.env.DSH_BUILD_ENGINE || 'msbuild',
        logsDir: envOr('DSH_BUILD_LOGS_DIR'),
      })
      : bld()
    // W4: background build returns a jobId immediately; poll with build_status. Build logic unchanged.
    if (args.background === true) {
      return jtext(b.startBackground({
        target: args.target,
        project: args.project,
        configuration: args.configuration,
        platform: args.platform,
        killClient: args.killClient,
        runId: args.runId,
      }))
    }
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
  mcpDescription('ui_status'),
  mcpShape('ui_status'),
  async (args) => jtext(await drv().status(args.procId ? { procId: args.procId } : {}))
)

const uiAction = z.enum([
  // 只读 + 纯输入（输入类由驱动器统一授权，见 uiActionNeedsAuth 说明）
  'find', 'read', 'state', 'windows', 'shot', 'waitfor',
  // 副作用（必须 allowSideEffects=true）
  'click', 'setvalue', 'key', 'type', 'drag',
  // 以下三处原先漏在 enum 之外，导致驱动已实现的能力对模型完全不可达：
  // 坐标类副作用
  'clickat', 'doubleclick',
  // W5 原语（都在驱动的 BATCH_ONLY_ACTIONS 里，已实现）
  'pattern', 'scroll', 'selecttext',
  // 只读白名单输入（驱动 INPUT_ACTIONS，可逆、豁免副作用门）
  'move', 'wheel',
  // 其它已实现但原先不可达的动作
  'capture', 'state-live',
])

server.tool(
  'ui_state',
  mcpDescription('ui_state'),
  mcpShape('ui_state'),
  async (args) => jtext(await drv().drive({ action: 'state', match: args.match || '', max: args.max || 40, ...(args.procId ? { procId: args.procId } : {}), ...(args.winHandle ? { winHandle: args.winHandle } : {}) }))
)

server.tool(
  'ui_windows',
  mcpDescription('ui_windows'),
  mcpShape('ui_windows'),
  async (args) => jtext(await drv().drive({ action: 'windows', ...(args.procId ? { procId: args.procId } : {}) }))
)

server.tool(
  'ui_drive',
  mcpDescription('ui_drive'),
  {
    action: uiAction,
    name: z.string().optional().describe('Control Name'),
    aid: z.string().optional().describe('AutomationId'),
    value: z.string().optional().describe('Value for setvalue/key/type (type accepts SendKeys syntax, e.g. 1234{ENTER})'),
    ascii: z.boolean().optional().describe('key: send ASCII directly instead of clipboard paste; type: treat {}^%~() as literal'),
    match: z.string().optional().describe('read: regex filter; on find/click: regex the control name matches (with index)'),
    index: z.number().optional().describe('Which match to use (0-based; reuse the #index from read)'),
    inAid: z.string().optional().describe('Scope the search/read to the subtree of this AutomationId container (read/state set narrowed+scope; a wrong container name fails loudly instead of silently reading the whole window)'),
    inName: z.string().optional().describe('Scope the search/read to the subtree of this Name container'),
    waitFor: z.record(z.string(), z.any()).optional().describe('Wait before acting: {ms?:5000, interval?:150, state?:"appear"|"gone"|"enabled"|"disabled", match?, index?}. Target = name/aid on the action, else name/aid inside waitFor, else match alone (tree-wide regex); all three empty is reported as missing target. read and state accept it too. COST: match-only walks the whole tree each poll (~3x the cost of aid/name; ms is not a hard bound since a poll cannot be interrupted) - give aid/name for loops or time-sensitive waits; match-only ms is capped at 15000.'),
    state: z.string().optional().describe('waitfor: appear (default) | gone | enabled | disabled'),
    keys: z.string().optional().describe('type: key sequence (same as value, clearer intent)'),
    fromX: z.number().optional().describe('drag: start X (client-area coords)'),
    fromY: z.number().optional().describe('drag: start Y'),
    toX: z.number().optional().describe('drag: end X'),
    toY: z.number().optional().describe('drag: end Y'),
    steps: z.number().optional().describe('drag: interpolation steps (default 12)'),
    holdMs: z.number().optional().describe('drag: pause before press/release (default 120)'),
    label: z.string().optional().describe('Screenshot file label (shot mode)'),
    describe: z.boolean().optional().describe('shot mode: also return a vision description of the screen (uses the plugin vision config in ~/.dsh/settings.yaml). ' +
      'If the focused control is a password/captcha/token field the description is REFUSED by default (pixels cannot be redacted) — pass allowSensitive=true to override'),
    allowSensitive: z.boolean().optional().describe('Override the secret-focus guard on describe=true (only when you have confirmed the screen holds no sensitive content)'),
    waitMs: z.number().optional(),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true for click/setvalue/key/type/drag'),
    snapshotId: z.string().optional().describe('W1 freshness token returned by a prior read/state. When set, a side-effect action is rejected if the snapshot is stale (a newer read happened: staleSnapshot) or expired (client/serve restarted: expiredSnapshot). Omit to skip the freshness gate (legacy, zero-regression).'),
    diff: z.boolean().optional().describe('read only: return an incremental diff {added,removed,unchanged} vs the last full read instead of just the flat list'),
    // The driver's batch engine accepts these but the schema never declared them, and the MCP
    // SDK hands the handler only the zod-parsed object (zod strips unknown keys by default), so
    // they were unreachable no matter what the handler forwarded:
    //   count       — scroll: how many pages (without it scroll always moved exactly one page)
    //   expectValue — selecttext: the suffix (and type: the read-back check)
    //   x/y/delta/mods — clickat / wheel / move coordinates and held modifier keys
    count: z.number().optional().describe('scroll: number of pages/lines (default 1). Also max items for some read modes.'),
    expectValue: z.string().optional().describe('type: expected value for the read-back check; selecttext: the suffix to select through'),
    x: z.number().optional().describe('move/clickat: client-area X'),
    y: z.number().optional().describe('move/clickat: client-area Y'),
    delta: z.number().optional().describe('wheel: scroll delta'),
    observeMax: z.number().optional().describe('observe=true: how many controls the post-action snapshot lists (default 15). Only affects the snapshot, not the action result.'),
    shotsDir: z.string().optional().describe('Directory to copy the screenshot into (absolute). Evidence always also lands in the evidence dir.'),
    mods: z.string().optional().describe('held modifier keys for drag/key, e.g. "shift" | "ctrl" | "alt"'),
    button: z.string().optional().describe('mouse button for coordinate actions (default left)'),
    double: z.boolean().optional().describe('true = double click at the coordinate instead of a single click'),
    focus: z.boolean().optional().describe('true = also set keyboard focus to the target'),
    winHandle: z.number().optional().describe('Target a specific top-level window by handle (from ui_windows) instead of the main window'),
    secret: z.boolean().optional().describe('Mask the value in output/evidence (password-like controls are masked automatically; this covers inputs that do not look like password fields)'),
    allowSensitive: z.boolean().optional().describe('describe=true: override the secret-focus guard (see describe)'),
    procId: z.number().optional().describe('Target process PID (disambiguate when several instances are running)'),
    // R42：这里原来声明了 expectEnabled/expectMatch，但 ui_drive 的 action 枚举里**没有** 'expect'，
    // 而这两个字段只有流程里的 expect 步骤会读 ⇒ 传进来永远没人看（幽灵参数）。真要断言请用 ui_flow 的 expect 步。
  },
  async (args) => {
    // Pre-check reuses the driver's classifyAction (single source) so it can never
    // drift from the write-side gate — this is what previously missed type/drag.
    if (needsSideEffectAuth(args.action) && !args.allowSideEffects) {
      return text('Blocked: action "' + args.action + '" is a real side effect. Re-call with allowSideEffects=true after confirming with the user.')
    }
    // Forward the WHOLE args object instead of an enumerated list.
    //
    // Why: the previous explicit list silently DROPPED every parameter added to
    // the schema over time — index / inAid / inName / waitFor / state / keys /
    // fromX / fromY / toX / toY / steps / holdMs were all declared to the model
    // and documented in this tool's description ("use index for the Nth
    // same-named control", "pass waitFor=… on click/setvalue/…", "drag: start X")
    // yet never reached the driver. The model followed the description and the
    // arguments evaporated — the same "advertised but not wired" failure as the
    // snapshotId bug called out below. Spreading makes the schema the single
    // source of truth, so this cannot drift again.
    const r = await drv().drive({ ...args, action: args.action, allowSideEffects: args.allowSideEffects })
    if (!r.ok) autoRecord('tool-error', 'ui_drive', `ui_drive ${args.action} failed: ${String(r.error ?? 'unknown error').slice(0, 200)}`)
    // r44：`describe=true` 以前是**幽灵参数**（声明了、handler 从不实现 ⇒ 模型以为拿到了描述，其实没有）。
    // 现在真的接上：vision 模块是自包含的（读 ~/.dsh/settings.yaml + .credentials.yaml），不需要宿主 API。
    await attachVision(r, args)
    return uiJtext(r)
  }
)

server.tool(
  'ui_flow',
  mcpDescription('ui_flow'),
  {
    steps: z.array(z.object({
      // Ground truth is the driver's FLOW_ACTIONS (driver.mjs) — every verb it can run must be
      // listed here, or zod rejects the step before the driver ever sees it. Six verbs the driver
      // implements were missing (pattern/scroll/selecttext/expectwindow/expecttext/waitany), so
      // those capabilities were unreachable through ui_flow even after they became callable
      // one step at a time via ui_act.
      action: z.enum([
        'find', 'click', 'setvalue', 'key', 'type', 'drag',
        'pattern', 'scroll', 'selecttext',
        'read', 'state', 'shot', 'windows',
        'wait', 'waitfor', 'expect', 'expectwindow', 'expecttext', 'waitany',
      ]),
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
      count: z.number().optional().describe('scroll: number of pages/lines (default 1)'),
      expectValue: z.string().optional().describe('type: read-back expectation; selecttext: the suffix'),
      expectwindow: z.string().optional().describe('deprecated alias — use action=expectwindow with titleRe'),
      titleRe: z.string().optional().describe('expectwindow / waitany(window): window title regex'),
      textRe: z.string().optional().describe('expecttext / waitany(text): text regex'),
      gone: z.boolean().optional().describe('expectwindow: true = wait until the window disappears'),
      ms: z.number().optional().describe('wait/waitfor: timeout ms'),
      interval: z.number().optional().describe('waitfor: poll interval ms'),
      conds: z.array(z.record(z.string(), z.any())).optional().describe('waitany conditions'),
      stableCount: z.number().optional().describe('waitany: consecutive confirmations before a hit counts'),
      // 2026-09-11（Claude 第十轮真机发现）：驱动的 cleanSteps **认** max/maxDepth，但这份步骤 schema 没声明
      // → zod 在到达驱动前就把它们剥掉，于是 `steps:[{action:'state',max:5}]` 真机返回 count=40（max 被静默丢弃）。
      // 又一次"驱动修了、schema 没暴露"。凡是 cleanSteps 会转发的字段，这里都必须有声明的归宿
      // （守卫见 plugins/dsh-ui-drive/test/param-forwarding-completeness.test.mjs 的 flow-schema 检查）。
      max: z.number().optional().describe('read/state/tree steps: cap the number of lines/nodes returned'),
      maxDepth: z.number().optional().describe('tree steps: maximum depth'),
      // 同一类漏网（守卫 param-forwarding-completeness 抓出来的第二批）：drag 的插值参数、窗口定位、修饰键
      steps: z.number().optional().describe('drag: interpolation steps (default 12)'),
      holdMs: z.number().optional().describe('drag: pause before press/release (default 120)'),
      mods: z.string().optional().describe('drag/key: held modifier keys, e.g. "shift" | "ctrl" | "alt"'),
      focus: z.boolean().optional().describe('also set keyboard focus to the target before acting'),
      winTitle: z.string().optional().describe('Target a specific top-level window by title instead of the main window'),
      winHandle: z.number().optional().describe('Target a specific top-level window by handle (from ui_windows)'),
    })).describe('Step sequence'),
    tag: z.string().optional().describe('Evidence dir label (default flow)'),
    failFast: z.boolean().optional().describe('Stop at the first failed assertion'),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true when the sequence contains side-effect steps (click/setvalue/key/type/drag/pattern/scroll/selecttext/clickat/doubleclick)'),
  },
  async (args) => {
    // Mirrors the driver's own flow() gate rather than re-listing verbs.
    //
    // The driver gates a step with: not read-only AND not wait/expect => needs allowSideEffects.
    // This side previously hard-coded ['click','setvalue','key','type','drag'], which would have
    // let pattern/scroll/selecttext/live-coordinate steps through the pre-check and produced
    // per-step driver errors instead of one clear up-front message. Deriving it from the same
    // predicates the driver uses means a new verb cannot silently escape the hint again.
    //
    // Unknown verbs are deliberately treated as NON-side-effect here: the driver rejects them as
    // 非法动作 anyway, so demanding allowSideEffects for them would only bury the real error.
    // The driver's gate remains the enforcing one; this is a UX pre-check.
    const READ_ONLY = ['find', 'read', 'state', 'windows', 'shot', 'waitfor', 'state-live', 'expectwindow', 'expecttext', 'waitany', 'move', 'wheel', 'capture']
    const PSEUDO_READ_ONLY = ['wait', 'expect']
    const known = (a) => READ_ONLY.includes(a) || PSEUDO_READ_ONLY.includes(a) || ['click', 'setvalue', 'key', 'type', 'drag', 'clickat', 'doubleclick', 'pattern', 'scroll', 'selecttext'].includes(a)
    const hasSideEffects = (args.steps || []).some((s) => known(s.action) && !READ_ONLY.includes(s.action) && !PSEUDO_READ_ONLY.includes(s.action))
    if (hasSideEffects && !args.allowSideEffects) {
      return text('Blocked: the sequence contains a real side effect (click/setvalue/key/type/drag). Re-call with allowSideEffects=true after confirming with the user.')
    }
    const r = await drv().flow({
      steps: args.steps,
      tag: args.tag || 'flow',
      failFast: args.failFast === true,
      allowSideEffects: args.allowSideEffects === true,
    })
    // UD-03：与 DSH 面同一个洞——只认 `r.failed`（断言步），动作步失败不进语料库。
    // 两面必须一致，否则同一段流程在 MCP 面被记为"失败"、在 DSH 面被记为"通过"。
    const stepFailures = typeof r.stepFailures === 'number' ? r.stepFailures : 0
    if (r.failed > 0 || stepFailures > 0) {
      autoRecord('verification-failure', 'ui_flow',
        `ui_flow failure: assertions=${r.failed}, actionSteps=${stepFailures}/${r.totalSteps} steps failed (evidence: ${r.stepsJson || r.evidenceDir || '?'})`)
    }
    return jtext(r)
  }
)

// ---------------------------------------------------------------- ui observe / act (semantic split)

server.tool(
  'ui_observe',
  mcpDescription('ui_observe'),
  {
    action: z.enum([
      'find', 'read', 'state', 'windows', 'waitfor', 'expectwindow', 'expecttext', 'waitany', 'shot',
      // 原先漏在 enum 之外：驱动已实现、只读白名单或只读的
      'move', 'wheel', 'capture', 'state-live',
    ]),
    name: z.string().optional(),
    aid: z.string().optional(),
    match: z.string().optional(),
    textRe: z.string().optional().describe('expecttext / waitany(text): text regex (e.g. ErrorInfo)'),
    titleRe: z.string().optional().describe('expectwindow / waitany(window): window title regex'),
    gone: z.boolean().optional().describe('expectwindow: true = wait until the window disappears'),
    ms: z.number().optional().describe('Timeout ms (default 5000; waitany 15000)'),
    interval: z.number().optional(),
    state: z.string().optional().describe('waitfor condition: appear|gone|enabled|disabled'),
    waitFor: z.record(z.string(), z.any()).optional().describe('Wait before reading/acting: {ms?, interval?, state?, match?, index?}. Target = name/aid on the action, else name/aid inside waitFor, else match alone (tree-wide regex). read, state and state-live accept it too. match-only costs ~3x (whole-tree walk per poll) and its ms is capped at 15000 - give aid/name for loops.'),
    conds: z.array(z.record(z.string(), z.any())).optional().describe('waitany conditions: [{kind:"window"|"text"|"appear"|"gone"|"enabled"|"disabled", titleRe?, textRe?, name?, aid?, label?}]'),
    stableCount: z.number().optional().describe('waitany: consecutive confirmations before a hit counts (default 2)'),
    // Declared for the same reason as the fields in ui_drive: the driver accepts these, but zod
    // strips undeclared keys before the handler runs. `diff` is the W1 incremental read - without
    // it on this surface an MCP client could never turn that feature on (verified live against the
    // client: passing diff=true returned no diff field at all, silently degrading to a full list).
    diff: z.boolean().optional().describe('read only: return an incremental diff {added,removed,unchanged} against the previous full read (first read returns a diffBaseline marker; an incomplete read suppresses the diff instead of reporting a phantom one)'),
    procId: z.number().optional().describe('Target a specific process id (default: auto-detected)'),
    index: z.number().optional(),
    inAid: z.string().optional().describe('Scope the search/read to the subtree of this AutomationId container (read/state set narrowed+scope)'),
    inName: z.string().optional().describe('Scope the search/read to the subtree of this Name container'),
    winTitle: z.string().optional().describe('Scope the search/read to the window whose title matches'),
    max: z.number().optional(),
    label: z.string().optional(),
    describe: z.boolean().optional().describe('shot: also return a vision description (refused by default when the focused control is a password/captcha/token field; allowSensitive=true overrides)'),
    allowSensitive: z.boolean().optional().describe('Override the secret-focus guard on describe=true'),
    winHandle: z.number().optional().describe('Target a specific top-level window by handle (from ui_windows) — steadier than winTitle'),
    // move/wheel are reversible input primitives: the driver classifies them as kind 'input' and
    // checkSideEffectGate waves that kind through, so NO allowSideEffects is required (verified in
    // driver.mjs — classifyAction returns 'input', and the gate returns allow:true for non-effect
    // kinds). They are listed in the read-only whitelist for the same reason.
  },
  async (args) => {
    const r = await drv().drive({ ...args, action: args.action })
    return uiJtext(r)
  }
)

// ---------------------------------------------------------------- ui_launch / ui_tree / ui_live
// These three were reachable from the DSH plugin surface but missing entirely from MCP, so an
// MCP client could not start the client under test, could not dump its visual tree, and could not
// watch it live. An independent audit confirmed none of them needs a host-only service: the
// driver exposes launch/tree, and makeLive is plain Node (it shells out through the same driver).

server.tool(
  'ui_launch',
  mcpDescription('ui_launch'),
  mcpShape('ui_launch'),
  async (args) => {
    const l = await drv().launch({ extraArgs: args.extraArgs || '', waitMs: args.waitMs || 60000, force: args.force === true })
    // r44：与 DSH 面同一件事（视觉即返）——启动成功就顺带截一张并交给视觉模型，
    // 让「我现在到底在哪个页面」一步可答，省掉 shot + 读图两轮往返。
    // 只在窗口真的可用（ok===true）时才做：半成功时没有主窗口，截到的可能是闪屏或别的进程。
    if (l && l.ok === true) {
      try {
        const s = await drv().drive({ action: 'shot', label: 'launch-state' })
        if (s && s.ok === true) {
          const shot = { ...s }
          await attachVision(shot, { describe: true, allowSensitive: args.allowSensitive === true })
          l.uiState = {
            screenshot: shot.workspacePath || shot.path,
            size: shot.w + 'x' + shot.h,
            description: shot.description || null,
            describeSkipped: shot.describeSkipped || null,
            visionError: shot.visionError || null,
            note: shot.warning || null,
          }
        }
      } catch (e) {
        // 截图/描述失败**不影响**启动结论（启动本身成功了），但必须让调用方看得见
        l.uiState = { error: String((e && e.message) || e) }
      }
    }
    return attachInlineImage(jtext(l), l)
  }
)

server.tool(
  'ui_tree',
  mcpDescription('ui_tree'),
  mcpShape('ui_tree'),
  async (args) => jtext(await drv().tree({ maxDepth: args.maxDepth || 8, inAid: args.inAid || '', inName: args.inName || '' }))
)

server.tool(
  'ui_live',
  mcpDescription('ui_live'),
  mcpShape('ui_live'),
  async (args) => {
    const ctl = liveCtl()
    const action = String(args.action || '').toLowerCase()
    // F-021 卷土重来（Claude 第八轮真机抓到）：live 的快照脱敏 `sanitizeLive` **只被 DSH 面用**，
    // 这里的 `jtext(ctl.status())` 直接把原始快照 dump 出去 —— 敏感帧（焦点=密码/验证码）的
    // `path`/`pathAbs` 在 MCP 面**照出**，`allowSensitive` 传下去也只是个死参数
    // （live.frame 只认 opts.fresh）。于是 UD-05 的脱敏只活在半个世界里。
    // 修法：与 DSH 面走**同一个** sanitizeLive（一处修、两面生效），并把 allowSensitive 真接上。
    const allow = args.allowSensitive === true
    const j = (v) => jtext(sanitizeLive(v, allow))
    if (action === 'start') return j(await ctl.start({ intervalMs: args.intervalMs, stateIntervalMs: args.stateIntervalMs, maxControls: args.maxControls }))
    if (action === 'stop') return j(ctl.stop())
    if (action === 'status') return j(ctl.status())
    if (action === 'frame') return j(await ctl.frame({ fresh: args.fresh, allowSensitive: allow }))
    if (action === 'wait') return j(await ctl.wait({ fromHash: args.fromHash, timeoutMs: args.timeoutMs }))
    return text('Unknown ui_live action "' + args.action + '". Use start | stop | status | frame | wait.')
  }
)

server.tool(
  'ui_act',
  mcpDescription('ui_act'),
  {
    action: z.enum([
      'click', 'setvalue', 'key', 'type', 'drag',
      // 原先漏在 enum 之外：驱动均已实现（坐标类副作用 + W5 原语），但模型调不到
      'clickat', 'doubleclick', 'pattern', 'scroll', 'selecttext',
      // r44：`move`/`wheel` 在驱动 INPUT_ACTIONS 里是真实现的（且无需授权），描述里也写着它们 ——
      // enum 漏了就等于「描述可达、schema 拒绝」。G1 黑盒 #2 正是按描述去调、然后卡在这里。
      'move', 'wheel',
    ]),
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
    secret: z.boolean().optional().describe('Mask the value in output and evidence. NOTE: password/captcha controls are masked AUTOMATICALLY (reads return <secret:Nchars>) — use this flag for sensitive inputs that do not look like password fields'),
    fromX: z.number().optional(),
    fromY: z.number().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    observe: z.boolean().optional(),
    observeMatch: z.string().optional(),
    observeMax: z.number().optional().describe('observe=true: how many controls the post-action snapshot lists (default 15)'),
    // R42：删掉 shotsDir —— ui_act 的动作枚举里没有 shot/capture，截图目录对它毫无作用（幽灵参数）。
    waitMs: z.number().optional(),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true'),
    snapshotId: z.string().optional().describe('W1 freshness token from a prior read/state. When set, the action is rejected if the snapshot is stale (staleSnapshot) or expired (expiredSnapshot). Omit to skip the freshness gate. (ui_act forwards all args to the driver, so this reaches the same write-side gate as ui_drive.)'),
    // Declared for the same reason as in ui_drive: the driver accepts these, but an undeclared
    // key is stripped by zod before the handler runs, making the capability unreachable.
    count: z.number().optional().describe('scroll: number of pages/lines (default 1)'),
    x: z.number().optional().describe('clickat: client-area X'),
    y: z.number().optional().describe('clickat: client-area Y'),
    mods: z.string().optional().describe('held modifier keys for drag, e.g. "shift" | "ctrl" | "alt"'),
    winHandle: z.number().optional().describe('Target a specific top-level window by handle (from ui_windows) — steadier than winTitle'),
    inName: z.string().optional().describe('Scope the search to the subtree of this Name container'),
    procId: z.number().optional().describe('Target process PID (disambiguate when several instances are running)'),
  },
  async (args) => {
    if (args.allowSideEffects !== true) {
      // Structured failure, not bare prose: every other failure on this surface comes back as
      // JSON with a hint, and a client parsing the result should not have to special-case this one.
      return jtext({
        ok: false,
        action: args.action,
        requiresAllowSideEffects: true,
        error: 'ui_act 是真实副作用动作，必须显式授权才执行',
        hint: '确认目标控件无误后重发，并带 allowSideEffects=true（这是安全护栏，不是权限问题）。',
      })
    }
    const r = await drv().drive(args)
    if (!r.ok) autoRecord('tool-error', 'ui_act', `ui_act ${args.action} failed: ${String(r.error ?? 'unknown').slice(0, 200)}`)
    return uiJtext(r)
  }
)

/**
 * r44：给 `shot` + `describe=true` 接上视觉描述（MCP 面此前声明了 describe 却从不实现 = 幽灵参数）。
 *
 * 两道前置：① 敏感把关 —— 焦点在密码/验证码/token 控件上时**默认拒**（像素无法脱敏，复用驱动侧的
 * secretFocusNow，fail-closed）；② 视觉模块拿不到时如实报 `visionError`，绝不假装拿到了描述。
 */
async function attachVision(r, args) {
  if (!r || r.ok !== true || r.action !== 'shot' || args.describe !== true) return
  const sens = await drv().secretFocusNow({ procId: args.procId || 0 })
  if (args.allowSensitive !== true && (sens.secret === true || sens.unknown === true)) {
    r.describeSkipped = sens.unknown ? 'sensitivity-unknown' : 'secretFocused'
    r.warning = sens.unknown
      ? 'Vision description refused: the focused control could not be read (' + sens.reason + ') — fail-closed. The PNG is still on disk: ' + (r.workspacePath || r.path)
      : 'Vision description refused: the focused control is a password/captcha/token field (' + (sens.focused || 'unknown') + ') — pixels cannot be redacted. The PNG is still on disk: ' + (r.workspacePath || r.path)
    return
  }
  try {
    const mod = await import('../plugins/dsh-ui-drive/lib/vision.mjs')
    // 注意：vision.mjs 导出的是**工厂** makeVision(cfg) → { describeImage, … }，不是裸函数
    const vision = mod.makeVision({})
    const v = await vision.describeImage(r.workspacePath || r.path, mod.UI_STATE_PROMPT)
    if (v && v.ok) { r.description = v.text; r.visionModel = v.model || null } else r.visionError = (v && v.error) || 'vision module returned no result'
  } catch (e) {
    r.visionError = 'vision module unavailable in this process: ' + String((e && e.message) || e)
  }
}

// ---------------------------------------------------------------- perf

server.tool(
  'perf_probe',
  mcpDescription('perf_probe'),
  mcpShape('perf_probe'),
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
  mcpDescription('perf_report'),
  mcpShape('perf_report'),
  async () => jtext(prf().report())
)

server.tool(
  'perf_dump',
  mcpDescription('perf_dump'),
  mcpShape('perf_dump'),
  async (args) => jtext(await prf().dump(args))
)

server.tool(
  'perf_analyze',
  mcpDescription('perf_analyze'),
  mcpShape('perf_analyze'),
  async (args) => jtext(await prf().analyzeDump(args.dumpPath))
)

server.tool(
  'perf_heap',
  mcpDescription('perf_heap'),
  mcpShape('perf_heap'),
  async (args) => jtext(await prf().heapStats(args.dumpPath, args.topN))
)

// F-003 / E4（2026-09-12 r35）：这两个工具原先**只有 DSH 面**有（plugins/dsh-perf/index.js），
//   MCP 面拿不到 —— 也就是说「谁在反复重绘」这条**间歇性卡顿唯一有效的通路**，
//   对 MCP 连接的 agent 是关着的（而 perf_dump 那种"抓一个瞬间"的反而开着，
//   恰好把 agent 推向"猜"）。清单里 E4 是 P0：**DSH 有的，MCP 也要到**。
server.tool(
  'perf_trace',
  mcpDescription('perf_trace'),
  mcpShape('perf_trace'),
  async (args) => jtext(await trc().trace(args))
)

server.tool(
  'perf_hotstacks',
  mcpDescription('perf_hotstacks'),
  mcpShape('perf_hotstacks'),
  async (args) => jtext(await trc().hotstacks(args))
)

// ---------------------------------------------------------------- hang inspector
//
// The panel's one-click hang workflow, on the MCP surface: start the hang-loop
// monitor (it never clicks anything itself — the human drives the client),
// then read the evidence packs it collected and run the ClrMD stack analysis.

server.tool(
  'hang_status',
  mcpDescription('hang_status'),
  mcpShape('hang_status'),
  async () => jtext(hng().runStatus())
)

server.tool(
  'hang_run',
  mcpDescription('hang_run'),
  mcpShape('hang_run'),
  async (args) => jtext(hng().startRun({ maxSeconds: args.maxSeconds ?? 0 }))
)

server.tool(
  'hang_stop',
  mcpDescription('hang_stop'),
  mcpShape('hang_stop'),
  async () => jtext(hng().stopRun())
)

server.tool(
  'hang_packs',
  mcpDescription('hang_packs'),
  mcpShape('hang_packs'),
  async () => {
    const items = hng().listPacks()
    return jtext({ total: items.length, evidenceDir: hng().packsDir(), items })
  }
)

server.tool(
  'hang_pack',
  mcpDescription('hang_pack'),
  mcpShape('hang_pack'),
  async (args) => {
    const detail = hng().packDetail(args.id)
    if (detail === null) return text('pack not found: ' + args.id)
    return jtext(detail)
  }
)

server.tool(
  'hang_analyze',
  mcpDescription('hang_analyze'),
  mcpShape('hang_analyze'),
  async (args) => {
    const r = await hng().analyze(args.id, { wait: args.wait !== false, waitMs: args.waitMs ?? 300000, refresh: args.refresh === true })
    if (r.ok === false && r.status === 'error') {
      autoRecord('tool-error', 'hang_analyze', `hang analysis failed: ${String(r.error ?? 'unknown').slice(0, 200)}`)
    }
    return jtext(r)
  }
)

server.tool(
  'hang_delete',
  mcpDescription('hang_delete'),
  mcpShape('hang_delete'),
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
  // W1：description + 简单参数走注册表；headers（复杂 record）保持内联原样（hybrid）。
  mcpDescription('http_request'),
  { ...mcpShape('http_request'), headers: z.record(z.string(), z.string()).optional().describe('Request headers') },
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
  mcpDescription('memory_index'),
  mcpShape('memory_index'),
  async (args) => jtext(await mem().indexWorkspace(args.path, { budgetMs: args.budgetMs }))
)

server.tool(
  'memory_search',
  mcpDescription('memory_search'),
  mcpShape('memory_search'),
  async (args) => {
    const k = Math.min(Math.max(Math.round(args.k || 5), 1), 10)
    // 用带**索引新鲜度**的版本：命中可能来自索引快照，而源文件可能已变
    // （否则过期内容会被当成现状引用 —— 比"没命中"更危险）。与 DSH 面同源。
    const { hits, freshness } = await mem().searchDetailed(args.query, k)
    return jtext({
      embed: mem().embed.label,
      hits: hits.map((h) => ({ file: h.meta.file, chunk: h.meta.chunkIndex, score: +h.score.toFixed(3), text: String(h.meta.text).slice(0, 400) })),
      freshness,
      freshnessNote: freshness.note,
    })
  }
)

server.tool(
  'memory_save',
  mcpDescription('memory_save'),
  mcpShape('memory_save'),
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
  mcpDescription('memory_recall'),
  mcpShape('memory_recall'),
  async (args) => {
    const v = mem().recall(args.key, args.scope)
    // Flat shape: value is the stored string, not a nested row object.
    return jtext(v == null ? { found: false } : { found: true, key: v.key, value: v.value, scope: v.scope })
  }
)

server.tool(
  'memory_status',
  mcpDescription('memory_status'),
  mcpShape('memory_status'),
  async () => jtext(mem().status())
)

server.tool(
  'memory_forget',
  mcpDescription('memory_forget'),
  mcpShape('memory_forget'),
  async (args) => {
    mem().forget(args.key, args.scope || 'global')
    return jtext({ forgotten: true, key: args.key })
  }
)

// ---------------------------------------------------------------- build status
// build_run reported results but there was no way to re-read them, so an agent that lost the
// output (compaction, a long gap) had to re-run a build just to see it.

server.tool(
  'build_status',
  mcpDescription('build_status'),
  mcpShape('build_status'),
  async () => jtext(bld().status())
)

server.tool(
  'build_errors',
  mcpDescription('build_errors'),
  mcpShape('build_errors'),
  async () => jtext(bld().errorsOfLast())
)

server.tool(
  'build_compile_check',
  mcpDescription('build_compile_check'),
  mcpShape('build_compile_check'),
  async (args) => {
    // ⚠ F-051：`bld().config` 是**对象**（`makeBuilder` 返回 `{ config: c, … }`），不是函数。
    //   这里原来的写法是 `bld().config ? bld().config() : {}` —— 守卫判的是**真值**而不是**是不是函数**，
    //   对象恒为真 ⇒ 照样抛 `TypeError`。**守卫必须判类型**：`typeof x === 'function'`。
    const c = bld().config
    const cfg = typeof c === 'function' ? c() : (c || {})
    const root = args.repoRoot || cfg.clientRoot || cfg.repoRoot || undefined
    return jtext(checkCompileMembership(args.file, { projectPath: args.project, repoRoot: root }))
  }
)

// ---------------------------------------------------------------- failure corpus

server.tool(
  'failure_record',
  mcpDescription('failure_record'),
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
  mcpDescription('failure_query'),
  mcpShape('failure_query'),
  async (args) => jtext(fc().query(args))
)

server.tool(
  'failure_stats',
  mcpDescription('failure_stats'),
  mcpShape('failure_stats'),
  async () => jtext(fc().stats())
)

// E3 / F-042（2026-09-12 r36）：**"统一 health 工具"是一个 P0 能力缺口**，不是"测试没找到"。
//   两个互相隔离的黑盒 agent 独立要过同一个东西：工具描述里散落着 DSH_HANG_SRC_ROOT /
//   DSH_PERF_SYMBOL_PATH / DSH_UI_CLIENT_EXE / "需管理员"等硬前提，**却没有任何工具能查其当前值**。
//   后果很具体：源码根没配 ⇒ 只能给方法名、给不出 文件:行号 —— 而用户最想要的就是那一行。
server.tool(
  'toolchain_status',
  mcpDescription('toolchain_status'),
  mcpShape('toolchain_status'),
  async (args) => jtext(await buildToolchainStatus({ deep: args && args.deep === true }))
)

server.tool(
  'failure_retract',
  mcpDescription('failure_retract'),
  mcpShape('failure_retract'),
  async (args) => jtext(fc().retract(args))
)

// ---------------------------------------------------------------- api capture

server.tool(
  'capture_query',
  mcpDescription('capture_query'),
  mcpShape('capture_query'),
  async (args) => {
    // **新鲜度 + 调用方归因必须一起给**（2026-09-11 第十轮自查）：
    //   这段诚实性逻辑原来只写在 DSH 插件的 api_capture_query 里，MCP 面（agent 最常用的那个）
    //   只回 total/returned/items —— 于是"引擎没在跑 = 你看到的是历史数据"和
    //   "调用方归因根本没有生产者（F-004）"这两件事，在 MCP 面上完全不可见。
    //   现在三个面（插件工具 / 面板路由 / MCP）共用同一个 lib/query-view.mjs。
    const page = queryPage(args)
    // 捕获引擎跑在**宿主进程**里，MCP 进程看不到它 —— 但宿主开了回环路由，可以直接问。
    // 问不到就保持 null（"未知"），绝不猜成"没在跑"或"在跑"。
    let status = null
    try {
      const r = await fetch('http://127.0.0.1:3080/api/dsh-api-visualizer/capture/status', { signal: AbortSignal.timeout(3000) })
      if (r.ok) status = await r.json()
    } catch { status = null }
    const view = buildQueryView({ records: page && page.items, all: readAll(), status, callerFilter: String(args.caller ?? ''), retention: readRetention() })
    return jtext({
      ...page,
      ...view,
      freshnessNote: freshnessNote(view.freshness),
      callerAttributionNote: callerAttributionNote(view.callerAttribution),
      // 「没读到」≠「没有」：库被裁剪过时必须说清，否则 0 条会被读成"这段时间没这种调用"。
      retentionNote: retentionNote(view.retention),
    })
  }
)

/**
 * 捕获控制面：MCP 面**跑在另一个进程**里，引擎在**宿主进程**，所以只能走宿主开在回环上的路由。
 *
 * 为什么不自己起一个引擎：那会变成**第二个引擎同时 tail 同一个日志** ⇒ 每条记录进库两次，
 * 而面板上的"重复请求/调用次数"会整体翻倍（这正是 r38 里我差点误判成"客户端重复发请求"的形态）。
 * 所以这里只做**转发**，并如实区分"宿主没应答"与"宿主动手失败"。
 */
async function hostCapture(method, path, body) {
  const url = 'http://127.0.0.1:3080/api/dsh-api-visualizer' + path
  try {
    const res = await fetch(url, {
      method,
      headers: body === null ? undefined : { 'content-type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'GET' ? 5000 : 20000),
    })
    const data = await res.json().catch(() => null)
    if (data === null) {
      return { ok: false, error: '宿主路由 ' + path + ' 返回了非 JSON（HTTP ' + res.status + '）', httpStatus: res.status, hint: '宿主可能没加载 dsh-api-visualizer 插件。' }
    }
    // HTTP 状态如实带出去：409/500 是**宿主拒绝**，不是"调不通"。
    // 成功但路由没给 ok 时补一个（2xx 就是 ok）；失败一律 ok:false —— 别让上游看到 undefined 当成功。
    return { ...data, httpStatus: res.status, ...(res.ok ? (data.ok === undefined ? { ok: true } : {}) : { ok: false }) }
  } catch (e) {
    return {
      ok: false,
      error: '连不上宿主回环路由 ' + url + '：' + String(e && e.message ? e.message : e),
      hint: 'DSH 宿主没在跑或不是这个端口？这只说明"问不到宿主"，**不等于**捕获没在跑。',
    }
  }
}

server.tool(
  'capture_start',
  mcpDescription('capture_start'),
  mcpShape('capture_start'),
  async (args) => {
    const r = await hostCapture('POST', '/capture/start', { logPath: args.logPath, replay: args.replay === true })
    return jtext(r)
  }
)

server.tool(
  'capture_stop',
  mcpDescription('capture_stop'),
  mcpShape('capture_stop'),
  async () => jtext(await hostCapture('POST', '/capture/stop', {}))
)

server.tool(
  'capture_status',
  mcpDescription('capture_status'),
  mcpShape('capture_status'),
  async (args) => {
    const sampleSeconds = Math.min(Math.max(Number(args?.sampleSeconds) || 0, 0), 600)
    const snap = async () => {
      const s = await hostCapture('GET', '/capture/status', null)
      let realtimeCount = null
      try { realtimeCount = readAll().filter((x) => (x.source ?? '') === 'realtime').length } catch { /* null = 拿不到 */ }
      return { ts: Date.now(), emitted: Number(s.counters?.emitted) || 0, startedAt: Number(s.startedAt) || null, realtimeCount }
    }
    let integrityFromSample
    if (sampleSeconds > 0) {
      const before = await snap()
      await new Promise((r) => setTimeout(r, sampleSeconds * 1000))
      const after = await snap()
      integrityFromSample = sampleDeltaVerdict(before, after)
    }
    const r = await hostCapture('GET', '/capture/status', null)
    // summary 与 integrity 都**自己算一遍**：宿主可能是**旧代码**（不热加载），它的路由里没有这两项。
    // integrity（"引擎说 emit N 条，库里却多了 2N 行"）尤其重要 —— 它决定"面板里的调用次数能不能信"。
    let integrity = r.integrity
    if (integrity === undefined && Number(r.startedAt) > 0) {
      try {
        const startedAt = Number(r.startedAt)
        const realtimeSinceStart = readAll().filter((x) => (x.source ?? '') === 'realtime' && (Number(x.ts) || 0) >= startedAt - 1000).length
        integrity = doubleWriteVerdict({ emitted: Number(r.counters?.emitted) || 0, realtimeSinceStart })
      } catch { integrity = undefined }
    }
    const merged = { ...r, ...(integrity !== undefined ? { integrity } : {}) }
    const out = { ...merged, ...(integrityFromSample !== undefined ? { integrity: integrityFromSample, sampledSeconds: sampleSeconds } : {}) }
    const note = out.integrity && out.integrity.note ? '\n' + out.integrity.note : ''
    return jtext({ ...out, summary: summarizeCapture(out) + note })
  }
)

server.tool(
  'capture_append',
  mcpDescription('capture_append'),
  // records 复杂参数保持内联；放在 mcpShape 展开**之前**以复现原 properties 顺序（records, runId）。
  { records: z.array(z.object({ method: z.string(), url: z.string(), ts: z.number().optional() }).passthrough()).describe('Records: method+url required; ts/status/durationMs/reqBody/resBody/note/caller optional. Bodies ≤ 2MB. ts = when the call happened (epoch ms) — required in practice when importing/replaying HISTORICAL traffic, otherwise it is stored as NOW and the timeline shifts.'), ...mcpShape('capture_append') },
  async (args) => jtext(appendRecords(args.records, { runId: args.runId }))
)

server.tool(
  'perf_clean',
  mcpDescription('perf_clean'),
  mcpShape('perf_clean'),
  async (args) => jtext(cleanEvidence({ dir: prf().evidenceDir(), confirm: args.confirm === true, what: args.what, keepDays: args.keepDays }))
)

// ---------------------------------------------------------------- verification report

server.tool(
  'verify_report',
  mcpDescription('verify_report'),
  {
    runId: z.string().describe('Unique run id (e.g. task-2-toolchain-1)'),
    task: z.string().describe('One-line task name'),
    claims: z.array(z.object({
      statement: z.string().describe('The claim being made'),
      kind: z.enum(['build', 'api', 'file', 'git', 'gate', 'manual', 'compiled']).optional().describe('Adjudication rule; defaults to manual. compiled = does this source file actually belong to a project compile set (legacy .csproj does NOT auto-include .cs, so a forgotten <Compile Include> builds fine while never being compiled - kind=file cannot catch that); unreadable input yields unverified, never fail'),
      runId: z.string().optional().describe('For kind=build/api: which run the evidence belongs to'),
      path: z.string().optional().describe('For kind=file: path to check. For kind=compiled: source file whose compile membership is checked'),
      filter: z.record(z.string(), z.any()).optional().describe('For kind=api: capture-store filter (q/method/host/status/...)'),
      expect: z.object({ min: z.number().optional(), all2xx: z.boolean().optional() }).optional().describe('For kind=api: pass criteria (default min=1)'),
      project: z.string().optional().describe('For kind=compiled: explicit project file (*.csproj). Omitted = search upward from the file'),
    repoRoot: z.string().optional().describe('For kind=compiled: boundary for the upward project search'),
    repo: z.string().optional().describe('For kind=git: repo dir (default cwd); for kind=compiled it is used as a base for relative paths'),
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
