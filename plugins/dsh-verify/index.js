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
    description:
      '把任务收尾的完成声明交给机器裁决：claims 每条 {statement, kind}，kind=build 读 build 记录、kind=api 查 API 捕获库、kind=file 验证据文件存在、kind=gate 跑一条命令（退出码 0 才算过）、kind=manual 显式人工判断。' +
      '**api claim 会自动绑到本次 runId**（BV-01：不允许别的 run 的流量冒充本次证据）—— 所以 `filter` 里不写 runId 时它仍只找本 run 的记录；' +
      '要声明"本次确实跑过接口"，先用 `api_capture_append({runId})` 落一条带该 runId 的记录，否则会（正确地）判 fail 并提示"库里有多少条"。' +
      // ★ F-040（2026-09-12 r35，**由 G1 黑盒测试抓出**）：这里原先写的是 `capture_append({runId})` ——
      //   那是 **MCP 面**的名字，**DSH 面根本没有这个工具**（DSH 面叫 `api_capture_append`）。
      //   于是这条描述会让 agent 去调一个**不存在的工具**（"unknown tool: capture_append"）。
      //   黑盒测试的原话：「`verify_report` 正文写 `capture_append({runId})` 而工具实际叫 `api_capture_append`，
      //   我会去找不存在的工具。」——**描述里的工具名也是断言**，写错就是把人指去空处。
      '（MCP 面上这个工具叫 `capture_append`；本面叫 `api_capture_append` —— 两面名字不同，本描述已按**本面**写。）' +
      '只读/看现状的声明用 kind=gate 更硬（真跑命令），想不出命令再用 manual 并给证据。' +
      '返回 verdict（pass/incomplete/fail）+ 报告路径；被证据反驳的 claim 自动记入失败样本库（agent-misjudge）。' +
      'Triggers: 收尾裁决 / 验证报告 / verify / 证据复核.',
    parameters: {
      runId: { type: 'string', required: true, description: '本次任务唯一 id（如 task-2-toolchain-1）' },
      task: { type: 'string', required: true, description: '一行任务名' },
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
    description:
      '**先跑这个**：一次问清「现在到底能不能拿到代码级证据」，以及每个前置条件缺什么、下一步怎么补。' +
      '检查项：目标客户端是否在跑（pid）/ 源码根（`DSH_HANG_SRC_ROOT`、`DSH_PERF_SRC_ROOT` —— 决定能不能给到 `文件:行号`）/ ' +
      'dump 三件套（procdump + DumpStack + DAC —— 决定"卡死能不能拿到线程栈"）/ 符号路径 / **管理员权限**（ETW 采样前提）/ 证据目录。' +
      '每个值都带**来源**（进程环境 / 用户级注册表 / 未配置）—— 所以"配了但没继承"与"没配过"是**两句话**，不会混为一谈；' +
      '检查不到的项会**明说检查不到**，不假装通过。' +
      '⚠ 典型用途：`hang_analyze` 只给了方法名、给不出行号时，先跑它看是不是源码根没配 —— **不要靠反复试错去猜**。' +
      'Triggers: 环境自检 / 前置条件 / 为什么拿不到行号 / doctor / toolchain status.',
    parameters: {
      deep: { type: 'boolean', description: 'true = 多做一点重活（数源码根里的 .cs、数证据目录条目数）。默认 false 只查存在性，秒回' },
    },
    // ⚠ 渲染放在 `execute()` 里做（而不是在这里再写一个 renderer）：
    //   `output.render` 是**同步**的，拿不到动态 import 的结果；而静态 import 会破坏本插件
    //   "被单独拷贝出 monorepo 时降级而不炸" 的设计。所以 `execute` 返回里自带 `text`，这里只负责打印。
    //   （这正是"同一件事不许有第二份实现"的落地：renderer 只有 lib 里那一份。）
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
    description:
      '查询本地**失败样本库**（JSONL，仅本机，从不上传）：按 q（task/description/resolution 子串）、failureClass、tag、时间范围过滤，返回最新在前。' +
      '**已被撤回的记录默认排除**（看返回里的 `retractedExcluded`）；要看它们并带撤回理由传 includeRetracted=true。**读全部历史分片**（活动 + 归档）。' +
      '返回的**记录正文会被渲染出来**（类别 / task / description / resolution）。' +
      'Triggers: 查失败样本库 / 之前记过什么失败 / failure query.',
    parameters: {
      q: { type: 'string', description: '子串匹配 task/description/resolution' },
      failureClass: { type: 'string', enum: FAILURE_CLASS_LIST, description: '按失败类别过滤' },
      tag: { type: 'string', description: '按标签过滤' },
      fromTs: { type: 'number', description: '最早 ts（epoch ms）' },
      toTs: { type: 'number', description: '最晚 ts（epoch ms）' },
      limit: { type: 'number', description: '最多返回条数，默认 50，上限 500' },
      offset: { type: 'number', description: '跳过最新的 N 条' },
      includeRetracted: { type: 'boolean', description: '把被撤回的记录也带出来（各带 retractedReason）。默认 false' },
    },
    output: { schema: OBJECT, render: (_a, v) => renderFailureQuery(v) },
    async execute(args) {
      return withCorpus((c) => c.query(args))
    },
  }),

  defineTool({
    name: 'failure_stats',
    description:
      '失败样本库统计：total / 近 7-30 天 / 按类别计数（**活动分片口径**，这是库的契约），另外给 totalAllShards / archivedRecords / filesScanned ——' +
      '这样"total 变小了"是可解释的（轮转归档），而不是看起来像数据丢了；还有 `retracted`，让被撤回的记录**可见**而不是被静默丢弃。' +
      '⚠ 要看"当前到底多少条"就用它 —— 别把条数写进文档（每轮都在变）。' +
      'Triggers: 失败样本库统计 / 库里多少条 / failure stats.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: '失败样本库：活动分片 ' + (v.total ?? '?') + ' 条（全部分片 ' + (v.totalAllShards ?? '?') + '，已撤回 ' + (v.retracted ?? 0) + '）' }] },
    async execute() {
      return withCorpus((c) => c.stats())
    },
  }),

  defineTool({
    name: 'failure_record',
    description:
      '往本地失败样本库里**手工记一条**（仅本机、不上传）。每当：任务失败、验证结论与声明不一致、某个工具失灵、或需要人来接手时都该记。**记事实，不记责任。**' +
      '多数情况下你不需要手工记 —— `verify_report` 判定为 fail 的 claim 会自动入库（class=agent-misjudge）；这个工具用于它覆盖不到的场景（如工具自身失灵）。' +
      'Triggers: 记一条失败 / 记录这次失败 / failure record.',
    parameters: {
      task: { type: 'string', required: true, description: '一行任务名' },
      failureClass: { type: 'string', required: true, enum: FAILURE_CLASS_LIST, description: '失败类别（固定 taxonomy）' },
      description: { type: 'string', required: true, description: '出了什么问题' },
      resolution: { type: 'string', description: '后来怎么解开的' },
      context: { ...OBJECT, description: '运行上下文（runtime / tool / model / repo）' },
      tags: { type: 'array', description: '自由标签，便于以后挖掘' },
      costMs: { type: 'number', description: '大约浪费了多少毫秒' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v && v.id ? ('已记入失败样本库：' + v.id) : ('记录失败：' + ((v && v.error) || '未知错误')) }] },
    async execute(args) {
      return withCorpus((c) => c.record(args))
    },
  }),

  defineTool({
    name: 'failure_retract',
    description:
      '把一条失败样本库记录标成**记错了**（追加式：原文仍在盘上、可审计；之后 query/stats 不再计入它）。' +
      '用在"事后证据表明这条失败本身就是误判"时（例如一个验证工具把**真话**判成了谎话）。**必须给理由** —— 没有理由的撤回不可审计。撤回一个不存在的 id 会被拒绝（并列出候选）。' +
      'Triggers: 撤回失败记录 / 这条记错了 / failure retract.',
    parameters: {
      id: { type: 'string', required: true, description: '要撤回的记录 id，如 fc-20260911-5729' },
      reason: { type: 'string', required: true, description: '为什么这条是错的。**必填** —— 没有理由的撤回不可审计' },
      by: { type: 'string', description: '谁撤回的（自由文本）' },
    },
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
