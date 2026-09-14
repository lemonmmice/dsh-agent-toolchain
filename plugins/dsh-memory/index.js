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
  '工具 memory_index(path) 把指定目录的文档/代码索引进向量库（增量、跳过 bin/obj/node_modules）；' +
  'memory_search(query, k) 做语义检索（MiniMax embo-01 向量；未配置 key 时自动降级为本地 bigram 关键词检索）；' +
  'memory_save / memory_recall / memory_forget 管理跨会话 KV 记忆（按 scope 隔离，如项目名）；memory_status 查看索引状态。' +
  // BV-07（2026-09-11 审计确证）：这句话原来是"数据全部存储在本地 ~/.dsh/memory/，不外传" ——
  // **假的**：配置了 MiniMax key 时，memory_index 会把文件分块发到**远程** api.minimax.chat 做向量。
  // MCP 面的描述一直是对的（明写 indexed content leaves this machine），只有 DSH 面这句在撒谎 ——
  // 而它正是 agent 向用户做隐私承诺时唯一的依据。**存储**与**embedding**是两件事，不能一句"本地"糊过去。
  '数据（索引与 KV）存储在本地 ~/.dsh/memory/；但**embedding 走哪条路取决于配置**：' +
  '配置了 MiniMax key 时，memory_index 会把文件分块**发到远程 api.minimax.chat**（内容离开本机），未配置 key 时才降级为本地 bigram 检索（不出本机）。' +
  '**不要向用户承诺"数据不外传"——先调 memory_status 看 embedEndpoint/note 的真实取值再回答。**' +
  '卫生保证：索引按 mtime 增量（未变更文件跳过，文件更新自动淘汰旧分块，已删除文件的旧分块自动清理）；memory_save 会拒绝含 token/密钥等敏感字符串的内容（fail-closed）。' +
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
      // BV-07：隐私必须写在**模型真正会读的那份描述**里 —— GUIDANCE 只是系统提示的一段，
      // 而模型决定"要不要索引这个目录"时看的是这条。原来这条一个字都没提 egress。
      '隐私：数据落在本地 ~/.dsh/memory/，**但 embedding 可能出本机** —— 配置了 MiniMax key 时文件分块会发到远程 api.minimax.chat；未配置 key 时是本地 bigram、不出本机。' +
      '要确认走哪条路请调 memory_status 看 embedEndpoint/note；**不要向用户承诺"不外传"**。' +
      'Triggers: 记住这个项目 / 索引代码库 / index the repo.',
    parameters: {
      path: { type: 'string', required: true, description: '要索引的目录绝对路径' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          files: { type: 'integer' }, chunks: { type: 'integer' }, embed: { type: 'string' },
          embedEndpoint: { type: 'string' }, privacyNote: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // BV-07：远端 embedding 必须在默认视图里看得见 —— 否则 agent 会照着"索引完成"向用户做错误隐私承诺
        text: `索引完成：${value.files} 个文件 / ${value.chunks} 个分块（新增 ${value.indexed ?? '-'}，跳过 ${value.skipped ?? '-'}，清理 ${value.deleted ?? '-'}）` +
          (String(value.embedEndpoint || '').startsWith('remote')
            ? `\n⚠ **embedding 走的是远程 API**（${value.embedEndpoint}）：本次索引的文件内容已经离开本机，**不要向用户说"数据不外传"**。要改成纯本地请取消 MiniMax API key（会自动降级为本地 bigram 检索）。`
            : `\n（embedding：${value.embedEndpoint || 'local'} —— 内容未离开本机）`),
      }],
    },
    async execute(args) {
      const r = await mem().indexWorkspace(args.path)
      // BV-07：把"这次索引有没有把内容发出去"直接放进**这次调用的返回值**里 ——
      // 让 agent 不必先想到去查 memory_status 才知道文件分块是否离开了本机。
      const st = mem().status()
      return { ...r, embed: st.embed, embedEndpoint: st.embedEndpoint, privacyNote: st.note }
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
          // ⚠ 元素形状**必须声明**（2026-09-14 新加的 render 闸抓出来的）：
          //   `{ type: 'array' }` 在 JSON Schema 语义下**允许元素是任何东西（含 null）**，
          //   而下面这个 render 是**按元素是对象**写的（读 `h.file`）——
          //   于是"符合自己 schema 的值"能把它打崩：
          //     Cannot read properties of null (reading 'file')
          //   真实生产者（execute）永远给对象，所以这**不是线上已发生的崩溃**，
          //   而是**契约比实现宽**：哪天返回里混进一个 null，崩的就是渲染层，且没有任何一关会先红。
          //   声明成"对象"既写实、又让"合成值"这一关能把它验住。
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          embed: { type: 'string' },
        },
      },
      // ⚠ F-052：这里原来只打印「找到 N 条相关记忆（backend）」—— `execute` 明明返回了 hits
      //   （file/chunk/score/text），**渲染层却把它们整个丢掉**，于是 agent 看到的是
      //   「找到 3 条」后面**一个字都没有**。⇒ 记忆库的**读路径在 DSH 面等于坏的**：
      //   我能知道"有几条"，但拿不到任何一条的内容（MCP 面是 jtext 整个对象，所以只有这一面坏）。
      //   同族：F-049（渲染层没跟上分支）。这一族的判据都是同一条 —— **渲染层是 agent 唯一看得见的东西**。
      render: (_args, value) => {
        const hits = Array.isArray(value.hits) ? value.hits : []
        const head = '找到 ' + hits.length + ' 条相关记忆（' + (value.embed || '未知后端') + '）'
        if (!hits.length) {
          // 空结果必须说清"是没命中"还是"没索引/没命中该目录"，别只给一个 0
          return [{ type: 'text', text: head + '\n（没有命中片段。若你预期这里该有内容，先 memory_status 看索引里到底收了哪些目录。）' }]
        }
        const lines = hits.map((h, i) =>
          '\n[' + (i + 1) + '] ' + (h.file || '(未知文件)') + (h.chunk != null ? ' #' + h.chunk : '') +
          (h.score != null ? '  score=' + h.score : '') + '\n    ' +
          String(h.text || '').replace(/\s*\n\s*/g, ' ').slice(0, 300))
        const fnote = value.freshnessNote ? '\n\n⚠ ' + value.freshnessNote : ''
        return [{ type: 'text', text: head + lines.join('') + fnote }]
      },
    },
    async execute(args) {
      const k = Math.min(Math.max(Math.round(args.k || 5), 1), 10)
      // 与 MCP 面同源：带上索引新鲜度（陈旧时明说"片段可能是旧内容"）。
      const { hits, freshness } = await mem().searchDetailed(args.query, k)
      return {
        embed: mem().embed.label,
        hits: hits.map(h => ({ file: h.meta.file, chunk: h.meta.chunkIndex, score: +h.score.toFixed(3), text: String(h.meta.text).slice(0, 400) })),
        freshness,
        freshnessNote: freshness.note,
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
    output: { schema: { type: 'object', additionalProperties: true, properties: { saved: { type: 'boolean' }, key: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.saved ? (`已记住：${value.key}`) : (`保存被拒绝：${value.error}`) }] },
    async execute(args) {
      try {
        mem().remember(args.key, args.value, args.scope || 'global')
        return { saved: true, key: args.key }
      } catch (e) {
        return { saved: false, key: args.key, error: e.message }
      }
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
    output: { schema: { type: 'object', additionalProperties: true, properties: { chunks: { type: 'integer' }, kvEntries: { type: 'integer' }, embed: { type: 'string' }, embedEndpoint: { type: 'string' }, note: { type: 'string' } } },
      // BV-07：`embedEndpoint`/`note` 一直在数据层（MCP 面的 jtext 能看见），但 DSH 面的渲染
      // 只印 `embed` 标签 —— 于是 agent 看到"（MiniMax embo-01）"，**无从判断内容有没有出本机**，
      // 而它正是隐私承诺的唯一依据。远端必须在默认视图里写明。
      render: (_args, value) => {
        // ⚠ F-054（2026-09-14 在真机上撞见）：**渲染层判 remote 靠 `value.embedEndpoint`，
        //   而 `execute` 根本没返回这个字段** ⇒ 永远走 else 分支，对用户说
        //   「embedding **在本机完成：内容未离开本机**」。而当时 embedding 实际走的是远程 API，
        //   我刚把 2578 个分块发到 api.minimax.chat。**一条关于隐私的假承诺。**
        //   根因与 F-049/F-051 同族：**改了一半** —— 当初只修了渲染，忘了从 execute 把字段带出来。
        //   现在渲染层对"字段缺失"**不再当成本地**：缺字段就明说"判不了"，绝不替它下"没出本机"的结论。
        const ep = value.embedEndpoint
        const head = `记忆库：${value.chunks} 分块 / ${value.kvEntries} 条 KV（${value.embed}，embedding=${ep || '**判不了（本工具没回报该字段）**'}）`
        if (ep === undefined || ep === null || ep === '') {
          return [{ type: 'text', text: head + `\n⚠ **无法判断 embedding 有没有出本机**（工具没回报 embedEndpoint）。` +
            `\n**不要向用户承诺"数据不外传"**；要判断请直接看 \`memory.status().embedEndpoint\`，或检查有没有配 MiniMax key。` }]
        }
        return [{
          type: 'text',
          text: head +
            (String(ep).startsWith('remote')
              ? `\n⚠ **索引内容会发到远程 API**（${ep}）：文件分块会离开本机。` +
                `\n**不要向用户承诺"数据不外传"。** 想改成纯本地请取消 MiniMax API key（自动降级为本地 bigram 检索）。`
              : `\n（embedding 在本机完成：内容未离开本机）`) +
            (value.note ? `\n（${value.note}）` : ''),
        }]
      } },
    async execute() {
      const s = mem().status()
      // ⚠ F-054：**必须把渲染层要用的字段一起带出来**。少了 `embedEndpoint`，渲染就只能瞎猜，
      //   而它猜的方向是"本地/安全" —— 一个字段漏传 = 一句隐私假承诺。
      return { chunks: s.chunks, kvEntries: s.kvEntries, embed: s.embed, embedEndpoint: s.embedEndpoint, note: s.note }
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
