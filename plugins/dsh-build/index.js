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
import { makeBuilder } from './lib/builder.mjs'

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
    builder = makeBuilder({
      clientRoot: process.env.DSH_BUILD_CLIENT_ROOT || '',
      repoRoot: process.env.DSH_BUILD_REPO_ROOT || '',
      msbuild: process.env.DSH_BUILD_MSBUILD || '',
      logsDir: process.env.DSH_BUILD_LOGS_DIR || join(homedir(), '.dsh-agent-toolchain', 'build-logs'),
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
    description: '运行 MSBuild 构建并结构化解析错误。默认增量 Build（快检，秒级~2分钟）；最终结论用 Rebuild（全量，5-10分钟）；project 可定向单工程/.sln（相对仓库根），空=自动探测默认解决方案。返回错误列表（file/line/col/code/message）+ 日志路径。Triggers: 编译验证 / 增量编译 / 帮我编译 / 构建验证 / build.',
    parameters: {
      target: { type: 'string', description: 'Build（增量，默认）或 Rebuild（全量）' },
      project: { type: 'string', description: '可选：定向工程/.sln（相对仓库根）；空=自动探测默认解决方案（WholeSolution.sln 优先）' },
      configuration: { type: 'string', description: '默认 Debug' },
      platform: { type: 'string', description: '可选：默认按布局自动解析（老布局 x86 / 从 .sln 探测，Any CPU 优先）' },
      engine: { type: 'string', description: '可选：msbuild（默认，VS MSBuild）或 dotnet（dotnet build，现代 SDK 仓库推荐）' },
      repoRoot: { type: 'string', description: '可选：仓库根目录（默认 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT）' },
      killClient: { type: 'boolean', description: '客户端在运行时强制结束它再构建（会打断用户界面，需先确认）' },
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
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.hasRun ? ('最近构建：' + v.target + ' ' + (v.ok ? '通过' : '失败(' + v.errorCount + ' 错误)') + '，耗时 ' + (v.durationMs / 1000).toFixed(1) + 's，日志 ' + v.logPath) : '还没有构建记录' }] },
    async execute() {
      return bld().status()
    },
  }),
  defineTool({
    name: 'build_errors',
    description: '从最近一次构建日志重新解析错误/警告列表（结构化 file/line/col/code/message）。Triggers: 解析编译错误 / 查看编译错误.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.hasRun ? (v.errors.length + ' 错误 / ' + v.warnings.length + ' 警告（日志 ' + v.logPath + '）') : '没有构建记录' }] },
    async execute() {
      return bld().errorsOfLast()
    },
  }),
]

function renderBuild(v) {
  if (v.clientRunning && !v.killClient) return '客户端正在运行（PID ' + v.clientPid + '），输出文件被锁无法构建：' + v.error
  if (!v.ok && v.timedOut) return '构建超时（' + (v.durationMs / 1000).toFixed(0) + 's）：' + v.target
  if (v.spawnError) return '构建无法启动：' + v.spawnError
  const head = (v.target === 'Rebuild' ? 'Solution Rebuild' : 'Incremental/targeted build') + ' ' + (v.ok ? 'PASSED' : 'FAILED') + '（' + (v.durationMs / 1000).toFixed(1) + 's，' + v.errorCount + ' 错误 / ' + v.warningCount + ' 警告，日志 ' + v.logPath + '）'
  if (!v.ok && v.errors.length > 0) {
    return head + '\n关键错误：\n' + v.errors.slice(0, 10).map((e) => e.file + '(' + e.line + ',' + e.col + '): ' + e.code + ': ' + e.message).join('\n') + (v.truncated ? '\n…(错误已截断，用 build_errors 看全部)' : '')
  }
  if (!v.ok && v.envErrorCount > 0) {
    return head + '\n环境错误（文件锁，非代码错误）：' + v.envErrors.slice(0, 4).map((e) => e.code + ': ' + e.message.slice(0, 120)).join('\n')
  }
  return head
}

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
