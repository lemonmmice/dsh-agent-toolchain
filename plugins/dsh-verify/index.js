/**
 * dsh-verify — DSH 薄壳插件（verify 裁决面）。
 *
 * lib/verify/report.mjs 的 DSH shell：把「任务收尾总结」变成结构化 claims，
 * 交给机器裁决（build / api / file / manual），verdict 落盘，被证据反驳的
 * claim 自动记入失败样本库（agent-misjudge）。
 *
 * 设计原则：本插件零逻辑——全部裁决逻辑在 lib/verify/report.mjs（与 MCP
 * verify_report 同一个引擎）。动态 import 带守卫：插件被单独拷贝出 monorepo
 * 时降级为可读的错误提示，不炸插件加载。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在各 defineTool 的 name）。
import { dshParameters, dshDescription } from '../../lib/tool-registry.mjs'
// 渲染层放在**本插件内的零依赖模块**里（可被普通 node 测试 import）—— 见 lib/render-failure.mjs。
// 注意：这里必须是**静态** import（本插件目录内的文件永远在），不能走下面那个带守卫的动态 import
// （那个是给 `../../lib/verify/report.mjs` —— 共享库，插件被拷出 monorepo 时可能不存在）。
import { renderFailureQuery } from './lib/render-failure.mjs'

export const name = 'dsh-verify'

export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 154

const GUIDANCE =
  '本机已安装 dsh-verify 插件（DSH 的收尾裁决面，lib/verify 的薄壳）：verify_report(runId, task, claims) 把你的完成声明交给机器裁决——' +
  'claim 带 kind：build（读该 run 的 build 记录 run-<runId>.json）/ api（查 API 捕获库，支持 expect.min / all2xx）/ file（验证据文件存在）/ manual（显式人工判断，用于系统查不了的视觉判断与人工接管）。' +
  'verdict = pass / incomplete / fail；被证据反驳的 claim（fail）自动记入失败样本库，class=agent-misjudge——这是「抓到 agent 声称成功但证据打脸」的唯一数据来源。' +
  '工作流（必须遵守）：任务收尾总结不是自由文本——先把你声称完成的事写成 claims 清单（每条声明 + 证据引用），调 verify_report 拿到 verdict，再向用户汇报「总结 + verdict」。' +
  '收尾总结 = claims 清单 + verdict；跳过 verify_report 的收尾等于没有验证的声称。' +
  '配套的失败样本库读写：failure_query / failure_stats 看库里有什么、failure_record 手工记一条、failure_retract 撤回"记错了的记录"（追加式、原文保留）。' +
  '还有 toolchain_status：**环境/前置条件自检**（客户端在不在跑、源码根、dump 三件套、符号、管理员、证据目录各是什么状态）—— ' +
  '**拿不到 文件:行号 时先跑它**，别反复试错。' +
  '用户提到「收尾裁决 / 验证报告 / verify / 证据复核 / 失败样本库 / 环境自检」时即指本插件。'

const OBJECT = { type: 'object', additionalProperties: true }

/**
 * 失败类别taxonomy的**本地副本**。
 *
 * 为什么要抄一份：本插件是「薄壳 + 动态 import 守卫」的设计（被单独拷贝出 monorepo 时降级成
 * 可读的错误提示，而不是炸掉插件加载）。而 `parameters` 里的 `enum` 必须在**模块加载期**就绪，
 * 用不了动态 import ⇒ 只能抄。
 * **抄了就必须防漂移**：`lib/toolface-parity.test.mjs` 里有断言直接比对它与
 * `lib/failure-corpus.mjs` 导出的 `FAILURE_CLASSES`，不一致就红。（"抄一份"本身没错，错了没人查。）
 */
const FAILURE_CLASS_LIST = [
  'verification-failure',
  'agent-misjudge',
  'human-handoff',
  'tool-error',
  'flaky',
  'doc-gap',
  'design-flaw',
]

