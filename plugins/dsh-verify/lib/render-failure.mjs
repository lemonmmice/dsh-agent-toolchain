/**
 * dsh-verify 的失败样本库**渲染层**（`failure_query` / `failure_stats`）。
 *
 * 为什么单独成一个模块（与 `dsh-api-visualizer/lib/query-view.mjs` 同一先例）：
 *   `index.js` 依赖宿主的 `@deepseek-ai/dsh-tools`（普通 node 进程 import 不到）⇒ 写在那里面就**不可测**。
 *   本模块**零依赖**，可以被普通 node 测试直接 import、也可以被 `index.js` 静态 import。
 *
 * ⚠ 2026-09-14 的教训（F-059，被新加的"载荷探针"抓出来）：
 *   `failure_query` 的渲染**只有一行计数**：
 *     「失败样本库：返回 2 条（库内合计 39，已排除撤回 5 条）」
 *   —— `query()` 返回的 `rows`（**记录正文**）**一个字都没印**。
 *   而当时的处境最难堪：**我想读的正是我自己刚写进库里的那一条**（`verify_report` 判 fail 后自动入库的
 *   `agent-misjudge`），DSH 面上没有任何工具能把它的内容读出来（`GET /stats/*` 只有聚合，
 *   MCP 面是 `jtext` 整个对象所以只有 DSH 面坏）。
 *   这与 F-052（`memory_search` 只印"找到 N 条"）**是同一个病**：算出来了、也返回了，渲染层把它丢了。
 */

/**
 * 把库里的 `ts` 解析成毫秒。**两种形态都要认** —— 这一条是现场踩出来的：
 *
 *   `lib/failure-corpus.mjs` 写的是 **ISO 字符串**（`ts: now.toISOString()` ⇒ `"2026-09-14T06:58:35.908Z"`），
 *   而我的第一版 `fmtWhen` 是 `Number(ts)` —— 对 ISO 串得到 **NaN** ⇒ 渲染成 **`-`**，
 *   也就是**一条真实存在的时间被印成了"拿不到"**。当时的单测喂的是 epoch 数字
 *   （**我以为的形状，不是生产者写的形状**）⇒ 单测全绿、而现网每条记录的 `ts` 都是 `-`。
 *   ★ 这是第 60 类（"算出来了没印出来"）的镜像：**印了，但印成了"没有"**。
 *   教训：**测试夹具必须来自生产者**（本文件的单测现在直接用 `makeFailureCorpus` 造记录）。
 */
function parseWhen(ts) {
  if (ts === null || ts === undefined || ts === '') return null
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null
  const s = String(ts).trim()
  if (s === '') return null
  if (/^\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null }   // epoch 的字符串形态
  const t = Date.parse(s)                                                              // ISO 8601 / RFC 3339
  return Number.isFinite(t) ? t : null                                                 // 认不出来就如实写 '-'
}

/** 毫秒人话（拿不到写 `-`；**不许**把 null 算成 0 —— `Number(null) === 0`）。 */
function fmtWhen(ts) {
  const n = parseWhen(ts)
  if (n === null) return '-'
  const d = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 一条记录压成几行（越靠前的越重要：类别 + 任务名是"一眼能不能认出来"的关键）。 */
function renderRow(r, i) {
  const o = r && typeof r === 'object' ? r : {}
  const head = '[' + (i + 1) + '] ' + (o.failureClass || '(无类别)') + '  ' + (o.task || '(无 task)')
  const meta = []
  if (o.id) meta.push('id=' + o.id)
  if (o.ts !== undefined) meta.push('ts=' + fmtWhen(o.ts))
  if (Array.isArray(o.tags) && o.tags.length) meta.push('tags=' + o.tags.join(','))
  if (o.costMs !== undefined) meta.push('costMs=' + o.costMs)
  const lines = [head]
  if (o.description) lines.push('    ' + String(o.description).replace(/\s*\n\s*/g, ' '))
  if (o.resolution) lines.push('    解决：' + String(o.resolution).replace(/\s*\n\s*/g, ' '))
  if (meta.length) lines.push('    ' + meta.join('  '))
  return lines.join('\n')
}

/**
 * `failure_query` 的渲染。
 *
 * 口径：
 *   · **记录正文必须印出来**（这是这个工具存在的意义）；
 *   · 摘要里保留"库内合计 / 已排除撤回"，并**说清"返回 N 条"与"库内合计"不是同一个数**；
 *   · 被撤回的记录若带出来（`includeRetracted`），逐条标出撤回理由；
 *   · 0 条时**不许**只给一个 0 —— 要说清库是空的 / 还是条件把结果滤没了。
 *
 * @param {object} v `lib/failure-corpus.mjs` 的 `query()` 返回值
 */
export function renderFailureQuery(v) {
  const o = v && typeof v === 'object' ? v : {}
  const rows = Array.isArray(o.rows) ? o.rows : []
  const total = o.total === undefined ? '?' : o.total
  const retractedExcluded = o.retractedExcluded === undefined ? 0 : o.retractedExcluded
  const head = '失败样本库：本次返回 ' + rows.length + ' 条（库内合计 ' + total + '，已排除撤回 ' + retractedExcluded + ' 条）'
  const lines = [head]

  if (rows.length === 0) {
    lines.push('（本次 0 条）—— **别直接读成"库里没有"**：可能是过滤条件把结果滤没了（q / failureClass / tag / 时间范围），' +
      '也可能是传了 `includeRetracted=false` 而命中的正好都是**已撤回**的记录（本次已排除 ' + retractedExcluded + ' 条）。' +
      '下一步：去掉过滤条件、或传 includeRetracted=true 再查一次。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  for (let i = 0; i < rows.length; i++) lines.push(renderRow(rows[i], i))
  if (retractedExcluded > 0) {
    lines.push('ℹ 另有 ' + retractedExcluded + ' 条**已被撤回**的记录没返回（撤回是追加式的，原文仍在盘上）—— 要看得传 includeRetracted=true。')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}
