/**
 * dsh-ui-drive — DSH 插件（host 侧）：UI 自验驱动。
 *
 * 通过 Windows UIA 程序化操作正在运行的目标桌面客户端并截图留证，
 * 支撑「改完代码 → 驱动到目标页面 → 截图 → 视觉复核」的自验闭环：
 *  - agent 工具：ui_status / ui_launch / ui_drive / ui_tree / ui_flow
 *  - 安全护栏：副作用动作必须显式 allowSideEffects=true
 *  - 证据库：~/.dsh-agent-toolchain/ui-evidence/<时间戳>[-<tag>]\steps.json + 截图
 *  - Web 路由（仅回环）：证据浏览 / 截图直出，为后续 GUI 面板预留
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { homedir } from 'node:os'
import { makeDriver } from './lib/driver.mjs'
import { makeVision, UI_STATE_PROMPT } from './lib/vision.mjs'

export const name = 'dsh-ui-drive'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 150
const API = '/api/dsh-ui-drive'

const GUIDANCE =
  '本机已安装 dsh-ui-drive 插件（DSH 的 UI 自验驱动）：通过 Windows UIA 程序化操作正在运行的目标桌面客户端并截图留证，支撑「改完代码 → 启动/驱动客户端到目标页面 → 截图 → 视觉复核」的自验闭环。' +
  '工具：ui_status 查客户端进程/主窗口状态（未运行先 ui_launch）；ui_launch 启动客户端（构建产物（DSH_UI_CLIENT_EXE 指定），可 extraArgs 传 --remote-debugging-port=9222 等）并等待主窗口；' +
  'ui_windows 列出该进程所有顶层窗口（登录窗口/弹窗/主窗口各自一行，动态界面第一步先看这个）；' +
  'ui_drive(action=find|read|windows|shot|waitfor|click|setvalue|key|type|drag) 单步操作——find/read/windows/shot/waitfor 只读，click/setvalue/key/type/drag 是真实副作用操作，必须显式传 allowSideEffects=true 才执行；' +
  'ui_tree(maxDepth) 进程内视觉树 dump（真实类型+Name+AutomationId+DataContext 类型），只读深查；' +
  'ui_flow(steps, tag, failFast, allowSideEffects) 按步骤序列驱动并收集证据（find/click/setvalue/key/type/drag/read/windows/shot/wait/waitfor/expect），每步输出+截图写进证据目录 steps.json，返回 transcript。' +
  '动态界面（登录、验证码、按界面情况分支）必须「看一步再做下一步」：用 ui_drive 逐步走，先用 ui_windows/read/shot(describe=true) 看现状，再用 waitFor={ms,state:"appear|gone|enabled|disabled"} 等条件成立再点（别靠猜 sleep），同名控件用 index，容器内定位用 inAid/inName，回车提交用 type 的 {ENTER}，滑块验证码用 drag。' +
  '实时性：ui_drive 走常驻 PowerShell 进程（启动成本只付一次，实测单动作 p50 30ms）；ui_flow 整段序列进一个进程批量执行（13 步实测 1.6s）。DSH_UI_SERVE=0 可退回一次性进程路径。' +
  '视觉即返（推荐）：ui_launch 启动完成会自动截图并用视觉模型描述当前界面（返回 uiState.description，一步知道在登录页还是主界面）；ui_drive action=shot 加 describe=true 同样直接返回界面描述——优先用这两个，不必再单独 describe_image。需要深度视觉复核时才用 describe_image 对该 png 细看（当前主模型不读图，必须走 describe_image）。' +
  '安全边界：点击=真实操作（保存/生成/跳转可能落库）；「保存/删除/清空/导出」类按钮点击前先把按钮名报给用户确认；「下单/交易」类入口一律不点；优先用 find/read/shot/expect 做只读验证；定位卡住三步就停止报告，不盲点轰炸。' +
  '证据目录默认 ~/.dsh-agent-toolchain/ui-evidence（DSH_UI_EVIDENCE_DIR 可覆盖），目标进程名/窗口名/客户端 exe 分别由 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE 指定。' +
  '用户提到「UI 自验 / 驱动客户端 / 自动验证页面 / 截图验证 / 帮我点一下客户端」时即指本插件，请据此协作。'

let driver = null
let vision = null
function drv() {
  if (!driver) {
    driver = makeDriver({
      scriptsDir: join(import.meta.dirname, 'scripts'),
      procName: process.env.DSH_UI_PROC_NAME || '',
      windowName: process.env.DSH_UI_WINDOW_NAME || '',
      clientExe: process.env.DSH_UI_CLIENT_EXE || '',
      evidenceDir: process.env.DSH_UI_EVIDENCE_DIR || join(homedir(), '.dsh-agent-toolchain', 'ui-evidence'),
    })
  }
  return driver
}

function vsn() {
  if (!vision) vision = makeVision({})
  return vision
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * System-recorded failure: ui_flow assertion failures append to the failure
 * corpus automatically (the system observes, not the agent). Guarded dynamic
 * import: a standalone-copied plugin degrades to a no-op; inside the monorepo
 * it records for real.
 */
