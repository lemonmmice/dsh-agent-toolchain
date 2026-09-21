import { defineTool } from '@deepseek-ai/dsh-tools'
import { createJevClient, parseJevArguments } from '../../lib/jev-client.mjs'
import { dshDescription, dshParameters } from '../../lib/tool-registry.mjs'
import { envOr } from '../../lib/env-fallback.mjs'

export const name = 'dsh-jev'
export const inject = ['tools', 'systemPrompt']
const SECTION_ORDER = 156
const OBJECT = { type: 'object', additionalProperties: true }

const GUIDANCE =
  '本机已安装 dsh-jev：可选调用 TypeSafe Jev 做只读、建议性的 Choice/Score/Noul 判断。' +
  'jev_decide 只返回类型化答案，不执行任何 UI、构建、删除、重启或本地工具。默认不联网；只有用户明确允许脱敏数据发送且传 allowRemoteData=true，同时配置 TYPESAFE_API_KEY 时才会请求远程 API。' +
  '优先把多个独立问题批量放入一次请求；超时失败开放，不自动重试。Jev 不能替代 UI 授权/快照、编译结果或证据裁决，中文和数字/日期场景必须按本地样本校准。'

let client
function jev() {
  if (!client) client = createJevClient({ apiKey: envOr('TYPESAFE_API_KEY') })
  return client
}

const tools = () => [
  defineTool({
    name: 'jev_decide',
    description: dshDescription('jev_decide'),
    parameters: dshParameters('jev_decide'),
    output: {
      schema: OBJECT,
      render: (_args, value) => [{ type: 'text', text: value.ok
        ? `Jev 建议（只读，未执行动作）：model=${value.model || '-'} latency=${value.latencyMs ?? '-'}ms\n${JSON.stringify(value.answers)}`
        : `Jev 未返回判断：${value.errorCode || 'unknown'} — ${value.error || 'unknown error'}` }],
    },
    async execute(args) {
      if (args.allowRemoteData !== true) return { ok: false, errorCode: 'remote_data_not_allowed', error: 'jev_decide 默认不联网；确认 state/questions 已脱敏后重发并带 allowRemoteData=true' }
      const parsed = parseJevArguments(args)
      if (!parsed.ok) return parsed
      const result = await jev().evaluate(parsed.request)
      return result.ok ? { ...result, advisoryOnly: true, executedActions: 0, remote: true } : result
    },
  }),
]

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = tools().map(tool => ctx.tools.register(tool))
    const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-jev', order: SECTION_ORDER, text: GUIDANCE })
    return () => {
      for (const dispose of disposers) dispose()
      disposeSection()
    }
  }, 'dsh-jev: tools')
}
