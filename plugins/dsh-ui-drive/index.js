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
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在各 defineTool 的 name）。
import { dshParameters, dshDescription } from '../../lib/tool-registry.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { homedir } from 'node:os'
import { makeDriver } from './lib/driver.mjs'
import { renderDrive, renderState, renderFlow, sanitizeLive, launchText, renderLive, framePathText } from './lib/render.mjs'
import { makeVision, UI_STATE_PROMPT } from './lib/vision.mjs'
import { makeLive } from './lib/live.mjs'
import { envOr } from '../../lib/env-fallback.mjs'

export const name = 'dsh-ui-drive'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 150
const API = '/api/dsh-ui-drive'

const GUIDANCE =
  '本机已安装 dsh-ui-drive 插件（DSH 的 UI 自验驱动）：通过 Windows UIA 程序化操作正在运行的目标桌面客户端并截图留证，支撑「改完代码 → 启动/驱动客户端到目标页面 → 截图 → 视觉复核」的自验闭环。' +
  '工具：ui_status 查客户端进程/主窗口状态（未运行先 ui_launch）；ui_launch 启动客户端（构建产物（DSH_UI_CLIENT_EXE 指定），可 extraArgs 传 --remote-debugging-port=9222 等）并等待主窗口；' +
  'ui_windows 列出该进程所有顶层窗口（登录窗口/弹窗/主窗口各自一行，动态界面第一步先看这个）；' +
  'ui_drive(action=find|read|windows|shot|waitfor|click|setvalue|key|type|drag) 单步操作——find/read/windows/shot/waitfor 只读，click/setvalue/key/type/drag/clickat/doubleclick 是真实副作用操作，必须显式传 allowSideEffects=true 才执行；' +
  'ui_tree(maxDepth) 进程内视觉树 dump（真实类型+Name+AutomationId+DataContext 类型），只读深查；' +
  'ui_flow(steps, tag, failFast, allowSideEffects) 按步骤序列驱动并收集证据（find/click/setvalue/key/type/drag/read/windows/shot/wait/waitfor/expect），每步输出+截图写进证据目录 steps.json，返回 transcript。' +
  '动态界面（登录、验证码、按界面情况分支）必须「看一步再做下一步」：用 ui_drive 逐步走，先用 ui_windows/read/shot(describe=true) 看现状，再用 waitFor={ms,state:"appear|gone|enabled|disabled"} 等条件成立再点（别靠猜 sleep），同名控件用 index，容器内定位用 inAid/inName，回车提交用 type 的 {ENTER}，滑块验证码用 drag。' +
  '实时性：ui_drive 走常驻 PowerShell 进程（启动成本只付一次，实测单动作 p50 30ms）；ui_flow 整段序列进一个进程批量执行（13 步实测 1.6s）。DSH_UI_SERVE=0 可退回一次性进程路径。' +
  '观测完整性（B-1）：read/state 结果恒带 skipped=N——本次枚举里「读不到状态」而被跳过的元素数（类型白名单/offscreen/match/去重这些正常过滤不算）；skipped>0 时同结果附带 warn，明确写出「本次清单不完整」。别把「没读到」当成「界面上没有」；skipped=null 表示该路径没回报（未知），不等于 0。' +
  '视觉即返（推荐）：ui_launch 启动完成会自动截图并用视觉模型描述当前界面（返回 uiState.description，一步知道在登录页还是主界面）；ui_drive action=shot 加 describe=true 同样直接返回界面描述——优先用这两个，不必再单独 describe_image。需要深度视觉复核时才用 describe_image 对该 png 细看（当前主模型不读图）。' +
  // ⚠ R1-09（2026-09-14 夜，黑盒验收 agent 原话）：「描述叫我调 describe_image，但本面只有 read_image，没有 describe_image」。
  //   这类"描述把人指去空处"本仓早有机器化的关（`lib/toolface-parity.test.mjs` 的 F-040：描述里 `` `工具名(` `` 必须在本面存在），
  //   但 `describe_image` 被写进了那张测试的**宿主工具白名单**（`NON_PLUGIN_TOOLS`）⇒ **白名单一写，关就绕过去了**，而本面根本没有它。
  //   修法不是删引用（有它的面仍然该用），而是把依赖说清楚 + 给出没有它时的退路。
  '⚠ 但 `describe_image` 是**宿主提供的工具、不属于本插件**：**当前这一面不一定有它**（本机实测：只有 `read_image`）。没有它时就用 `read_image` 自己看那张 png，或改用 `shot` 的 `describe=true` 直接拿界面描述。' +
  '实时看见（agent 专用）：ui_live(action=start|stop|status|frame|wait) 后台循环抓「窗口内容」帧（1500ms 默认，不抢前台不恢复最小化）；frame 返回帧 hash+控件状态+**绝对路径 frame.pathAbs**，read_image(frame.pathAbs) 即看见当前画面（frame.path 只是文件名，别直接喂给 read_image）；wait({fromHash}) 阻塞等画面变化；未 start 时 frame 退化为一次捕获。敏感帧（焦点=密码/验证码）默认不给路径（allowSensitive=true 才给）。截图一律在 E 盘证据目录。' +
  '安全边界：点击=真实操作（保存/生成/跳转可能落库）；「保存/删除/清空/导出」类按钮点击前先把按钮名报给用户确认；' +
  '「按名硬拒」名单**只有运维显式配置 DSH_UI_DENY_RE 后才存在**——**默认为空 = 什么都不拦**，所以**不能拿它当兜底**，' +
  '真正的护栏是"先报按钮名给用户确认"这条纪律本身；' +
  '**运维级护栏**（实现早就有，描述里原本一个字没提 —— Claude r15 复核补上）：外部急停总闸 DSH_UI_ESTOP_FILE（哨兵在盘上时**任何**副作用动作一律拒，' +
  '且删掉哨兵**不等于**复位）、deny-first 策略表 DSH_UI_APP_POLICY。被它们拦住时返回带 `policyCode`（stopped_by_user / policy_unavailable）；' +
  '**复位只有运维能做**：本机回环 `GET /api/dsh-ui-drive/estop` 看状态、`POST /api/dsh-ui-drive/estop/reset` 复位 —— ' +
  '刻意不做成 agent 工具（让模型能解除自己的护栏等于没有护栏）；' +
  '注意 DSH_UI_SAFETY_POLICY_FILE 只是**声明性文本**（会被读进来但不参与判定），它**不拦任何动作** ——' +
  '真要拦请用 DSH_UI_APP_POLICY（规则表）或 DSH_UI_ESTOP_FILE（总闸）；' +
  '优先用 find/read/shot/expect 做只读验证；定位卡住三步就停止报告，不盲点轰炸。' +
  '证据目录默认 ~/.dsh-agent-toolchain/ui-evidence（DSH_UI_EVIDENCE_DIR 可覆盖），目标进程名/窗口名/客户端 exe 分别由 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE 指定。' +
  '用户提到「UI 自验 / 驱动客户端 / 自动验证页面 / 截图验证 / 帮我点一下客户端」时即指本插件，请据此协作。'