let corpusPromise
function autoRecord(failureClass, task, description, extra = {}) {
  if (corpusPromise === undefined) {
    corpusPromise = import('../../lib/failure-corpus.mjs')
      .then((m) => m.makeFailureCorpus({}))
      .catch(() => null)
  }
  corpusPromise.then((c) => {
    if (!c) return
    try {
      c.record({ task, failureClass, description, tags: ['auto', task], context: { runtime: 'dsh', ...(extra.context ?? {}) } })
    } catch { /* the corpus must never break the tool */ }
  })
}

/** 截图 + 视觉描述（视觉即返）：失败不阻断，返回 null；黑屏/空白自动等渲染重试。 */
async function shotWithVision({ workspace = '', label = 'state', waitBeforeMs = 0, maxRetries = 2 } = {}) {
  if (waitBeforeMs > 0) await sleep(waitBeforeMs)
  for (let i = 0; i <= maxRetries; i++) {
    const s = await drv().drive({ action: 'shot', label: i === 0 ? label : label + '-retry' + i, workspace })
    if (!s.ok) return null
    const v = await vsn().describeImage(s.workspacePath || s.path, UI_STATE_PROMPT)
    if (!v.ok) {
      return {
        screenshot: s.workspacePath || s.path,
        size: s.w + 'x' + s.h,
        description: null,
        visionError: v.error,
        visionModel: null,
      }
    }
    const looksBlank = /纯黑|全黑|黑屏|空白|无法识别/.test(v.text)
    if (!looksBlank) {
      return { screenshot: s.workspacePath || s.path, size: s.w + 'x' + s.h, description: v.text, visionError: null, visionModel: v.model }
    }
    if (i < maxRetries) await sleep(3000) // 窗口刚创建还没渲染完，等 3s 再截
    else return { screenshot: s.workspacePath || s.path, size: s.w + 'x' + s.h, description: v.text, visionError: null, visionModel: v.model, note: '界面可能尚未渲染完成' }
  }
  return null
}

const OBJECT = { type: 'object', additionalProperties: true }
const READ_ONLY_NOTE = '。注意：点击/输入是真实副作用操作（可能落库），必须先报按钮名给用户确认再执行；下单/交易类入口一律不点'

