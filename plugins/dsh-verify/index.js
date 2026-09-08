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

export const name = 'dsh-verify'

export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 154

const GUIDANCE =
  '本机已安装 dsh-verify 插件（DSH 的收尾裁决面，lib/verify 的薄壳）：verify_report(runId, task, claims) 把你的完成声明交给机器裁决——' +
  'claim 带 kind：build（读该 run 的 build 记录 run-<runId>.json）/ api（查 API 捕获库，支持 expect.min / all2xx）/ file（验证据文件存在）/ manual（显式人工判断，用于系统查不了的视觉判断与人工接管）。' +
  'verdict = pass / incomplete / fail；被证据反驳的 claim（fail）自动记入失败样本库，class=agent-misjudge——这是「抓到 agent 声称成功但证据打脸」的唯一数据来源。' +
  '工作流（必须遵守）：任务收尾总结不是自由文本——先把你声称完成的事写成 claims 清单（每条声明 + 证据引用），调 verify_report 拿到 verdict，再向用户汇报「总结 + verdict」。' +
  '收尾总结 = claims 清单 + verdict；跳过 verify_report 的收尾等于没有验证的声称。' +
  '用户提到「收尾裁决 / 验证报告 / verify / 证据复核」时即指本插件。'

const OBJECT = { type: 'object', additionalProperties: true }

let verifyPromise
function loadVerify() {
  if (verifyPromise === undefined) {
    verifyPromise = import('../../lib/verify/report.mjs').catch(() => null)
  }
  return verifyPromise
}

const tools = () => [
  defineTool({
    name: 'verify_report',
    description:
      '把任务收尾的完成声明交给机器裁决：claims 每条 {statement, kind}，kind=build 读 build 记录、kind=api 查 API 捕获库、kind=file 验证据文件存在、kind=manual 显式人工判断。' +
      '返回 verdict（pass/incomplete/fail）+ 报告路径；被证据反驳的 claim 自动记入失败样本库（agent-misjudge）。' +
      'Triggers: 收尾裁决 / 验证报告 / verify / 证据复核.',
    parameters: {
      runId: { type: 'string', required: true, description: '本次任务唯一 id（如 task-2-toolchain-1）' },
      task: { type: 'string', required: true, description: '一行任务名' },
      claims: { type: 'array', required: true, description: '完成声明列表：每条 {statement, kind?(build/api/file/git/gate/manual，默认 manual), runId?, path?, filter?, expect?, repo?, check?, ref?, gitConfig?, cmd?, cwd?, status?, evidence?}' },
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
