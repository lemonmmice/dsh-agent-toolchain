// dsh-verify 失败样本库**渲染层**单测（F-059）。
//
// 病（2026-09-14，被 toolface-params 新加的"载荷探针"抓出来）：
//   `failure_query` 的 DSH 面渲染**只有一行计数** ——
//     「失败样本库：返回 2 条（库内合计 39，已排除撤回 5 条）」
//   而 `query()` 返回的 `rows`（**记录正文**）**一个字都没印**。
//   当时最尴尬的处境正是：**我要读的就是我自己刚写进库里的那一条**
//   （verify_report 判 fail 后自动入库的 agent-misjudge），DSH 面上**没有任何工具**能把它读出来。
//   这与 F-052（`memory_search` 只印"找到 N 条"）是同一个病：
//   **算出来了、也返回了，渲染层把它丢了**。
//
// 为什么这条测试放在**独立模块**上：`index.js` 依赖宿主的 `@deepseek-ai/dsh-tools`
// （普通 node 进程 import 不到）⇒ 渲染逻辑一旦写在那里就不可测。渲染已挪到
// `plugins/dsh-verify/lib/render-failure.mjs`（零依赖）。
//
// ★★ 第二轮补充（同一晚，**现网复验时抓出来的**）：
//   第一版的夹具是我**手写的** `ts: Date.parse(...)`（epoch 数字），而**生产者写的是 ISO 字符串**
//   （`lib/failure-corpus.mjs` → `ts: now.toISOString()`）⇒ 渲染里 `Number(ISO)` 得 NaN ⇒
//   现网每条记录都印成 **`ts=-`**，而单测**全绿**。
//   ⇒ 现在夹具**直接来自生产者**（`makeFailureCorpus()` 真写一条到临时目录、再查出来当夹具）：
//     **"我以为的形状"不能当夹具** —— 这不是"测试写得不够多"，而是**测的不是同一件事**。
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderFailureQuery } from '../lib/render-failure.mjs'
import { makeFailureCorpus } from '../../../lib/failure-corpus.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ---------------------------------------------------------------- 0. ★★ 夹具来自**生产者**
//    走真库的接口（临时目录，**绝不碰真库**）⇒ 形状就是 `failure-corpus.mjs` 真正写出来的形状。
let producerRows = []
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-failure-render-'))
  try {
    const c = makeFailureCorpus({ dir })
    c.record({
      task: '用户第二次重启后复验：F-057 是否已在现网修好', failureClass: 'agent-misjudge',
      description: 'claim contradicted by evidence: 环境体检 6/6、exit=0', resolution: '闸本身有 bug：失败分支没有停下',
      tags: ['verify', 'render'],
    })
    c.record({ task: 'ui_drive find 未配置目标进程', failureClass: 'tool-error', description: 'find 需要 DSH_UI_PROC_NAME' })
    producerRows = c.query({ limit: 10 }).rows
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不改结论 */ } }
}
check('★ （夹具自证）生产者真的写出了两条记录', producerRows.length === 2, 'rows=' + producerRows.length)
check('★ （夹具自证）生产者的 `ts` 是 **ISO 字符串**（不是 epoch 数字）—— 第一版夹具就错在这里',
  typeof producerRows[0].ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(producerRows[0].ts),
  JSON.stringify(producerRows[0] && producerRows[0].ts))

const rows = [
  {
    id: 'fc-20260914-59adea7b4d22', ts: Date.parse('2026-09-14T06:12:00Z'), failureClass: 'agent-misjudge',
    task: '用户第二次重启后复验：F-057 是否已在现网修好', tags: ['verify', 'render'],
    description: 'claim contradicted by evidence: 环境体检 6/6、exit=0', resolution: '闸本身有 bug：失败分支没有停下',
  },
  {
    id: 'fc-20260914-abc123', ts: Date.parse('2026-09-13T22:00:00Z'), failureClass: 'tool-error',
    task: 'ui_drive find 未配置目标进程', description: 'find 需要 DSH_UI_PROC_NAME',
  },
]

// ---------------------------------------------------------------- 0b. 真实行也必须印出时间
{
  const text = renderFailureQuery({ rows: producerRows, total: producerRows.length }).map((c) => c.text).join('\n')
  check('★★ **真实生产者的行**：时间印成可读时间，**不是** `ts=-`（现网第一版每条都是 `-`）',
    !/ts=-/.test(text) && /ts=\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text), text.slice(0, 260))
  check('★★ **真实生产者的行**：task/description 也都在',
    text.includes('用户第二次重启后复验：F-057 是否已在现网修好') && text.includes('claim contradicted by evidence'), text.slice(0, 300))
  check('★ 真实生产者的 `resolution` 也在（这条记录是"怎么解开的"的唯一来源）',
    text.includes('闸本身有 bug：失败分支没有停下'), text.slice(0, 400))
}

