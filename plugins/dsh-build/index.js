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
// W1：工具名/描述/参数结构收进单一真源（lib/tool-registry.mjs）—— 名字仍以字面量出现在下面
// 各 defineTool 的 name 字段（守卫要求名字是字面量），描述与参数由注册表生成，两面不再各写一份。
import { dshParameters, dshDescription } from '../../lib/tool-registry.mjs'

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
    description: dshDescription('build_run'),
    parameters: dshParameters('build_run'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderBuild(v) }] },
    timeoutMs: 16 * 60 * 1000,
    async execute(args) {
      // W4：后台构建立即返回 jobId，不阻塞（构建逻辑不变，只是换到分离子进程里跑）。
      if (args.background === true) return bld().startBackground(args)
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
    description: dshDescription('build_status'),
    parameters: dshParameters('build_status'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderStatus(v) }] },
    async execute() {
      return bld().status()
    },
  }),
  defineTool({
    name: 'build_errors',
    description: dshDescription('build_errors'),
    parameters: dshParameters('build_errors'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderErrors(v) }] },
    async execute() {
      return bld().errorsOfLast()
    },
  }),
  defineTool({
    name: 'build_compile_check',
    description: dshDescription('build_compile_check'),
    parameters: dshParameters('build_compile_check'),
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