let driver = null
let vision = null
function drv() {
  if (!driver) {
    driver = makeDriver({
      scriptsDir: join(import.meta.dirname, 'scripts'),
      // **必须走 env-fallback**：这里是 DSH 面的配置入口，而 `makeDriver` 内部虽然也读环境变量，
      // 但**显式传入的值会覆盖它** —— 传空串进去等于把内部那层正确的回退给屏蔽了。
      // 真机后果：DSH 面（面板/DSH 工具）看不到用户配的进程名/客户端路径，而 MCP 面正常
      // → 同一个工具两个面行为不同，症状还像"没做这个功能"（F-003 同族）。
      procName: envOr('DSH_UI_PROC_NAME'),
      windowName: envOr('DSH_UI_WINDOW_NAME'),
      clientExe: envOr('DSH_UI_CLIENT_EXE'),
      evidenceDir: envOr('DSH_UI_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'ui-evidence'),
    })
  }
  return driver
}

function vsn() {
  if (!vision) vision = makeVision({})
  return vision
}

let live = null
function liveCtl() {
  // 模块级单例：宿主热重载/多路复用下绝不出现两个 setInterval（双循环双写 latest.png）
  if (!live) live = makeLive({ driver: drv() })
  return live
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
async function shotWithVision({ workspace = '', label = 'state', waitBeforeMs = 0, maxRetries = 2, procId = 0, allowSensitive = false } = {}) {
  if (waitBeforeMs > 0) await sleep(waitBeforeMs)
  for (let i = 0; i <= maxRetries; i++) {
    const s = await drv().drive({ action: 'shot', label: i === 0 ? label : label + '-retry' + i, workspace, procId })
    if (!s.ok) return null
    // r44：交给视觉模型之前先问一句「焦点在密码框上吗」。像素无法脱敏 ⇒ 默认拒，只留 allowSensitive 这个显式出口。
    // 截图文件本身照常落盘（本地证据目录，不出网）。
    const sens = await drv().secretFocusNow({ procId })
    if (!allowSensitive && (sens.secret === true || sens.unknown === true)) {
      return {
        screenshot: s.workspacePath || s.path, size: s.w + 'x' + s.h,
        description: null, visionModel: null, visionError: null,
        describeSkipped: sens.unknown ? 'sensitivity-unknown' : 'secretFocused',
        note: sens.unknown
          ? '**没有把这张截图交给视觉模型**：查不到当前焦点（' + sens.reason + '），而密码输入那一刻查不到正是常态 —— 按 fail-closed 拒了。截图已落证据目录：' + (s.workspacePath || s.path) + '；确认画面无敏感内容后可传 allowSensitive=true 解锁。'
          : '**没有把这张截图交给视觉模型**：当前焦点在密码/验证码/token 类控件上（' + (sens.focused || '未知控件') + '），像素无法脱敏。截图已落证据目录：' + (s.workspacePath || s.path) + '；确认画面无敏感内容后可传 allowSensitive=true 解锁。',
      }
    }
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
const READ_ONLY_NOTE = '。注意：点击/输入是真实副作用操作（可能落库），必须先报按钮名给用户确认再执行；「按名硬拒」名单默认为空（未配 DSH_UI_DENY_RE 时什么都不拦），别拿它当兜底；运维若配了急停（DSH_UI_ESTOP_FILE）或策略表（DSH_UI_APP_POLICY），被拦时返回带 policyCode，复位走运维路径 /api/dsh-ui-drive/estop/reset'

/** R-01（2026-09-17）：把「没有界面描述」的原因显示出来 —— 旧写法只渲染 description，
 *  视觉调用失败时**什么都不显示**，于是 agent/用户只看到"等了半天、什么都没有"。 */
function launchVisionNote(v) {
  const s = v && v.uiState
  if (!s || s.description) return ''
  const why = s.visionError || s.describeSkipped || s.note || '未产出描述（原因未回报）'
  return '\n（没有界面描述：' + why + '）'
}

const tools = () => [
  defineTool({
    name: 'ui_status',
    description: dshDescription('ui_status'),
    parameters: dshParameters('ui_status'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.running ? ('客户端运行中 pid=' + v.pid + ' 窗口=' + v.title) : (v.unknown ? ('客户端状态未知：' + (v.error || '查询超时')) : '客户端未运行') }] },
    async execute(args) {
      // 传下去才算真的支持（参数存在但被忽略 = 最坏的一种）
      return await drv().status(args?.procId ? { procId: args.procId } : {})
    },
  }),
  defineTool({
    name: 'ui_launch',
    description: dshDescription('ui_launch'),
    parameters: dshParameters('ui_launch'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: launchText(v) + (v.uiState && v.uiState.description ? '\n当前界面：' + v.uiState.description : '') + launchVisionNote(v) }] },
    timeoutMs: 120000,
    async execute(args) {
      const l = await drv().launch({ extraArgs: args.extraArgs || '', waitMs: args.waitMs || 60000, force: args.force === true })
      // 视觉即返：等窗口渲染 3.5s 再截图描述（带黑屏重试），agent 一步知道当前在哪个页面。
      // UD-06：只在**窗口真的可用**（ok）时才截图 —— 半成功时没有主窗口，
      // 截图要么失败、要么抓到别的窗口（闪屏/其它进程），把一张不相干的画面当成"客户端界面"。
      //
      // R-01（2026-09-17，用户报障「客户端都启动半天了，ui_launch 还在等待」）：
      //   **只有"这次真的启动了"才做视觉即返**。旧写法只判 `l.ok === true`，而"客户端已在运行"
      //   这条路径同样返回 ok:true（driver.launch 走到 432-435 行 ⇒ alreadyRunning:true /
      //   started:false / waitedMs:0，判启动本身是 0 秒），于是**什么都没启动也照样**跑完
      //   「截图 → 焦点检查 → 远程视觉描述」三步。
      //   真机实测（2026-09-17 16:09，客户端早已在跑）：建证据目录 16:09:39 → 截图落盘 16:09:55
      //   → 焦点检查 16:10:12 → 之后才调视觉模型，整轮 ≈33s，而 GUI 上看起来就是"还在等"。
      //   现在：started !== true ⇒ 直接返回；要看当前界面请走 ui_status / ui_drive(shot, describe=true)。
      if (l.ok === true && l.started === true) {
        const st = await shotWithVision({ workspace: args.workspace || '', label: 'launch-state', waitBeforeMs: 3500, allowSensitive: args.allowSensitive === true })
        if (st) l.uiState = st
      }
      return l
    },
  }),
  defineTool({
    name: 'ui_drive',
    description: dshDescription('ui_drive'),
    parameters: {
      action: { type: 'string', required: true, enum: ['find', 'read', 'state', 'windows', 'shot', 'waitfor', 'click', 'setvalue', 'key', 'type', 'drag', 'clickat', 'doubleclick', 'pattern', 'scroll', 'selecttext', 'move', 'wheel', 'capture', 'state-live'], description: 'find | read | state | windows | shot | waitfor | click | setvalue | key | type | drag | clickat | doubleclick | pattern | scroll | selecttext | move | wheel | capture | state-live（clickat=按窗口客户区坐标点击，用于 UIA 拿不到稳定元素的表格行/图表点位——坐标脆弱，窗口一移动就失效；doubleclick=元素级双击（UIA GetClickablePoint，不是坐标）；pattern=调用元素**真正暴露**的 UIA pattern：动作名放 value/keys，支持 Expand|Collapse|Increment|Decrement|Select|AddToSelection|RemoveFromSelection|ScrollIntoView|Toggle|Invoke|Focus|Close|Minimize|Maximize|Restore（展开树节点/自增数字/多选/最大化窗口——比盲点击稳得多，元素不支持会明确报错而不是回退成点击）；scroll=语义滚动，对元素或最近可滚动祖先调 ScrollPattern，方向放 value（up/down/left/right），页数放 count；selecttext=TextPattern 精确选区，text 放 value、prefix 放 match、suffix 放 expectValue、selectionType 放 state（text|cursor_before|cursor_after）；move/wheel=移动鼠标/滚轮，只读白名单、不需 allowSideEffects；capture=抓一帧窗口内容；state-live=免前台状态采样）' },
      name: { type: 'string', description: '控件 Name（与 aid 二选一或都传）' },
      aid: { type: 'string', description: '控件 AutomationId' },
      value: { type: 'string', description: 'setvalue/key/type 的内容（type 支持 SendKeys 语法，如 1234{ENTER}）；**支持 ${cred:name} 占位符** —— 驱动进程从环境变量 DSH_CRED_name 展开，密码不经过模型、不进证据' },
      ascii: { type: 'boolean', description: 'key 模式用 ASCII 直发（纯代码/数字）；type 模式下 true=把 { } + ^ % ~ ( ) 当普通字符' },
      match: { type: 'string', description: 'read 的正则过滤；find/click 等传 match 时按控件名正则挑（配合 index）' },
      index: { type: 'number', description: '同名控件的序号（0 起；read 输出的 #序号 可直接复用）' },
      inAid: { type: 'string', description: '限定在该 AutomationId 的容器子树内查找/读取（read/state 也生效，结果标 narrowed+scope；容器名写错会明确失败，不会退化成读整窗）' },
      inName: { type: 'string', description: '限定在该 Name 的容器子树内查找/读取（read/state 也生效，结果标 narrowed+scope）' },
      waitFor: { type: 'object', additionalProperties: true, description: '先等条件成立再执行：{ms?:5000, interval?:150, state?:"appear"|"gone"|"enabled"|"disabled", match?:控件名正则, index?}。目标取「动作自身的 name/aid」→「waitFor 里的 name/aid」→「只给 match（整树正则）」三者之一；三者全空会明确报「缺少目标」。read/state 也支持（等列表刷出来再读；state-live 请走 ui_observe/ui_act —— 不在本动作枚举里）。**代价**：match-only 每轮要整树枚举（真机实测 3331ms/轮 vs aid/name 的 1087ms，约 3×），且 `ms` 不是硬上限（轮询中途不可中断，实测 ms=8000 → 实际 11054ms）——所以 match-only 的 ms 上限被收紧到 15000；循环等待/时间敏感场景请**给 aid 或 name**。失败时会回报 polls/lastPollMs 让你看清代价花在哪。' },
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
      allowSideEffects: { type: 'boolean', description: 'click/setvalue/key/type/drag/clickat/doubleclick 必须显式传 true 才执行' },
      secret: { type: 'boolean', description: 'true = 输出与证据里对该值打码（默认 false）。**密码/验证码类控件本来就自动掩码**（读回来是 <secret:Nchars>）；secret 是给「长得不像密码框的敏感输入」（例如令牌框）用的 —— 两者取或' },
      allowSensitive: { type: 'boolean', description: 'describe=true 时的显式解锁：焦点在密码/验证码/token 控件上时**默认拒绝**把截图交给视觉模型（像素无法脱敏）。确认画面无敏感内容才传 true' },

      label: { type: 'string', description: '截图文件名标签（shot 用）' },
      describe: { type: 'boolean', description: 'shot 时顺带用视觉模型描述界面内容（视觉即返，一步拿到界面状态）' },
      snapshotId: { type: 'string', description: '副作用动作可选：绑定某次 read/state 返回的 snapshotId。若自那次读之后界面已被更新的权威读刷新（staleSnapshot）或客户端已重启（expiredSnapshot），本次动作被拒不执行；不传则不校验（零回归）' },
      count: { type: 'number', description: 'scroll 页数' },
      x: { type: 'number', description: 'clickat：客户区 X。⚠ 坐标点击**可能落到相邻控件**（登录页旁边就是「注册/忘记密码」），点前先把目标报给用户确认' },
      y: { type: 'number', description: 'clickat：客户区 Y（同样：坐标脆弱、可能点到邻近控件）' },
      delta: { type: 'number' },
      mods: { type: 'string', description: 'click/type 的修饰键（如 "ctrl" / "ctrl,shift" / "ctrl+alt" —— 逗号、加号、空格都当分隔符）。⚠ 本参数驱动按**字符串**处理：写数组虽然实测也能用（PowerShell 会拼成 "ctrl shift"），但两面对它的声明必须一致，所以这里规范成字符串' },
      // R42：以下 7 个参数**驱动层早就实现了**（ui-drive-batch.ps1 / driver.mjs 里逐个有实现点），
      // 却只在 MCP 面声明过 —— 也就是说 DSH 侧的 agent 按名字选 ui_drive 时这些能力根本调不到。
      winHandle: { type: 'number', description: '按顶层窗口 handle 定位（ui_windows 返回的 handle 直接用），比 winTitle 更稳；不给就用主窗口' },
      focus: { type: 'boolean', description: 'true = 动作前把键盘焦点设到目标上（对「不响应无焦点点击」的控件有用）' },
      double: { type: 'boolean', description: 'true = clickat 用双击而不是单击' },
      button: { type: 'string', description: '坐标类动作的鼠标键（默认 left），如 left | right | middle' },
      expectValue: { type: 'string', description: 'type：写完回读校验的期望值（不一致 → ok:false）；selecttext：要选到的后缀' },
      observeMax: { type: 'number', description: 'observe=true 时动作后快照列几个控件（默认 15；只影响快照，不影响动作结果）' },
      shotsDir: { type: 'string', description: 'shot：截图副本目录（绝对路径）。证据目录里那份始终都会写' },
      diff: { type: 'boolean', description: 'read 专用：与上一次完整读做增量，返回 diff={added,removed,unchanged}（首读给 diffBaseline；读不完整时抑制并回落完整清单）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) }] },
    timeoutMs: 90000,
    async execute(args) {
      const r = await drv().drive(args)
      // shot 视觉即返：describe=true 时截图后直接返回界面描述
      if (r.ok && r.action === 'shot' && args.describe) {
        const sens = await drv().secretFocusNow({ procId: args.procId || 0 })
        if (args.allowSensitive !== true && (sens.secret === true || sens.unknown === true)) {
          r.describeSkipped = sens.unknown ? 'sensitivity-unknown' : 'secretFocused'
          r.warning = '没有把截图交给视觉模型：' + (sens.unknown ? ('查不到当前焦点（' + sens.reason + '），按 fail-closed 拒') : ('焦点在密码/验证码/token 类控件上（' + (sens.focused || '未知控件') + '）')) +
            '。截图已落盘：' + (r.workspacePath || r.path) + '；确认画面无敏感内容后传 allowSensitive=true 解锁。'
        } else {
          const v = await vsn().describeImage(r.workspacePath || r.path, UI_STATE_PROMPT)
          if (v.ok) r.description = v.text
          else r.visionError = v.error
        }
      }
      return r
    },
  }),
  defineTool({
    name: 'ui_windows',
    description: dshDescription('ui_windows'),
    parameters: dshParameters('ui_windows'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: {
      schema: OBJECT,
      render: (_a, v) => {
        if (!v.ok) return [{ type: 'text', text: '失败：' + (v.error || '') }]
        const nested = Array.isArray(v.nestedWindows) ? v.nestedWindows : []
        const tail = nested.length
          ? '\n⚠ 另有 ' + (v.nestedWindowsTotal || nested.length) + ' 个**嵌套窗口元素**（在主窗口视觉树里，会遮住下面的控件）：\n' +
            nested.map((l) => '  ' + l).join('\n') +
            '\n（判断"现在该操作哪个界面"看这里；再看 ui_observe(state) 的焦点确认。）'
          : ''
        // 截断/跳过与其它读路径共用同一套说法（completenessTail）
        const comp = (v.truncated === true || typeof v.skipped === 'number')
          ? '\n' + [v.truncated === true ? '⚠ 嵌套窗口清单已截断（只列了前 ' + (v.maxApplied || '?') + ' 个）' : '',
            typeof v.skipped === 'number' ? 'skipped=' + v.skipped + (v.skipped > 0 ? '（读不到状态的元素，清单不完整）' : '（清单完整）') : ''].filter(Boolean).join('\n')
          : ''
        return [{ type: 'text', text: v.count + ' 个窗口：\n' + (v.lines || []).join('\n') + tail + comp }]
      },
    },
    timeoutMs: 60000,
    async execute(args) {
      return await drv().drive({ action: 'windows', ...(args && args.procId ? { procId: args.procId } : {}) })
    },
  }),
  defineTool({
    name: 'ui_state',
    description: dshDescription('ui_state'),
    parameters: dshParameters('ui_state'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderState(v) }] },
    timeoutMs: 60000,
    async execute(args) {
      // 原来硬编码 action:'state' 且不传 procId —— 加了参数就必须真的传下去，否则等于没有（"参数存在但不生效"是最坏的一种）
      return await drv().drive({ action: 'state', match: args.match || '', max: args.max || 40, ...(args.procId ? { procId: args.procId } : {}), ...(args.winHandle ? { winHandle: args.winHandle } : {}) })
    },
  }),
  defineTool({
    name: 'ui_observe',
    description: dshDescription('ui_observe'),
    isConcurrencySafe: () => true, // P1-1c 只读（action 枚举均为只读观测；真源 lib/tool-registry READ_ONLY）
    parameters: {
      action: { type: 'string', required: true, enum: ['find', 'read', 'state', 'windows', 'waitfor', 'expectwindow', 'expecttext', 'waitany', 'shot', 'move', 'wheel', 'capture', 'state-live'], description: 'find | read | state | windows | waitfor | expectwindow | expecttext | waitany | shot | move | wheel | capture | state-live（move/wheel=移动鼠标/滚轮、capture=抓帧、state-live=免前台状态采样，都是只读白名单）' },
      name: { type: 'string', description: '控件 Name' },
      aid: { type: 'string', description: '控件 AutomationId' },
      // G1 黑盒 #1 抓到的残留：这句原本写"find/click 用 match 时按名字挑"——
      // 而 **ui_observe 的 action 枚举里根本没有 click**（点击在 ui_act / ui_drive / ui_flow 上）。
      // 描述里点名一个本面不存在的动作，会让人以为这里能点。
      match: { type: 'string', description: 'read/state 的控件名正则；find 用 match 时按名字挑（配合 index）。点击不在这里 —— 点击请用 ui_act / ui_drive / ui_flow' },
      textRe: { type: 'string', description: 'expecttext / waitany(text)：文本正则（抓 ErrorInfo 之类）' },
      titleRe: { type: 'string', description: 'expectwindow / waitany(window)：窗口标题正则' },
      gone: { type: 'boolean', description: 'expectwindow：true = 等窗口消失' },
      ms: { type: 'number', description: '等待上限毫秒（默认 5000；waitany 默认 15000）' },
      interval: { type: 'number', description: '轮询间隔毫秒（默认 150）' },
      state: { type: 'string', description: 'waitfor 条件：appear(默认) | gone | enabled | disabled' },
      waitFor: { type: 'object', additionalProperties: true, description: '{ms?, interval?, state?, match?, index?}。目标取「动作自身的 name/aid」→「waitFor 里的 name/aid」→「只给 match（整树正则）」三者之一；三者全空会明确报「缺少目标」。read/state/state-live 也支持（等界面刷出来再读）。**match-only 更贵**（每轮整树枚举，实测约 3× 于 aid/name，ms 上限 15000）——循环等待请给 aid/name。' },
      conds: { type: 'array', description: 'waitany 条件数组：[{kind:"window"|"text"|"appear"|"gone"|"enabled"|"disabled", titleRe?, textRe?, name?, aid?, label?}]' },
      index: { type: 'number', description: '同名控件序号（0 起；read 输出的 #序号 可直接用）' },
      inAid: { type: 'string', description: '限定在容器 AutomationId 子树内查找/读取（read/state 也生效；容器名写错会明确失败，不会退化成读整窗）' },
      inName: { type: 'string', description: '限定在容器 Name 子树内查找/读取（read/state 也生效）' },
      winTitle: { type: 'string', description: '限定在标题匹配的窗口内查找/读取（跨窗口定位；read/state 也生效）' },
      max: { type: 'number', description: 'state 最多返回控件数（默认 40）' },
      stableCount: { type: 'number', description: 'waitany：连续命中几次才算成立（默认 2）—— 用来躲开「一闪而过」的中间态' },
      label: { type: 'string', description: 'shot 文件名标签' },
      procId: { type: 'number', description: '指定进程 PID（默认自动找）' },
      winHandle: { type: 'number', description: '按顶层窗口 handle 定位（ui_windows 返回的 handle 直接用），比 winTitle 稳' },
      allowSensitive: { type: 'boolean', description: 'describe=true 时：焦点在密码/验证码/token 控件上默认拒（像素无法脱敏），确认无敏感内容才传 true' },

      describe: { type: 'boolean', description: 'shot：顺带返回视觉描述' },
      diff: { type: 'boolean', description: 'read 专用：与上一次完整读做增量，返回 diff={added,removed,unchanged}（首读给 diffBaseline；读不完整时抑制并回落完整清单）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) }] },
    timeoutMs: 120000,
    async execute(args) {
      const r = await drv().drive({ ...args, action: args.action })
      if (r.ok && r.action === 'shot' && args.describe) {
        const sens = await drv().secretFocusNow({ procId: args.procId || 0 })
        if (args.allowSensitive !== true && (sens.secret === true || sens.unknown === true)) {
          r.describeSkipped = sens.unknown ? 'sensitivity-unknown' : 'secretFocused'
          r.warning = '没有把截图交给视觉模型：' + (sens.unknown ? ('查不到当前焦点（' + sens.reason + '），按 fail-closed 拒') : ('焦点在密码/验证码/token 类控件上（' + String(sens.focused || '未知控件') + '）')) +
            '。截图已落盘：' + (r.workspacePath || r.path) + '；确认画面无敏感内容后传 allowSensitive=true 解锁。'
        } else {
          const v = await vsn().describeImage(r.workspacePath || r.path, UI_STATE_PROMPT)
          if (v.ok) r.description = v.text
          else r.visionError = v.error
        }
      }
      return r
    },
  }),
  defineTool({
    name: 'ui_act',
    description: dshDescription('ui_act'),
    parameters: {
      action: { type: 'string', required: true, enum: ['click', 'setvalue', 'key', 'type', 'drag', 'clickat', 'doubleclick', 'pattern', 'scroll', 'selecttext', 'move', 'wheel'], description: 'click | setvalue | key | type | drag | clickat | doubleclick | pattern | scroll | selecttext | move | wheel（clickat=按窗口客户区坐标点击，用于 UIA 拿不到稳定元素的表格行/图表点位，坐标脆弱；doubleclick=元素级双击；pattern=调用元素真正暴露的 UIA pattern，动作名放 value/keys（Expand/Collapse/Increment/Decrement/Select/ScrollIntoView/Toggle/Invoke/Focus/Minimize/Maximize/Restore 等）；scroll=语义滚动（方向 value、页数 count）；selecttext=精确选区（text=value、prefix=match、suffix=expectValue、selectionType=state）；drag/clickat/doubleclick/pattern/scroll/selecttext 都能致效，必须 allowSideEffects=true；move/wheel 只移动鼠标/滚轮，无需副作用授权）' },
      name: { type: 'string', description: '控件 Name' },
      aid: { type: 'string', description: '控件 AutomationId' },
      value: { type: 'string', description: 'setvalue/key/type 的内容；支持 ${cred:name} 占位符（凭据不经过模型）' },
      keys: { type: 'string', description: 'type 的按键序列（等价 value，语义更清楚）' },
      ascii: { type: 'boolean', description: 'key：ASCII 直发（逐字符 keybd_event）；type：把 {}^%~() 当普通字符' },
      match: { type: 'string', description: '按控件名正则挑目标（配合 index）' },
      index: { type: 'number', description: '同名控件序号（0 起）' },
      inAid: { type: 'string', description: '限定在容器内查找（AutomationId）' },
      // G1 黑盒 #1：ui_drive / ui_observe / ui_flow 都有 inName 而 ui_act 没有 —— 而**驱动层本来就支持**
      // （driver.drive 一路透传 inName）。孪生工具的参数集不一致，会让"按容器定位"这件事在这里突然不可用。
      inName: { type: 'string', description: '限定在容器内查找（按容器控件 Name，与 inAid 二选一或并用）' },
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
      // R42：同样是「驱动层有、DSH 面没声明」（batch 脚本里 count/mods/x/y 逐个有实现点）
      winHandle: { type: 'number', description: '按顶层窗口 handle 定位（ui_windows 返回的 handle 直接用），比 winTitle 稳' },
      count: { type: 'number', description: 'scroll：滚动几页/几行（默认 1）' },
      mods: { type: 'string', description: 'drag 时按住的修饰键，如 "shift" | "ctrl" | "alt"' },
      x: { type: 'number', description: 'clickat：客户区 X' },
      y: { type: 'number', description: 'clickat：客户区 Y' },
      observeMax: { type: 'number', description: 'observe=true 时快照列几个控件（默认 15）' },
      waitMs: { type: 'number', description: '动作后等待毫秒（默认 250）' },
      procId: { type: 'number', description: '指定进程 PID' },
      allowSideEffects: { type: 'boolean', description: '必须为 true 才执行（安全护栏）' },
      snapshotId: { type: 'string', description: '可选新鲜度门：绑定某次 read/state 返回的 snapshotId。自那次读后界面已被更新的权威读刷新（staleSnapshot）或客户端已重启（expiredSnapshot）→ 本次动作被拒不执行；不传则不校验（零回归）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderDrive(v) + (v.observe ? '\n动作后界面：窗口=' + (v.observe.window || '?') + ' 焦点=' + (v.observe.focused || '无') + '\n' + (v.observe.lines || []).join('\n') : '') }] },
    timeoutMs: 120000,
    async execute(args) {
      return await drv().drive(args)
    },
  }),
  defineTool({
    name: 'ui_tree',
    description: dshDescription('ui_tree'),
    parameters: dshParameters('ui_tree'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: {
      schema: OBJECT,
      /**
       * F-015（2026-09-11 三方可复现）：旧写法 `v.ok ? ('视觉树（' + (v.truncated ? '已截断' : '完整') + '）：\n' + v.text) : …`
       * 只要 `ok` 为真就写「完整」，**完全不看 `v.text` 是否为空**。实测（DSH 在 DSH 面、Claude 在 MCP 面各复现一次）
       * 得到的就是「视觉树（完整）：」后面一片空白 —— 于是：
       *   · 一个**什么都没读到的失败**被渲染成"读取成功且完整"；
       *   · agent 会据此得出「客户端里没有控件 / 界面是空的」这种根本性错误结论。
       * 现在：**有内容**才说完整/已截断；**空内容**必须明确说"没拿到任何节点"并给下一步与可能原因。
       * 注意这跟 `ui_observe read` 的 `skipped` 是同一类病：把「没读到」伪装成「没有」。
       */
      render: (_a, v) => {
        if (!v || v.ok !== true) {
          const err = (v && v.error) || '原因未回报'
          return [{ type: 'text', text: 'dump 失败：' + err +
            (v && v.hint ? '\n' + v.hint : '') +
            (/未配置|未指定|ProcName|窗口/i.test(String(err)) ? '\n（下一步：确认目标进程/窗口——ui_status 看进程，ui_windows 看窗口）' : '') +
            (/超时|timeout/i.test(String(err)) ? '\n（下一步：降低 maxDepth 重试；探针注入超时常见于客户端正忙或权限不足）' : '') }]
        }
        const text = typeof v.text === 'string' ? v.text : ''
        if (text.trim() === '') {
          return [{ type: 'text', text: '⚠ 探针**执行成功但没返回任何节点**（空视觉树）——这不等于"界面上没有控件"。\n' +
            '可能原因：① 探针注入到了错误的进程/窗口；② 客户端正在忙，探针还没遍历完就返回；③ 该窗口的确是空壳（少见）。\n' +
            '下一步：先用 ui_observe(state) 做 UIA 侧的交叉验证；若 UIA 能看到控件而这里看不到，问题在探针注入，不在界面。\n' +
            '（truncated=' + String(v.truncated) + '）' }]
        }
        // 2026-09-11 自查：`truncated` 过去只反映"正文超 14000 字符"，**深度切断与 4000 节点上限不可见** ——
        // 一份被 maxDepth 剪过的树同样被渲染成「视觉树（完整）」。现在把三个来源分开说清（数据层字段见 driver.tree）。
        const why = []
        if (v.depthLimited) why.push('深度被 maxDepth=' + v.maxDepthApplied + ' 切断（更深的节点没 dump；调大 maxDepth 重跑）')
        if (v.nodeCapHit) why.push('撞到节点数上限被截断（先 ui_observe(state) 缩小范围，再用 maxDepth 逐层下钻）')
        if (v.textCapped) why.push('正文超长被截断（只返回了前一部分）')
        const head = why.length
          ? '视觉树（⚠ **不完整**：' + why.join('；') + '）：'
          : (v.truncated ? '视觉树（已截断）：' : '视觉树（完整）：')
        // 来源必须印出来：UIA 降级拿不到 DataContext/模板细节，与注入探针不是同一份东西。
        const src = v.source === 'uia'
          ? '\n⚠ 来源=**UIA 层级树**（注入探针不可用）：只有 类型/Name/aid/enabled/offscreen/位置/层级，' +
            '**没有 DataContext 与 WPF 真实类型**。' + (v.injectorUnavailable && v.injectorUnavailable.error ? '\n  原因：' + String(v.injectorUnavailable.error).slice(0, 200) : '') +
            '\n  要 DataContext/模板级信息：配置 DSH_SNOOP_DIR 指向 Snoop 安装目录后重试。'
          : ''
        const metaLine = (typeof v.nodes === 'number')
          ? '\n（本次 dump：' + v.nodes + ' 个节点' + (typeof v.windows === 'number' ? '，' + v.windows + ' 个顶层窗口' : '') +
            (typeof v.maxDepthApplied === 'number' ? '，maxDepth=' + v.maxDepthApplied : '') + '）'
          : ''
        const warn = v.observationWarning ? '\n⚠ ' + v.observationWarning : ''
        // UIA 看不见内容的区域（CEF/自绘宿主）：必须印出来，否则调用方会把"UIA 没内容"读成"界面是空的"
        const opaque = Array.isArray(v.opaqueRegions) && v.opaqueRegions.length
          ? '\n' + (v.opaqueNote || ('⚠ 有 ' + v.opaqueRegionsTotal + ' 个 UIA 看不到内容的大区域：')) +
            '\n' + v.opaqueRegions.map((l) => '  ' + l).join('\n')
          : ''
        // 被跳过的元素：可能是整棵子树没进这份树，而 truncated 不反映这种丢失
        const skipNote = v.skippedNote ? '\n' + v.skippedNote : ''
        return [{ type: 'text', text: head + src + metaLine + warn + opaque + skipNote + '\n' + text }]
      },
    },
    timeoutMs: 180000,
    async execute(args) {
      return await drv().tree({ maxDepth: args.maxDepth || 8, inAid: args.inAid || '', inName: args.inName || '' })
    },
  }),
  defineTool({
    name: 'ui_flow',
    description: dshDescription('ui_flow'),
    parameters: {
      steps: { type: 'array', required: true, description: '步骤数组（每步一个对象，action 必填）' },
      tag: { type: 'string', description: '证据目录标签（如 verify-etf-dialog），默认 flow' },
      failFast: { type: 'boolean', description: '断言失败即停，默认 false' },
      allowSideEffects: { type: 'boolean', description: '含点击/输入/拖拽步骤时必须显式传 true' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderFlow(v) }] },
    timeoutMs: 600000,
    async execute(args) {
      const v = await drv().flow(args)
      // UD-03：动作步失败过去**不进**失败语料库（这里只认 v.failed，而它只统计断言步），
      // 于是"click 失败了"这类错误永远不会被记录、也永远不会被复盘。
      const stepFailures = typeof v.stepFailures === 'number' ? v.stepFailures : 0
      if (v.failed > 0 || stepFailures > 0) {
        autoRecord('verification-failure', 'ui_flow',
          'ui_flow failure: assertions=' + v.failed + ', actionSteps=' + stepFailures + ' / ' + v.totalSteps +
          ' steps (evidence: ' + (v.stepsJson || v.evidenceDir || '?') + ')',
          { context: { tag: args.tag || 'flow', stepFailureNames: v.stepFailureNames || [] } })
      }
      return v
    },
  }),
  defineTool({
    name: 'ui_live',
    description: dshDescription('ui_live'),
    parameters: dshParameters('ui_live'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderLive(v) }] },
    timeoutMs: 120000,
    async execute(args) {
      const ctl = liveCtl()
      const action = String(args.action || '').toLowerCase()
      if (action === 'start') return await ctl.start({ intervalMs: args.intervalMs, stateIntervalMs: args.stateIntervalMs, maxControls: args.maxControls })
      if (action === 'stop') return ctl.stop()
      if (action === 'status') return sanitizeLive(ctl.status(), args.allowSensitive === true)
      if (action === 'frame') {
        const s = await ctl.frame({ fresh: args.fresh === true })
        // 敏感帧默认拒出 path：像素无法脱敏（描述/agent 上下文里都不给）
        return sanitizeLive(s, args.allowSensitive === true)
      }
      if (action === 'wait') return await ctl.wait({ fromHash: args.fromHash, timeoutMs: args.timeoutMs })
      return { ok: false, error: '未知 action：' + action + '（start|stop|status|frame|wait）' }
    },
  }),
]

// renderDrive / renderState / sanitizeLive / framePathText / launchText / renderLive
// 已移到 lib/render.mjs：渲染与脱敏文本是 agent 唯一看得见、也是唯一能保护像素的契约，
// 必须能离线单测（index.js 依赖宿主 @deepseek-ai/dsh-tools，普通 node 进程 import 不到）。

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

        // GET /estop — 急停/策略状态（只读）。护栏原本对 agent **完全不可见**（Claude r15 复核）：
        // 描述里没有任何一处提到 DSH_UI_ESTOP_FILE / DSH_UI_APP_POLICY，拒绝发生时只看到"策略拒绝"。
        if (method === 'GET' && rest === '/estop') {
          writeJson(res, 200, drv().estopStatus())
          return
        }

        // POST /estop/reset — **运维路径**：显式复位急停锁存（只回环）。
        // 刻意**不做成 agent 工具**：让模型能自行解除自己的护栏，等于没有护栏。
        // 之前 `policy.reset()` 全仓无调用点 ⇒ 一旦急停锁存，除了重启宿主没有任何恢复手段。
        if (method === 'POST' && rest === '/estop/reset') {
          const sid = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || undefined
          writeJson(res, 200, drv().estopReset(sid))
          return
        }

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

        // ---- /live/* — agent 实时视图（回环；参数走 query，避免 body 解析）
        if (rest.startsWith('/live')) {
          const q = new URL(req.url, 'http://127.0.0.1').searchParams
          if (method === 'POST' && rest === '/live/start') {
            writeJson(res, 200, await liveCtl().start({ intervalMs: Number(q.get('intervalMs')), stateIntervalMs: Number(q.get('stateIntervalMs')), maxControls: Number(q.get('maxControls')) }))
            return
          }
          if (method === 'POST' && rest === '/live/stop') {
            writeJson(res, 200, liveCtl().stop())
            return
          }
          if (method === 'GET' && rest === '/live/status') {
            writeJson(res, 200, sanitizeLive(liveCtl().status(), q.get('allowSensitive') === '1'))
            return
          }
          if (method === 'GET' && rest === '/live/frame') {
            const s = await liveCtl().frame({ fresh: q.get('fresh') === '1' })
            writeJson(res, 200, sanitizeLive(s, q.get('allowSensitive') === '1'))
            return
          }
          if (method === 'GET' && rest === '/live/frame.png') {
            const s = sanitizeLive(await liveCtl().frame(), q.get('allowSensitive') === '1')
            // 敏感帧（焦点=密码/验证码）像素无法脱敏：与 /live/frame 同一边界——
            // 默认拒出，allowSensitive=1 才出图（否则该路由绕过工具层检查成为裸读径）
            if (s.frame && s.frame.sensitiveBlocked && !s.frame.path) {
              writeJson(res, 423, { error: 'sensitive frame: 焦点在密码/验证码控件，默认拒出（allowSensitive=1 才给）' })
              return
            }
            const p = s.frame && s.frame.path ? join(liveCtl().dir(), s.frame.path) : ''
            if (!p || !existsSync(p)) { writeJson(res, 404, { error: 'no frame yet' }); return }
            res.writeHead(200, { 'content-type': 'image/png', 'referrer-policy': 'no-referrer', 'x-frame-hash': s.frame.hash || '' })
            res.end(readFileSync(p))
            return
          }
          writeJson(res, 404, { error: 'unknown live route' })
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
        // 卸载时先停 live 循环（clearInterval，绝不留双 timer），再回收常驻 PowerShell
        // 进程——顺序固定：live 的 tick 用着 serve 通道，先停 live 再杀 serve。
        try { liveCtl().stop('plugin-unload') } catch { /* ignore */ }
        try { driver && driver.warmShutdown() } catch { /* ignore */ }
      }
    },
    'dsh-ui-drive: tools+routes',
  )
}