// ---------------------------------------------------------------- 1. 记录正文必须印出来
{
  const out = renderFailureQuery({ rows, total: 39, retractedExcluded: 5, count: 2 })
  const text = out.map((c) => c.text).join('\n')
  check('形状是宿主认的 [{type:"text",text}]',
    Array.isArray(out) && out.length > 0 && typeof out[0].text === 'string', JSON.stringify(out).slice(0, 120))
  check('★★ **记录正文印出来了**（task / description）—— 这正是这个工具存在的意义',
    text.includes('用户第二次重启后复验：F-057 是否已在现网修好') && text.includes('claim contradicted by evidence'),
    text.slice(0, 300))
  check('★ 第二条也印出来了（不是只印第一条）', text.includes('ui_drive find 未配置目标进程'), text.slice(0, 400))
  check('★ 类别 / id / tags / 解决方式 都在（认得出是哪一条、怎么解的）',
    text.includes('agent-misjudge') && text.includes('fc-20260914-59adea7b4d22') &&
    text.includes('tags=verify,render') && text.includes('解决：'), text.slice(0, 400))
  check('★ 时间戳渲染成可读时间，**不是** epoch 数字', /2026-09-\d\d \d\d:\d\d/.test(text), text.slice(0, 200))
  check('★ 摘要保留"库内合计 / 已排除撤回"', /库内合计 39/.test(text) && /已排除撤回 5/.test(text), text.slice(0, 160))
  check('★ 有被排除的撤回记录时**说清怎么看它们**', /includeRetracted=true/.test(text), text.slice(-260))
}

// ---------------------------------------------------------------- 2. 0 条不许只给一个 0
{
  const text = renderFailureQuery({ rows: [], total: 39, retractedExcluded: 7, count: 0 }).map((c) => c.text).join('\n')
  check('★★ 0 条要解释成"可能是过滤滤没了 / 可能命中的都是已撤回的"，并给下一步',
    /别直接读成/.test(text) && /includeRetracted=true/.test(text) && /已排除 7 条/.test(text), text.slice(0, 320))
}

// ---------------------------------------------------------------- 3. 残缺形状不炸（渲染层永远不能抛）
{
  const cases = [
    { rows: [{ task: 'x' }], total: undefined, retractedExcluded: undefined },
    { rows: [null, 'raw', 42], total: 1 },
    { rows: rows.map((r) => ({ ...r, tags: 'not-an-array', ts: null })), total: 2 },
    { total: 3 },
    null,
    undefined,
  ]
  let threw = null
  for (const c of cases) {
    try {
      const r = renderFailureQuery(c)
      if (!Array.isArray(r) || !r[0] || typeof r[0].text !== 'string' || r[0].text === '') { threw = '形状不对：' + JSON.stringify(c).slice(0, 80); break }
    } catch (e) { threw = (e && e.message ? e.message : String(e)) + ' @ ' + JSON.stringify(c).slice(0, 80); break }
  }
  check('★ 残缺/非法形状（null、字符串行、坏 tags、坏 ts）都不抛，且仍返回非空文本', threw === null, String(threw))
  const badTs = renderFailureQuery({ rows: [{ task: 't', ts: null }], total: 1 }).map((c) => c.text).join('\n')
  check('★ 时间戳为 null 时印 `-`，**不许**变成 0（`Number(null) === 0` ⇒ 会印出 1970）',
    !/1970/.test(badTs) && /ts=-/.test(badTs), badTs.slice(0, 200))
  // 三种形态都要认：ISO 字符串（**生产者写的**）· epoch 数字 · 认不出来的垃圾
  const forms = renderFailureQuery({
    rows: [
      { task: 'iso', ts: '2026-09-14T06:58:35.908Z' },
      { task: 'epoch', ts: Date.parse('2026-09-14T06:58:35.908Z') },
      { task: 'junk', ts: '不是时间' },
    ], total: 3,
  }).map((c) => c.text).join('\n')
  check('★★ ISO 字符串与 epoch 两种形态**都要能印出时间**（只认 epoch 的话现网全是 `ts=-`）',
    (forms.match(/ts=\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g) || []).length === 2 && /junk/.test(forms) && !/1970/.test(forms),
    forms.slice(0, 300))
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-verify 失败样本库渲染层（F-059：算出来了就要印出来）')
process.exit(failures ? 1 : 0)