let verifyPromise
function loadVerify() {
  if (verifyPromise === undefined) {
    verifyPromise = import('../../lib/verify/report.mjs').catch(() => null)
  }
  return verifyPromise
}

/** 失败样本库（与 MCP 面同一个实现，见 mcp/server.mjs 的 failure_*）。 */
let corpusPromise
function loadCorpus() {
  if (corpusPromise === undefined) {
    corpusPromise = import('../../lib/failure-corpus.mjs').catch(() => null)
  }
  return corpusPromise
}

/** 统一：库不可用时给**可执行**的说明，而不是抛一个栈。 */
async function withCorpus(fn) {
  const mod = await loadCorpus()
  if (!mod || typeof mod.makeFailureCorpus !== 'function') {
    return { ok: false, error: '失败样本库不可用：插件被单独拷贝脱离了 monorepo（缺 lib/failure-corpus.mjs）' }
  }
  try {
    return fn(mod.makeFailureCorpus())
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

/**
 * 环境/前置条件自检 —— **实现在 `lib/toolchain-status.mjs`，两个面共用一份**。
 * （本插件只做壳：动态 import + 守卫。同一件事不许有第二份实现 —— 第 24 类缺陷的教训。）
 */
let statusPromise
function loadStatus() {
  if (statusPromise === undefined) {
    statusPromise = import('../../lib/toolchain-status.mjs').catch(() => null)
  }
  return statusPromise
}

const tools = () => [
  defineTool({
    name: 'verify_report',
    description: dshDescription('verify_report'),
    parameters: { ...dshParameters('verify_report'),
      claims: { type: 'array', required: true, description: '完成声明列表。' + "**kind → 字段（必填加粗）**：build → {**statement**, runId?}（读 run-<runId>.json；不写 runId 就读最近一次）；api → {**statement**, filter?, expect?}（查 **dsh-api-visualizer 的捕获库**——不是 dsh-postman 面板的 history，两个不同的库；filter 支持 q/method/host/status/runId...，expect 形如 {min:1, all2xx:true}）；file → {**statement**, path}（⚠ **只验文件存在**，会给假 pass）；compiled → {**statement**, path, project?, repoRoot?}（这个源码文件到底在不在工程编译集里）；gate → {**statement**, cmd, cwd?}（真跑一条命令，退出码 0 才算过）；git → {**statement**, ref?, gitConfig?}；manual → {**statement**, evidence?}（**自评**：verdict=pass 只说明这条 claim 按你给的 status 成立，**不代表事实被独立验证**）。**★ 起手先定一个 runId 并逐字复用**（build_run / api_capture_append / verify_report 三处必须完全一致，写错会被判 fail 并记进失败样本库）。**★ 所有 kind 的判定证据都会落盘**（报告 JSON），所以这里写的每条都会留下可复核的痕迹。" + '字段全集：{statement, kind?, runId?, path?, project?, repoRoot?, filter?, expect?, repo?, check?, ref?, gitConfig?, cmd?, cwd?, status?, evidence?}。**kind 语义**：build=读本次 run 的构建记录（run-<runId>.json）；api=查接口捕获库（filter+expect，自动绑 runId）；file=**只验文件存在**（⚠ 它证明不了「这个文件被编译」）；compiled=**验这个源码文件在不在工程的编译集里**（legacy .csproj 不会自动包含 .cs，漏写 <Compile Include> 时构建通过但文件没编 —— 这是唯一能拦住那种「假通过」的一类；读不到时判 unverified，绝不判 fail）；gate=跑一条真实命令看退出码（最强的一类，cmd+cwd）；git=仓库状态（check=clean 看工作树 / pushed 用 ls-remote 权威核对，配 ref/gitConfig）；manual=显式人工判断（默认）。' },
      context: { ...OBJECT, description: '运行上下文（repo/model/mode）' },
    },
    output: {
      schema: OBJECT,
      render: (_a, v) => [{
        type: 'text',
        text: v.verdict === 'unavailable'
          ? ('裁决不可用：' + (v.error || 'lib/verify 未加载'))
          : (`verdict=${v.verdict}（pass ${v.counts?.pass ?? 0} / fail ${v.counts?.fail ?? 0} / unverified ${v.counts?.unverified ?? 0}），报告 ${v.reportPath}` + (v.recorded > 0 ? `，${v.recorded} 条 claim 被证据反驳已记入失败样本库` : '')),
      }],
    },
    async execute(args) {
      const mod = await loadVerify()
      if (!mod) return { verdict: 'unavailable', error: 'lib/verify 不可用：插件被单独拷贝脱离了 monorepo' }
      try {
        return mod.makeVerificationReport(args)
      } catch (e) {
        return { verdict: 'unavailable', error: String(e.message ?? e) }
      }
    },
  }),

  // ------------------------------------------------------------------ 环境自检
  defineTool({
    name: 'toolchain_status',
    description: dshDescription('toolchain_status'),
    parameters: dshParameters('toolchain_status'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: (v && v.text) ? v.text : JSON.stringify(v) }] },
    async execute(args) {
      const mod = await loadStatus()
      if (!mod || typeof mod.buildToolchainStatus !== 'function') {
        return { error: '环境自检不可用：插件被单独拷贝脱离了 monorepo（缺 lib/toolchain-status.mjs）' }
      }
      try {
        const status = mod.buildToolchainStatus({ deep: args && args.deep === true })
        return { ...status, text: mod.renderToolchainStatus(status) }
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) }
      }
    },
  }),

  // ------------------------------------------------------------------ 失败样本库
  // F-003 / E4（2026-09-12 r35）：这四个工具原先**只有 MCP 面**有（mcp/server.mjs），
  //   DSH 面根本拿不到 —— 于是 DSH 侧的 agent **看不了、也撤不了**失败样本库。
  //   实测代价：上一轮我要撤回两条被工具诬告的记录时，**没有工具可用**，只能临时写脚本调
  //   `lib/failure-corpus.mjs`。（两面工具集一致是清单里的 **P0（E4）**，而 F-003 第一天就
  //   "已确证"、却一直没被修 —— 因为**没有任何 gate 在查它**。本轮补工具 + 补 parity gate。）
  defineTool({
    name: 'failure_query',
    description: dshDescription('failure_query'),
    parameters: dshParameters('failure_query'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => renderFailureQuery(v) },
    async execute(args) {
      return withCorpus((c) => c.query(args))
    },
  }),

  defineTool({
    name: 'failure_stats',
    description: dshDescription('failure_stats'),
    parameters: dshParameters('failure_stats'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: '失败样本库：活动分片 ' + (v.total ?? '?') + ' 条（全部分片 ' + (v.totalAllShards ?? '?') + '，已撤回 ' + (v.retracted ?? 0) + '）' }] },
    async execute() {
      return withCorpus((c) => c.stats())
    },
  }),

  defineTool({
    name: 'failure_record',
    description: dshDescription('failure_record'),
    parameters: { ...dshParameters('failure_record'),
      context: { ...OBJECT, description: '运行上下文（runtime / tool / model / repo）' },
      tags: { type: 'array', description: '自由标签，便于以后挖掘' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v && v.id ? ('已记入失败样本库：' + v.id) : ('记录失败：' + ((v && v.error) || '未知错误')) }] },
    async execute(args) {
      return withCorpus((c) => c.record(args))
    },
  }),

  defineTool({
    name: 'failure_retract',
    description: dshDescription('failure_retract'),
    parameters: dshParameters('failure_retract'),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v && v.ok ? ('已撤回 ' + v.retracts) : ('撤回失败：' + ((v && v.error) || '未知错误')) }] },
    async execute(args) {
      return withCorpus((c) => c.retract(args))
    },
  }),
]

export function apply(ctx) {
  const disposers = []
  ctx.effect(
    () => {
      for (const tool of tools()) disposers.push(ctx.tools.register(tool))
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-verify', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        disposeSection()
      }
    },
    'dsh-verify: tools',
  )
}