const tools = () => [
  defineTool({
    name: 'ui_status',
    description: '查目标桌面客户端的进程与主窗口状态（是否运行/PID/窗口标题/位置大小）。只读。未运行时用 ui_launch 拉起。Triggers: 客户端状态 / 客户端开着吗 / client status.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.running ? ('客户端运行中 pid=' + v.pid + ' 窗口=' + v.title) : '客户端未运行' }] },
    async execute() {
      return await drv().status()
    },
  }),
  defineTool({
    name: 'ui_launch',
    description: '启动目标桌面客户端（构建产物（DSH_UI_CLIENT_EXE 指定））并等待主窗口出现；已运行则直接返回现有进程。extraArgs 可传额外启动参数（如 --remote-debugging-port=9222 --remote-allow-origins=* 用于 CEF 内嵌页调试）。Triggers: 启动客户端 / 重启客户端 / launch client.',
    parameters: {
      extraArgs: { type: 'string', description: '额外启动参数（空格分隔），可为空' },
      waitMs: { type: 'number', description: '等待主窗口超时毫秒，默认 60000' },
      workspace: { type: 'string', description: '会话工作目录：启动后自动截图+视觉描述界面状态，截图副本放 <workspace>/.dsh-ui-evidence' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: (v.started ? ('已启动 pid=' + v.pid + ' 窗口=' + v.title) : (v.alreadyRunning ? '客户端已在运行（' + v.pid + '）' : '启动失败：' + (v.error || v.warning || ''))) + (v.uiState && v.uiState.description ? '\n当前界面：' + v.uiState.description : '') }] },
    timeoutMs: 120000,
    async execute(args) {
      const l = await drv().launch({ extraArgs: args.extraArgs || '', waitMs: args.waitMs || 60000 })
      // 视觉即返：等窗口渲染 3.5s 再截图描述（带黑屏重试），agent 一步知道当前在哪个页面
      if (l.started || l.alreadyRunning) {
        const st = await shotWithVision({ workspace: args.workspace || '', label: 'launch-state', waitBeforeMs: l.started ? 3500 : 0 })
        if (st) l.uiState = st
      }
      return l
    },
  }),
  defineTool({
    name: 'ui_drive',
    description: '对正在运行的目标客户端执行单步 UIA 操作（实时、有状态）。动作：find 定位控件；read 读可见控件（含输入框真实 value 与 #序号，序号可当 index 复用）；windows 列出该进程所有顶层窗口（登录窗口/弹窗/主窗口各自一行，动态界面先看这个）；shot 截主窗口 PNG（describe=true 直接返回视觉描述）；waitfor 等条件成立（state=appear|gone|enabled|disabled）；click 点击；setvalue ValuePattern 写值；key 键盘输入（中文走剪贴板粘贴）；type 键盘序列（{ENTER}/{TAB}/{ESC}/{DOWN}/^a 等，用于回车提交、Tab 跳转、下拉选择）；drag 鼠标拖拽（滑块验证码）。' +
      '动态界面三件套：waitFor={ms,interval,state,match,index} 让 click/setvalue/key/type/find/expect 先等条件成立再动手（不再靠猜 sleep）；index 取同名控件的第 N 个；inAid/inName 把查找限定在某个容器内。' + READ_ONLY_NOTE + '。click/setvalue/key/type/drag 必须传 allowSideEffects=true 才执行。截图传 workspace=<会话工作目录> 会复制到 workspace 的 .dsh-ui-evidence 供 describe_image 视觉复核。Triggers: 驱动客户端 / 点一下 / 输入 / 截图验证 / UI self-verify.',
    parameters: {
      action: { type: 'string', required: true, description: 'find | read | state | windows | shot | waitfor | click | setvalue | key | type | drag' },
      name: { type: 'string', description: '控件 Name（与 aid 二选一或都传）' },
      aid: { type: 'string', description: '控件 AutomationId' },
      value: { type: 'string', description: 'setvalue/key/type 的内容（type 支持 SendKeys 语法，如 1234{ENTER}）' },
      ascii: { type: 'boolean', description: 'key 模式用 ASCII 直发（纯代码/数字）；type 模式下 true=把 { } + ^ % ~ ( ) 当普通字符' },
      match: { type: 'string', description: 'read 的正则过滤；find/click 等传 match 时按控件名正则挑（配合 index）' },
      index: { type: 'number', description: '同名控件的序号（0 起；read 输出的 #序号 可直接复用）' },
      inAid: { type: 'string', description: '限定在该 AutomationId 的容器子树内查找' },
      inName: { type: 'string', description: '限定在该 Name 的容器子树内查找' },
      waitFor: { type: 'object', additionalProperties: true, description: '先等条件成立再执行：{ms?:5000, interval?:150, state?:"appear"|"gone"|"enabled"|"disabled", match?:控件名正则, index?}' },
      state: { type: 'string', description: 'waitfor 动作的等待条件：appear(默认) | gone | enabled | disabled' },
      keys: { type: 'string', description: 'type 模式的按键序列（等价 value，语义更清楚）' },
      fromX: { type: 'number', description: 'drag：起点 X（窗口客户区坐标）' },
      fromY: { type: 'number', description: 'drag：起点 Y' },
      toX: { type: 'number', description: 'drag：终点 X' },
      toY: { type: 'number', description: 'drag：终点 Y' },
      steps: { type: 'number', description: 'drag：拖动分几步（默认 12，步越小越像人手）' },
      holdMs: { type: 'number', description: 'drag：按下/松开前的停留毫秒（默认 120）' },
      waitMs: { type: 'number', description: '动作后等待毫秒，默认 250' },
      procId: { type: 'number', description: '指定进程 PID（默认自动找）' },
      allowSideEffects: { type: 'boolean', description: 'click/setvalue/key/type/drag 必须显式传 true 才执行' },
      workspace: { type: 'string', description: '会话工作目录：shot 时截图复制到 <workspace>/.dsh-ui-evidence 供视觉复核' },
      label: { type: 'string', description: '截图文件名标签（shot 用）' },
      describe: { type: 'boolean', description: 'shot 时顺带用视觉模型描述界面内容（视觉即返，一步拿到界面状态）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) }] },
    timeoutMs: 90000,
    async execute(args) {
      const r = await drv().drive(args)
      // shot 视觉即返：describe=true 时截图后直接返回界面描述
      if (r.ok && r.action === 'shot' && args.describe) {
        const v = await vsn().describeImage(r.workspacePath || r.path, UI_STATE_PROMPT)
        if (v.ok) r.description = v.text
        else r.visionError = v.error
      }
      return r
    },
  }),
  defineTool({
    name: 'ui_windows',
    description: '列出目标客户端进程的所有顶层窗口（类型/标题/handle/位置/是否离屏）。只读。登录窗口、验证码弹窗、模态对话框常常不是「主窗口」——动态界面（登录、切页、弹窗）第一步先看这个，再决定在哪操作。Triggers: 有哪些窗口 / 登录窗口 / 弹窗在哪 / list windows.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? (v.count + ' 个窗口：\n' + (v.lines || []).join('\n')) : '失败：' + (v.error || '') }] },
    timeoutMs: 60000,
    async execute() {
      return await drv().drive({ action: 'windows' })
    },
  }),
  defineTool({
    name: 'ui_state',
    description: '界面快照（只读，一步看清「现在是什么状态」）：当前主窗口名 + 当前焦点元素 + 交互型控件清单（按钮/输入框/页签/勾选/列表项，带 #序号、aid、enabled、真实输入值）。' +
      '动态界面每做一步之后先看它，比反复 read 省上下文（read 会连文本一起返回几百行）。match 可按控件名正则过滤，max 限制条数（默认 40）。Triggers: 现在什么界面 / 界面状态 / 焦点在哪 / ui state.',
    parameters: {
      match: { type: 'string', description: '按控件名正则过滤（如 登录|验证码）' },
      max: { type: 'number', description: '最多返回几条，默认 40' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('窗口=' + (v.window || '?') + ' 焦点=' + (v.focused || '无') + '\n交互控件 ' + v.count + ' 个：\n' + (v.lines || []).join('\n')) : '失败：' + (v.error || '') }] },
    timeoutMs: 60000,
    async execute(args) {
      return await drv().drive({ action: 'state', match: args.match || '', max: args.max || 40 })
    },
  }),
  defineTool({
    name: 'ui_observe',
    description: '只读观察（推荐入口，无需 allowSideEffects）：find 定位 / read 读控件与真实输入值 / state 界面快照（窗口+焦点+交互控件）/ windows 顶层窗口 / waitfor 等条件成立 / expectwindow 窗口出现或消失 / expecttext 文本出现 / waitany 多条件竞速 / shot 截图。' +
      '动态界面（登录、验证码、按界面情况分支）的循环就是：ui_observe 看现状 → 决定 → ui_act 动手 → 再 ui_observe 确认。' +
      'waitany 是判定登录结果的关键：一次同时押注「主窗口出现」「错误文本出现」「登录窗口还在」三支，返回命中的那支。Triggers: 看界面 / 等条件 / 判断登录结果 / observe.',
    parameters: {
      action: { type: 'string', required: true, description: 'find | read | state | windows | waitfor | expectwindow | expecttext | waitany | shot' },
      name: { type: 'string', description: '控件 Name' },
      aid: { type: 'string', description: '控件 AutomationId' },
      match: { type: 'string', description: 'read/state 的控件名正则；find/click 用 match 时按名字挑（配合 index）' },
      textRe: { type: 'string', description: 'expecttext / waitany(text)：文本正则（抓 ErrorInfo 之类）' },
      titleRe: { type: 'string', description: 'expectwindow / waitany(window)：窗口标题正则' },
      gone: { type: 'boolean', description: 'expectwindow：true = 等窗口消失' },
      ms: { type: 'number', description: '等待上限毫秒（默认 5000；waitany 默认 15000）' },
      interval: { type: 'number', description: '轮询间隔毫秒（默认 150）' },
      state: { type: 'string', description: 'waitfor 条件：appear(默认) | gone | enabled | disabled' },
      waitFor: { type: 'object', additionalProperties: true, description: '{ms?, interval?, state?, match?, index?}' },
      conds: { type: 'array', description: 'waitany 条件数组：[{kind:"window"|"text"|"appear"|"gone"|"enabled"|"disabled", titleRe?, textRe?, name?, aid?, label?}]' },
      index: { type: 'number', description: '同名控件序号（0 起；read 输出的 #序号 可直接用）' },
      inAid: { type: 'string', description: '限定在容器 AutomationId 子树内查找' },
      winTitle: { type: 'string', description: '限定在标题匹配的窗口内查找（跨窗口定位）' },
      max: { type: 'number', description: 'state 最多返回控件数（默认 40）' },
      label: { type: 'string', description: 'shot 文件名标签' },
      procId: { type: 'number', description: '指定进程 PID（默认自动找）' },
      workspace: { type: 'string', description: 'shot：截图副本放到 <workspace>/.dsh-ui-evidence' },
      describe: { type: 'boolean', description: 'shot：顺带返回视觉描述' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) }] },
    timeoutMs: 120000,
    async execute(args) {
      const r = await drv().drive({ ...args, action: args.action })
      if (r.ok && r.action === 'shot' && args.describe) {
        const v = await vsn().describeImage(r.workspacePath || r.path, UI_STATE_PROMPT)
        if (v.ok) r.description = v.text
        else r.visionError = v.error
      }
      return r
    },
  }),
  defineTool({
    name: 'ui_act',
    description: '真实操作客户端（副作用，必须 allowSideEffects=true）：click 点击 / setvalue 写值（受限输入框如手机号框走它，绕开按键过滤）/ key 键盘输入（中文走剪贴板）/ type 键盘序列（{ENTER}/{TAB}/{ESC}，回车提交、Tab 跳转）/ drag 鼠标拖拽（滑块验证码）。' +
      '写输入后驱动会回读校验，值没进去直接报错（不再假成功）；密码/验证码类控件的值不回显、不落证据；买入/卖出/下单/委托/支付类控件被驱动层硬拒绝，传 true 也点不动。' +
      'observe=true 时动作后直接附带界面快照（窗口+焦点+交互控件），省一次往返。凭据用 ${cred:name} 占位符（驱动进程从环境变量 DSH_CRED_name 展开，模型看不到明文）。' + READ_ONLY_NOTE + '。Triggers: 点一下 / 输入 / 登录 / 拖滑块 / ui act.',
    parameters: {
      action: { type: 'string', required: true, description: 'click | setvalue | key | type | drag' },
      name: { type: 'string', description: '控件 Name' },
      aid: { type: 'string', description: '控件 AutomationId' },
      value: { type: 'string', description: 'setvalue/key/type 的内容；支持 ${cred:name} 占位符（凭据不经过模型）' },
      keys: { type: 'string', description: 'type 的按键序列（等价 value，语义更清楚）' },
      ascii: { type: 'boolean', description: 'key：ASCII 直发（逐字符 keybd_event）；type：把 {}^%~() 当普通字符' },
      match: { type: 'string', description: '按控件名正则挑目标（配合 index）' },
      index: { type: 'number', description: '同名控件序号（0 起）' },
      inAid: { type: 'string', description: '限定在容器内查找' },
      winTitle: { type: 'string', description: '限定在标题匹配的窗口内操作' },
      waitFor: { type: 'object', additionalProperties: true, description: '先等条件成立再动手：{ms?, state?, match?, index?}' },
      expectValue: { type: 'string', description: 'type：写完回读校验的期望值（不一致 → ok:false）' },
      secret: { type: 'boolean', description: 'true = 输出与证据里对该值打码' },
      fromX: { type: 'number', description: 'drag 起点 X（客户区坐标）' },
      fromY: { type: 'number', description: 'drag 起点 Y' },
      toX: { type: 'number', description: 'drag 终点 X' },
      toY: { type: 'number', description: 'drag 终点 Y' },
      observe: { type: 'boolean', description: '动作后附带界面快照' },
      observeMatch: { type: 'string', description: '快照里控件名过滤正则' },
      waitMs: { type: 'number', description: '动作后等待毫秒（默认 250）' },
      procId: { type: 'number', description: '指定进程 PID' },
      allowSideEffects: { type: 'boolean', description: '必须为 true 才执行（安全护栏）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) + (v.observe ? '\n动作后界面：窗口=' + (v.observe.window || '?') + ' 焦点=' + (v.observe.focused || '无') + '\n' + (v.observe.lines || []).join('\n') : '') }] },
    timeoutMs: 120000,
    async execute(args) {
      return await drv().drive(args)
    },
  }),
  defineTool({
    name: 'ui_tree',
    description: '进程内视觉树 dump：注入只读探针进客户端进程，输出真实控件类型 + Name + AutomationId + DataContext 类型（比 UIA 信息全，深度定位绑定/模板问题）。只读，不弹窗。Triggers: 视觉树 / 控件结构 / dump-tree.',
    parameters: {
      maxDepth: { type: 'number', description: '最大深度，默认 8，上限 20' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('视觉树（' + (v.truncated ? '已截断' : '完整') + '）：\n' + v.text) : 'dump 失败：' + v.error }] },
    timeoutMs: 180000,
    async execute(args) {
      return await drv().tree({ maxDepth: args.maxDepth || 8 })
    },
  }),
  defineTool({
    name: 'ui_flow',
    description: '按步骤序列驱动客户端并收集自验证据：steps 数组每步 {action: find|click|setvalue|key|type|drag|read|windows|shot|wait|waitfor|expect, name?, aid?, value?, keys?, ascii?, match?, index?, inAid?, inName?, waitFor?, state?, fromX?/fromY?/toX?/toY?, waitMs?, label?, expectEnabled?, expectMatch?}；' +
      'expect/waitfor 步做断言并计入 passed/failed（waitfor 等条件成立：state=appear|gone|enabled|disabled）；waitFor 可挂在任意动作上（先等再动，替代固定 sleep）；index 取同名控件第 N 个，inAid/inName 限定容器。' +
      '每步输出+截图写入证据目录 steps.json，返回 transcript。默认只读（find/read/windows/shot/wait/waitfor/expect），含 click/setvalue/key/type/drag 必须传 allowSideEffects=true。failFast=true 时断言失败即停。整段序列在一个 PowerShell 进程里批量执行（步间无进程启动开销），waitMs 只在动作需要静默时传（默认 250ms，find/read/shot/expect/windows 不等待）。' +
      '需要「看一步再做下一步」的复杂流程（登录、验证码、按界面情况分支）用 ui_drive 逐步走，别用 ui_flow 预排。Triggers: UI 自验 / 自动验证流程 / 端到端验证 / ui flow.',
    parameters: {
      steps: { type: 'array', required: true, description: '步骤数组（每步一个对象，action 必填）' },
      tag: { type: 'string', description: '证据目录标签（如 verify-etf-dialog），默认 flow' },
      failFast: { type: 'boolean', description: '断言失败即停，默认 false' },
      allowSideEffects: { type: 'boolean', description: '含点击/输入/拖拽步骤时必须显式传 true' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: '自验流程结束：' + v.passed + ' 通过 / ' + v.failed + ' 失败（批量执行 ' + (v.elapsedMs != null ? v.elapsedMs + 'ms' : '?') + '），证据：' + v.evidenceDir }] },
    timeoutMs: 600000,
    async execute(args) {
      const v = await drv().flow(args)
      if (v.failed > 0) {
        autoRecord('verification-failure', 'ui_flow', 'ui_flow assertion failure: ' + v.failed + '/' + v.totalSteps + ' steps failed (evidence: ' + (v.stepsJson || v.evidenceDir || '?') + ')', { context: { tag: args.tag || 'flow' } })
      }
      return v
    },
  }),
]

