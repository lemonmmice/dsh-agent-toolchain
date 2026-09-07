/**
 * dsh-memory — DSH 插件（host 侧）
 * 给 AI 编程助手长期记忆：文档索引 + 语义检索 + 跨会话 KV 记忆。
 * 只注册 agent 工具与 systemPrompt 公告，不挂 Web 路由（面板后续版本）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DshMemory } from './lib/memory.mjs'

export const name = 'dsh-memory'

export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 152

const GUIDANCE =
  '本机已安装 dsh-memory 插件（DSH 的长期记忆增强）：' +
  '工具 memory_index(path) 把指定目录的文档/代码索引进本地向量库（增量、跳过 bin/obj/node_modules）；' +
  'memory_search(query, k) 做语义检索（MiniMax embo-01 向量；未配置 key 时自动降级为本地 bigram 关键词检索）；' +
  'memory_save / memory_recall / memory_forget 管理跨会话 KV 记忆（按 scope 隔离，如项目名）；memory_status 查看索引状态。' +
  '数据全部存储在本地 ~/.dsh/memory/，不外传。' +
  '用户提到「记住这个约定 / 查一下项目里怎么做的 / 帮我记住」等需要跨会话记忆的场景时，优先使用这些工具。'

let memory = null
function mem() {
  if (!memory) memory = new DshMemory({})
  return memory
}

const tools = () => [
  defineTool({
    name: 'memory_index',
    description:
      '把本地目录索引进长期记忆向量库（增量：按文件 mtime 跳过未变更文件）。之后可用 memory_search 语义检索。' +
      'Triggers: 记住这个项目 / 索引代码库 / index the repo.',
    parameters: {
      path: { type: 'string', required: true, description: '要索引的目录绝对路径' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          files: { type: 'integer' }, chunks: { type: 'integer' }, embed: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `索引完成：${value.files} 个文件 / ${value.chunks} 个分块（${value.embed}）` }],
    },
    async execute(args) {
      const r = await mem().indexWorkspace(args.path)
      return { ...r, embed: mem().embed.label }
    },
  }),
  defineTool({
    name: 'memory_search',
    description:
      '语义检索长期记忆（索引过的文档/代码内容）。返回最相关片段及来源文件。' +
      'Triggers: 项目里怎么做的 / 检索记忆 / 查一下之前 / search memory.',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题或关键词' },
      k: { type: 'number', description: '返回条数，默认 5，最大 10' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          hits: { type: 'array' }, embed: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `找到 ${value.hits?.length ?? 0} 条相关记忆（${value.embed}）` }],
    },
    async execute(args) {
      const k = Math.min(Math.max(Math.round(args.k || 5), 1), 10)
      const hits = await mem().search(args.query, k)
      return {
        embed: mem().embed.label,
        hits: hits.map(h => ({ file: h.meta.file, chunk: h.meta.chunkIndex, score: +h.score.toFixed(3), text: String(h.meta.text).slice(0, 400) })),
      }
    },
  }),
  defineTool({
    name: 'memory_save',
    description: '保存一条跨会话 KV 记忆（如项目约定、用户偏好、历史决策）。同一 key+scope 会覆盖。Triggers: 记住这个约定 / save memory.',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键名，如 "项目约定" 或 "用户偏好"' },
      value: { type: 'string', required: true, description: '记忆内容' },
      scope: { type: 'string', description: '作用域（如项目名），默认 global' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { saved: { type: 'boolean' }, key: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `已记住：${value.key}` }] },
    async execute(args) {
      mem().remember(args.key, args.value, args.scope || 'global')
      return { saved: true, key: args.key }
    },
  }),
  defineTool({
    name: 'memory_recall',
    description: '读取一条 KV 记忆（跨会话）。Triggers: 之前说过的约定 / recall memory.',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键名' },
      scope: { type: 'string', description: '作用域，默认 global' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { found: { type: 'boolean' }, key: { type: 'string' }, value: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.found ? (`${value.key} = ${value.value}`) : (`没有找到记忆：${value.key}`) }] },
    async execute(args) {
      const r = mem().recall(args.key, args.scope || 'global')
      return r ? { found: true, key: r.key, value: r.value } : { found: false, key: args.key }
    },
  }),
  defineTool({
    name: 'memory_forget',
    description: '删除一条 KV 记忆。Triggers: 忘掉之前的约定 / forget memory.',
    parameters: {
      key: { type: 'string', required: true, description: '记忆键名' },
      scope: { type: 'string', description: '作用域，默认 global' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { forgotten: { type: 'boolean' }, key: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `已忘记：${value.key}` }] },
    async execute(args) {
      mem().forget(args.key, args.scope || 'global')
      return { forgotten: true, key: args.key }
    },
  }),
  defineTool({
    name: 'memory_status',
    description: '查看长期记忆状态（索引分块数、KV 条数、embedding 后端）。Triggers: 记忆状态 / memory status.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: { chunks: { type: 'integer' }, kvEntries: { type: 'integer' }, embed: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: `记忆库：${value.chunks} 分块 / ${value.kvEntries} 条 KV（${value.embed}）` }] },
    async execute() {
      const s = mem().status()
      return { chunks: s.chunks, kvEntries: s.kvEntries, embed: s.embed }
    },
  }),
]

export function apply(ctx) {
  const disposers = []
  ctx.effect(
    () => {
      for (const tool of tools()) {
        disposers.push(ctx.tools.register(tool))
      }
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-memory', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        disposeSection()
      }
    },
    'dsh-memory: tools',
  )
}
