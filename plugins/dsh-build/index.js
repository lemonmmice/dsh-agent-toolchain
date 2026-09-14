/**
 * dsh-build — DSH 插件（host 侧）：编译验证闭环。
 * 把 MSBuild 增量/全量构建做成 agent 工具：结构化解码错误 → AI 修复 → 再构建。
 * AI 的代码输出因此带上硬校验（改完必须编译，错误必须清零），
 * 配合 dsh-ui-drive 形成「改 → 编 → 驱动 → 看」的自验链路。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { renderBuild, renderErrors, renderStatus } from './lib/render.mjs'
import { makeBuilder } from './lib/builder.mjs'
import { checkCompileMembership, renderMembership } from '../../lib/compile-membership.mjs'
import { envOr } from '../../lib/env-fallback.mjs'

export const name = 'dsh-build'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 148
const API = '/api/dsh-build'

const GUIDANCE =
  '本机已安装 dsh-build 插件（DSH 的编译验证闭环）：把 MSBuild 构建做成 agent 工具，AI 改完代码后用 build_run 增量编译、解析错误、修复、再编译，形成硬校验闭环。' +
  '工具：build_run(target=Build|Rebuild, project?, configuration?, platform?, engine?, repoRoot?) 运行构建（默认增量 Build 快检；最终结论必须用 Rebuild；project 可定向单工程/.sln，相对仓库根；engine=dotnet 走 dotnet build），返回结构化错误列表（file/line/col/code/message）与日志路径；' +
  'build_status 查最近一次构建结果；build_errors 从最近日志重解析错误。' +
  '两个引擎都自动识别布局：仓库根存在 WholeSolution.sln 时沿用老默认（WholeSolution.sln + x86），否则自动探测 .sln/.slnx（根目录→一层子目录）并从解决方案文件读平台（Any CPU 优先）；歧义会报错并要求用 project 显式指定。dotnet 引擎在仓库完全没有解决方案时回退 cwd 默认。' +
  '硬约束（必须遵守）：改完代码必须 build_run 增量验证；错误未清零不得声称编译通过；只有 Rebuild 成功才能说 "Solution Rebuild passed"；增量 Build 通过只能说 targeted/incremental build passed。' +
  '已知坑：主工程是 legacy csproj，新增 .cs 必须手工加 <Compile Include>，否则构建通过但文件根本没编译——错误数 0 不代表新文件进了编译。' +
  '构建日志目录 ~/.dsh-agent-toolchain/build-logs（DSH_BUILD_LOGS_DIR 可覆盖），仓库根由 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT 指定，MSBuild 路径由 DSH_BUILD_MSBUILD 指定（找不到时自动探测常见安装）。' +
  '用户提到「编译验证 / 增量编译 / 帮我编译 / 构建闭环」时即指本插件，请据此协作。'

let builder = null
function bld() {
  if (!builder) {
    // 配置统一走 env-fallback（进程环境 → 用户级注册表 → 机器级）：DSH 宿主是长活进程，
    // 用户后来设置的用户级变量不在它的环境块里 —— 直接读 process.env 会把"用户已经配好"
    // 读成"没配置"，于是 build_run 报"找不到仓库根/msbuild 缺失"，而用户明明配了。
    // 注意 `''` 与 undefined 的语义差别由 envOr 统一处理（显式空串=主动清空，不回退注册表）。
    builder = makeBuilder({
      clientRoot: envOr('DSH_BUILD_CLIENT_ROOT'),
      repoRoot: envOr('DSH_BUILD_REPO_ROOT'),
      msbuild: envOr('DSH_BUILD_MSBUILD'),
      logsDir: envOr('DSH_BUILD_LOGS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'build-logs'),
    })
  }
  return builder
}

/**
 * System-recorded failure: build failures append to the failure corpus
 * automatically (the system observes, not the agent). The dynamic import is
 * guarded so a standalone-copied plugin degrades to a no-op instead of
 * breaking; inside the monorepo it records for real.
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

const OBJECT = { type: 'object', additionalProperties: true }

const tools = () => [
  defineTool({
    name: 'build_run',
    description: '运行 MSBuild 构建并结构化解析错误。默认增量 Build（快检，秒级~2分钟）；最终结论用 Rebuild（全量，5-10分钟）；project 可定向单工程/.sln（相对仓库根），**空=自动探测默认解决方案**（可能探测到**不含你改动**的那个 .sln，而"0 错误"照旧成立 ⇒ 请核对返回的目标与日志路径）。⚠ **错误数 0 ≠ 你新加的文件进了编译**（legacy .csproj 要手工 <Compile Include>，漏加时构建通过但文件根本没编）—— 要证这件事得自己验编译项或产物，本工具不替你证。返回错误列表（file/line/col/code/message）+ 日志路径。Triggers: 编译验证 / 增量编译 / 帮我编译 / 构建验证 / build.',
    parameters: {
      target: { type: 'string', enum: ['Build', 'Rebuild'], description: 'Build（增量，默认）或 Rebuild（全量）' },
      project: { type: 'string', description: '可选：定向工程/.sln（相对仓库根）；空=自动探测默认解决方案（WholeSolution.sln 优先）' },
      configuration: { type: 'string', description: '默认 Debug' },
      platform: { type: 'string', description: '可选：默认按布局自动解析（老布局 x86 / 从 .sln 探测，Any CPU 优先）' },
      engine: { type: 'string', enum: ['msbuild', 'dotnet'], description: '可选：msbuild（默认，VS MSBuild）或 dotnet（dotnet build，现代 SDK 仓库推荐）' },
      repoRoot: { type: 'string', description: '可选：仓库根目录（默认 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT）' },
      // R42：MCP 面一直有 clientRoot，DSH 面没有（同一个调用在一面能指定、在另一面只能退化成环境变量）。
      clientRoot: { type: 'string', description: '可选：客户端/解决方案根目录（等价于 repoRoot，优先于环境变量 DSH_BUILD_CLIENT_ROOT）' },
      killClient: { type: 'boolean', description: '客户端在运行时强制结束它再构建（会打断用户界面，需先确认）。⚠ **与 ui_launch(force=true) 同样会销毁唯一现场**：客户端卡死/卡顿要先取证（perf_dump 抓快照、hang_run 挂监测），证据到手再杀；否则 dump/线程栈/证据包都没了' },
      runId: { type: 'string', description: '可选：本次任务的 runId。传了才会写 run-<runId>.json 凭证记录（verify_report 的 build 类 claim 正是读这个文件；不传则只写 last.json，多 agent 并发时会互相覆盖）。建议用 who-task-n 形式，如 dsh-logon-fix-1' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderBuild(v) }] },
    timeoutMs: 16 * 60 * 1000,
    async execute(args) {
      const r = await bld().build(args)
      if (r.codeErrorCount > 0) {
        const first = (r.errors && r.errors[0]) || {}
        autoRecord('verification-failure', 'build_run', 'build failed with ' + r.codeErrorCount + ' code error(s); first: ' + (first.code || '') + ' ' + String(first.message || '').slice(0, 160), { context: { target: r.target || 'Build' } })
      }
      return r
    },
  }),
  defineTool({
    name: 'build_status',
    description: '查最近一次构建结果（目标/耗时/错误数/日志路径）。Triggers: 上次编译结果 / build status.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderStatus(v) }] },
    async execute() {
      return bld().status()
    },
  }),
  defineTool({
    name: 'build_errors',
    description: '从**最近一次**构建日志重新解析错误/警告列表（结构化 file/line/col/code/message）。⚠ 它读的是"最近一次日志"、**不保证是本次 run**（多 agent 并发时会读到别人的）：空 ≠ 没有错误，先看返回值里的日志路径/时间是不是你要的那次；要绑定本次请用 build_run 的 runId + verify_report(kind="build")。Triggers: 解析编译错误 / 查看编译错误.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderErrors(v) }] },
    async execute() {
      return bld().errorsOfLast()
    },
  }),
  defineTool({
    name: 'build_compile_check',
    description:
      '核对**一个源码文件到底进没进编译**（只读）—— 回答"编译 0 错误"答不出的那个问题。' +
      '⚠ 本仓已知陷阱：**legacy .csproj 不会自动包含 .cs**，新增文件漏写 `<Compile Include>` 时' +
      '**构建通过、文件根本没编**；而 `verify_report(kind="file")` 只验"文件存在"，会给**假 pass**（G1 黑盒 agent 原话）。' +
      '本工具按工程风格判定：legacy ⇒ 必须有显式编译项（含通配符）；SDK ⇒ 默认 glob 包含，除非显式关掉 `EnableDefaultCompileItems`；' +
      '`<Compile Remove>` 优先于 Include。**三态**：能证明"在"才说在、能证明"不在"才说不在、**读不到（文件/工程不存在、同层多工程、解析不了）一律 ok:false + 原因**，绝不说成"不在"。' +
      '不数 = 不求值 MSBuild `Condition`，条数会如实带出。Triggers: 新文件进没进编译 / 文件被编译了吗 / Compile Include / compiled?.',
    parameters: {
      file: { type: 'string', required: true, description: '源码文件路径（绝对路径，或相对 repoRoot/当前工作目录）。' },
      project: { type: 'string', description: '可选：显式指定工程文件（*.csproj）。不给就从这个文件往上找；找到多个会**返回歧义**而不是随便挑一个。' },
      repoRoot: { type: 'string', description: '可选：向上查找工程的边界（默认 DSH_BUILD_CLIENT_ROOT / DSH_BUILD_REPO_ROOT / git 根）。' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderMembership(v) }] },
    async execute(args) {
      // ⚠ F-051：`makeBuilder()` 返回的是 `{ config: c, … }` —— **`config` 是对象，不是函数**。
      //   这里原来写的是 `bld().config().clientRoot` ⇒ 只要调用方**没显式传 repoRoot** 就必定抛
      //   `TypeError: bld(...).config is not a function`。也就是说这个工具的"默认推导"路径
      //   **从 r43 加进来的那天起就没工作过**，而它当时"通过"的只是注册与参数级的闸。
      const cfg = bld().config || {}
      const root = args.repoRoot || cfg.clientRoot || cfg.repoRoot || undefined
      return checkCompileMembership(args.file, { projectPath: args.project, repoRoot: root })
    },
  }),
]

// ---------------------------------------------------------------- Web 路由（仅回环）

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

function makeRoutes() {
  return [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        const method = req.method || 'GET'
        const rest = (req.url || '').split('?')[0].slice(API.length) || '/'

        if (method === 'GET' && rest === '/status') {
          writeJson(res, 200, bld().status())
          return
        }
        if (method === 'GET' && rest === '/errors') {
          writeJson(res, 200, bld().errorsOfLast())
          return
        }
        // GET /log/{file} — 构建日志原文（basename 白名单）
        const logMatch = rest.match(/^\/log\/([^/]+)$/)
        if (method === 'GET' && logMatch !== null) {
          const file = decodeURIComponent(logMatch[1])
          if (file.includes('..') || file.includes('\\') || file.includes('/')) { writeJson(res, 400, { error: 'bad name' }); return }
          const p = join(bld().logsDir(), file)
          if (!existsSync(p)) { writeJson(res, 404, { error: 'log not found' }); return }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'referrer-policy': 'no-referrer' })
          res.end(readFileSync(p))
          return
        }
        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

export function apply(ctx) {
  ctx.effect(
    () => {
      const disposers = []
      for (const tool of tools()) disposers.push(ctx.tools.register(tool))
      const routeDisposers = makeRoutes().map((route) => ctx.webServer.register(route))
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-build', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        for (const d of routeDisposers) d()
        disposeSection()
      }
    },
    'dsh-build: tools+routes',
  )
}