function renderDrive(v) {
  if (!v.ok) return '失败：' + (v.error || '未知错误')
  switch (v.action) {
    case 'find': return v.found ? ('找到：' + v.detail + (v.count > 1 ? '（共 ' + v.count + ' 个匹配，可用 index 指定第几个）' : '')) : '未找到目标控件'
    case 'read': return '读到 ' + v.count + ' 个控件：\n' + (v.lines || []).join('\n')
    case 'windows': return v.count + ' 个顶层窗口：\n' + (v.lines || []).join('\n')
    case 'waitfor': return (v.found ? '条件已满足' : '条件已满足（目标已消失）') + '（等待 ' + (v.waitedMs || 0) + 'ms）' + (v.detail ? '：' + v.detail : '')
    case 'shot': return '截图：' + v.path + ' ' + v.w + 'x' + v.h + (v.workspacePath ? '（副本 ' + v.workspacePath + '，可用 describe_image 复核）' : '') + (v.description ? '\n界面描述：' + v.description : '')
    default: return v.output || '完成'
  }
}

// ---------------------------------------------------------------- Web 路由（仅回环，面板雏形）

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' }

function makeRoutes() {
  return [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        const method = req.method || 'GET'
        const rest = (req.url || '').split('?')[0].slice(API.length) || '/'

        // GET /status — 插件与客户端状态
        if (method === 'GET' && rest === '/status') {
          const st = await drv().status()
          writeJson(res, 200, {
            plugin: 'dsh-ui-drive',
            clientRunning: st.running,
            clientPid: st.pid || null,
            windowTitle: st.title || null,
            clientExe: drv().clientExe(),
            evidenceDir: drv().evidenceDir(),
            scriptsOk: existsSync(join(drv().scriptsDir(), 'ui-drive.ps1')) && existsSync(join(drv().scriptsDir(), 'ui-probe.ps1')),
            batchOk: existsSync(join(drv().scriptsDir(), 'ui-drive-batch.ps1')),
            warm: drv().warmStatus(),
          })
          return
        }

        // GET /evidence — 证据目录列表
        if (method === 'GET' && rest === '/evidence') {
          const root = drv().evidenceDir()
          let dirs = []
          if (existsSync(root)) {
            dirs = readdirSync(root, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => {
                const p = join(root, d.name)
                const files = existsSync(join(p, 'steps.json')) ? readdirSync(p).filter((f) => /\.(png|json|log|txt)$/.test(f)) : []
                const st = statSync(p)
                return { id: d.name, ts: st.mtimeMs, files }
              })
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 50)
          }
          writeJson(res, 200, { root, dirs })
          return
        }

        // GET /evidence/{id} — steps.json 内容
        const evMatch = rest.match(/^\/evidence\/([^/]+)$/)
        if (method === 'GET' && evMatch !== null) {
          const id = decodeURIComponent(evMatch[1])
          if (id.includes('..') || id.includes('\\')) { writeJson(res, 400, { error: 'bad id' }); return }
          const p = join(drv().evidenceDir(), id, 'steps.json')
          if (!existsSync(p)) { writeJson(res, 404, { error: 'steps.json not found' }); return }
          try { writeJson(res, 200, JSON.parse(readFileSync(p, 'utf8'))) } catch { writeJson(res, 500, { error: 'steps.json parse failed' }) }
          return
        }

        // GET /evidence/{id}/files/{file} — 截图/日志原文
        const fileMatch = rest.match(/^\/evidence\/([^/]+)\/files\/([^/]+)$/)
        if (method === 'GET' && fileMatch !== null) {
          const id = decodeURIComponent(fileMatch[1])
          const file = decodeURIComponent(fileMatch[2])
          if (id.includes('..') || id.includes('\\') || file.includes('..') || file.includes('\\') || file.includes('/')) { writeJson(res, 400, { error: 'bad path' }); return }
          const p = join(drv().evidenceDir(), id, file)
          if (!existsSync(p)) { writeJson(res, 404, { error: 'file not found' }); return }
          const ext = extname(file).toLowerCase()
          const ct = MIME[ext] || 'application/octet-stream'
          res.writeHead(200, { 'content-type': ct, 'referrer-policy': 'no-referrer' })
          res.end(readFileSync(p))
          return
        }

        // POST /shot — 立即截图直出（GUI 面板雏形）
        if (method === 'POST' && rest === '/shot') {
          const r = await drv().drive({ action: 'shot', label: 'panel' })
          if (!r.ok) { writeJson(res, 500, { error: r.error || 'shot failed' }); return }
          res.writeHead(200, { 'content-type': 'image/png', 'referrer-policy': 'no-referrer', 'x-shot-path': r.path })
          res.end(readFileSync(r.path))
          return
        }

        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

// ---------------------------------------------------------------- apply

export function apply(ctx) {
  let disposers = []
  let disposeRoutes = () => {}
  ctx.effect(
    () => {
      for (const tool of tools()) disposers.push(ctx.tools.register(tool))
      const routeDisposers = makeRoutes().map((route) => ctx.webServer.register(route))
      disposeRoutes = () => { for (const d of routeDisposers) d() }
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-ui-drive', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        disposeRoutes()
        disposeSection()
        // 卸载时回收常驻 PowerShell 进程，避免插件重载后留下孤儿进程
        try { driver && driver.warmShutdown() } catch { /* ignore */ }
      }
    },
    'dsh-ui-drive: tools+routes',
  )
}
