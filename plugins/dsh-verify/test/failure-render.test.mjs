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
import { renderFailureQuery } from '../lib/render-failure.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

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
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-verify 失败样本库渲染层（F-059：算出来了就要印出来）')
process.exit(failures ? 1 : 0)
