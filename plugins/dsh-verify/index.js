/**
 * dsh-verify — DSH 薄壳插件（环境自检 + Harness² 试验面）。
 *
 * 历史名「dsh-verify」保留不改：收尾裁决（verify_report）与失败样本库（failure_*）
 * 已整体下线；为不打断 marketplace / 部署脚本对插件 id 的引用，插件 id 仍叫 dsh-verify。
 * 现在它只承载环境自检与 Harness² 两类工具：
 *   · toolchain_status / toolchain_job —— 环境/前置条件自检与异步作业控制；
 *   · harness_trial / harness_experience —— Harness² 试验与经验库。
 *
 * 设计原则：本插件零逻辑——实现都在共享 lib/（toolchain-status / harness/tools）。
 * 动态 import 带守卫：插件被单独拷贝出 monorepo 时降级为可读的错误提示，不炸插件加载。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
// W1：描述/参数结构收进单一真源 lib/tool-registry.mjs（名字仍字面量留在各 defineTool 的 name）。
import { dshParameters, dshDescription } from '../../lib/tool-registry.mjs'
import { taskControl, renderTaskJob, runTaskTool } from '../../lib/task-tool-support.mjs'
import { makeHarnessTools } from '../../lib/harness/tools.mjs'

export const name = 'dsh-verify'

export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 154

const GUIDANCE =
  '本机已安装 dsh-verify 插件（工具链环境自检 + Harness² 试验面）：' +
  'toolchain_status：**环境/前置条件自检**（客户端在不在跑、源码根、dump 三件套、符号、管理员、证据目录各是什么状态）—— ' +
  '**拿不到 文件:行号 时先跑它**，别反复试错。toolchain_job：异步作业控制（查询/取消长跑作业）。' +
  'harness_trial / harness_experience：Harness² 试验与经验库（自动复现—验证—沉淀）。' +
  '用户提到「环境自检 / Harness 试验 / 经验库」时即指本插件。'

const OBJECT = { type: 'object', additionalProperties: true }

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

const harnessTools = makeHarnessTools()

const tools = () => [
  // ------------------------------------------------------------------ 环境自检
  defineTool({
    name: 'toolchain_status',
    description: dshDescription('toolchain_status'),
    parameters: dshParameters('toolchain_status'),
    isConcurrencySafe: () => true, // P1-1c 只读（真源 lib/tool-registry READ_ONLY）
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: (v && v.text) ? v.text : JSON.stringify(v) }] },
    async execute(args) {
      const mod = await loadStatus()
      if (!mod || typeof mod.toolchainStatusAsync !== 'function') {
        return { error: '环境自检不可用：插件被单独拷贝脱离了 monorepo（缺 lib/toolchain-status.mjs）' }
      }
      try {
        const status = await mod.toolchainStatusAsync({ deep: args?.deep === true, fresh: args?.fresh === true })
        return { ...status, text: mod.renderToolchainStatus(status) }
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) }
      }
    },
  }),
  defineTool({
    name: 'toolchain_job',
    description: dshDescription('toolchain_job'),
    parameters: dshParameters('toolchain_job'),
    output: { schema: OBJECT, render: renderTaskJob },
    async execute(args) { return taskControl({ action: args.action, jobId: args.jobId }) },
  }),

  defineTool({
    name: 'harness_trial',
    description: dshDescription('harness_trial'),
    parameters: dshParameters('harness_trial'),
    output: { schema: OBJECT, render: (_a, v) => v?.taskJob ? renderTaskJob(_a, v) : [{ type: 'text', text: v?.state ? `Harness 试验 ${v.trialId || ''}：${v.state}` : JSON.stringify(v) }] },
    async execute(args) {
      const action = args.action
      const configPath = args.configPath
      const trialId = args.trialId
      const asyncJob = args.asyncJob
      const requestKey = args.requestKey
      const jobTimeoutMs = args.jobTimeoutMs
      return runTaskTool('harness_trial', { action, configPath, trialId, asyncJob, requestKey, jobTimeoutMs }, (parameters, extra) => harnessTools.trial(parameters, extra))
    },
  }),

  defineTool({
    name: 'harness_experience',
    description: dshDescription('harness_experience'),
    parameters: dshParameters('harness_experience'),
    isConcurrencySafe: (args) => !['validate', 'retire'].includes(args?.action),
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const action = args.action
      const scopeJson = args.scopeJson
      const versionsJson = args.versionsJson
      const statesJson = args.statesJson
      const id = args.id
      const supportTrialIdsJson = args.supportTrialIdsJson
      const reason = args.reason
      const limit = args.limit
      const exportPath = args.exportPath
      const includeProposed = args.includeProposed
      return harnessTools.experience({ action, scopeJson, versionsJson, statesJson, id, supportTrialIdsJson, reason, limit, exportPath, includeProposed })
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
