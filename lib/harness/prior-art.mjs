// Read-only bridge from the human-confirmed lesson tier (personal-defaults'
// learned-guardrails.md) into the harness improver. harness2-integration-design.md §6:
// learned-guardrails is the human tier (the floor — covers non-reproducible reasoning bugs),
// harness experiences are the machine-validated tier. This loader lets the improver BUILD ON the
// human's confirmed lessons as read-only prior art. It NEVER turns them into experiences: the
// experience store structurally refuses anything without a machine trial (experience.mjs propose/
// validate), and that anti-gaming spine must stay intact. So prior art rides a separate stage-input
// field, is clearly not machine-validated, and is never written back.
import { readFileSync, statSync } from 'node:fs'
import { findSensitive } from '../../plugins/dsh-memory/lib/sensitive.mjs'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_BYTES = 12 * 1024
const DEFAULT_MAX_ENTRIES = 8

// taskType → keywords matched against each lesson's title+body, so a thread-hang trial sees the
// human's hang lessons rather than the whole file. No keyword match for a taskType (e.g. 'logic')
// falls back to the most-recent lessons — prior art is context, not a hard filter.
const TASK_TYPE_KEYWORDS = {
  'thread-hang': ['卡顿', '卡死', 'UI线程', 'UI 线程', '阻塞', '死锁', 'freeze', 'hang', '无响应'],
  perf: ['性能', '耗时', '内存', '泄漏', '渲染', '滚动', '虚拟化', 'GC', '帧'],
  ui: ['WPF', 'XAML', '绑定', '样式', '控件', '布局', '列宽', '焦点', '模板', '视图', 'DataTrigger', 'Binding'],
  api: ['接口', '请求', '抓包', 'http', 'HTTP', '响应', 'keyword'],
  build: ['编译', 'csproj', 'build', 'MSBuild', 'Compile'],
}

function parseDate(title) {
  const match = title.match(/[（(](\d{4}-\d{2}-\d{2})[）)]/)
  return match ? match[1] : ''
}

// Split on top-level "## " headers. The file intro (before the first ##) and the housekeeping
// "维护规则" section are not lessons.
export function parseLearnedGuardrails(text) {
  const parts = String(text || '').split(/^##\s+/m).slice(1)
  const entries = []
  for (const part of parts) {
    const newline = part.indexOf('\n')
    const title = (newline === -1 ? part : part.slice(0, newline)).trim()
    const body = newline === -1 ? '' : part.slice(newline + 1).trim()
    if (!title || /^维护规则/.test(title)) continue
    entries.push({ title, date: parseDate(title), body, raw: ('## ' + part).trimEnd() })
  }
  return entries
}

function scoreEntry(entry, keywords) {
  if (!keywords || !keywords.length) return 0
  const hay = entry.title + '\n' + entry.body
  let score = 0
  for (const keyword of keywords) if (hay.includes(keyword)) score++
  return score
}

function empty(reason) {
  return { text: '', entries: 0, totalEntries: 0, matchedByDomain: false, truncated: false, droppedForSensitive: 0, source: 'learned-guardrails', reason }
}

// Returns bounded, domain-routed, secret-free raw markdown chunks for the improver to read as
// prose. Best-effort: a missing/oversized/unreadable file yields empty text, never throws.
export function loadPriorArt(path, { taskType, maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  let text
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return empty('file missing or too large')
    text = readFileSync(path, 'utf8')
  } catch { return empty('not found') }

  const parsed = parseLearnedGuardrails(text)
  const totalEntries = parsed.length
  // Drop any lesson carrying a credential wholesale rather than redacting mid-prose — a lesson
  // that needs a live token in it is not safe prior art.
  let droppedForSensitive = 0
  const safe = parsed.filter(entry => { if (findSensitive(entry.raw).length) { droppedForSensitive++; return false } return true })

  const keywords = taskType ? TASK_TYPE_KEYWORDS[taskType] : null
  const scored = safe.map(entry => ({ entry, score: scoreEntry(entry, keywords) }))
  const matched = scored.filter(item => item.score > 0)
  const pool = (matched.length ? matched : scored).sort((a, b) => (b.score - a.score) || b.entry.date.localeCompare(a.entry.date))

  const selected = []
  let bytes = 0
  let truncated = false
  for (const { entry } of pool) {
    if (selected.length >= maxEntries) { truncated = true; break }
    const size = Buffer.byteLength(entry.raw, 'utf8') + 2
    if (bytes + size > maxBytes) { truncated = true; break }
    selected.push(entry)
    bytes += size
  }
  return {
    text: selected.map(entry => entry.raw).join('\n\n'),
    entries: selected.length,
    totalEntries,
    matchedByDomain: Boolean(keywords && matched.length),
    truncated,
    droppedForSensitive,
    source: 'learned-guardrails',
  }
}
