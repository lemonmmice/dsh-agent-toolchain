/**
 * perf 证据目录的**清理**（r51）—— G1 黑盒点名的缺口：
 *   `perf_dump` 说 dump"数百 MB"、`perf_trace` 说 etl"可能数百 MB"，而 46 个工具里
 *   **没有任何一个能删除 perf 证据**（`hang_delete` 只管卡死证据包）⇒
 *   "我唯一的出路是请用户手删，或者用不在本目录里的 pwsh"。
 *
 * 设计原则（照抄本仓已经站住的那几条）：
 *   1. **默认只看不删**：不给 `confirm:true` 就只列清单（dry-run），并如实报出"会删多少字节"；
 *   2. **只删自己能认出来的文件**：只处理 `.dmp` / `.etl`（证据大件），**绝不做递归删除**、绝不碰目录本身；
 *   3. **只在自己管的目录里动**：目标必须在 perf 证据目录之下（`resolve` 后前缀比对），否则**拒绝**；
 *   4. **采样进行中不删**：会话标记（trace-session.json）说在跑时，拒绝删 `.etl`（那正是它正在写的文件）；
 *   5. 失败要把原因说清楚（目录不存在 / 传进来的路径越界 / 读不到），不许静默什么都不做。
 */
import { existsSync, statSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const BIG_EXT = /\.(dmp|etl)$/i

/** 目标路径是否在 root 之下（前缀比对，避免 `..` 越界）。 */
function under(root, p) {
  const r = resolve(root).toLowerCase().replace(/[\\/]+$/, '')
  const t = resolve(p).toLowerCase()
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}

/**
 * @param {{dir:string, confirm?:boolean, keepDays?:number, what?:'dumps'|'etls'|'all', now?:number}} args
 * @returns {{ok:boolean, dryRun:boolean, dir:string, candidates:{path:string,bytes:number,ageDays:number}[], totalBytes:number, deleted:string[], freedBytes:number, skipped:{path:string,reason:string}[], error?:string, hint?:string}}
 */
export function cleanEvidence(args = {}) {
  const dir = args.dir ? resolve(String(args.dir)) : ''
  if (!dir) return { ok: false, error: '没有可用的 perf 证据目录（DSH_PERF_EVIDENCE_DIR 未配置且默认目录也取不到）', dryRun: true, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }
  if (!existsSync(dir)) return { ok: false, error: '证据目录不存在：' + dir, dryRun: true, dir, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }
  if (!under(dir, dir)) return { ok: false, error: '证据目录解析异常：' + dir, dryRun: true, dir, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }

  const what = String(args.what || 'all').toLowerCase()
  const keepDays = Number.isFinite(Number(args.keepDays)) && Number(args.keepDays) > 0 ? Number(args.keepDays) : 0
  const now = Number.isFinite(Number(args.now)) ? Number(args.now) : Date.now()
  const confirm = args.confirm === true

  // 采样进行中 ⇒ 不碰 etl（那可能正是它在写的文件）
  let sampling = false
  try {
    const s = JSON.parse(readFileSync(join(dir, 'trace-session.json'), 'utf8'))
    sampling = Boolean(s && s.etlPath)
  } catch { sampling = false }

  const candidates = []
  const skipped = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { skipped.push({ path: p, reason: '读不到状态' }); continue }
    if (!st.isFile()) continue                       // 只处理文件，**绝不递归**
    const isDump = /\.dmp$/i.test(name)
    const isEtl = /\.etl$/i.test(name)
    if (!isDump && !isEtl) continue
    if (what === 'dumps' && !isDump) continue
    if (what === 'etls' && !isEtl) continue
    if (!BIG_EXT.test(name)) continue
    const ageDays = (now - st.mtimeMs) / 86400000
    if (keepDays > 0 && ageDays < keepDays) { skipped.push({ path: p, reason: '未超龄（' + ageDays.toFixed(2) + ' 天 < keepDays=' + keepDays + '）' }); continue }
    if (sampling && isEtl) { skipped.push({ path: p, reason: '采样进行中（trace-session.json 在盘上）：不删 etl' }); continue }
    candidates.push({ path: p, bytes: st.size, ageDays: Number(ageDays.toFixed(2)) })
  }
  const totalBytes = candidates.reduce((a, x) => a + x.bytes, 0)

  if (!confirm) {
    return {
      ok: true, dryRun: true, dir, candidates, totalBytes, deleted: [], freedBytes: 0, skipped,
      hint: candidates.length
        ? '上面是**将要删除**的文件（共 ' + totalBytes + ' 字节）。确认后重新调用并传 confirm=true；只想删某类可传 what="dumps"|"etls"，只删旧的传 keepDays=7。'
        : '没有符合条件的文件（可能已经清过了，或 keepDays/what 过滤掉了）。',
    }
  }

  const deleted = []
  let freedBytes = 0
  for (const c of candidates) {
    try { rmSync(c.path, { force: true }); deleted.push(c.path); freedBytes += c.bytes }
    catch (e) { skipped.push({ path: c.path, reason: '删除失败：' + String((e && e.message) || e) }) }
  }
  return {
    ok: true, dryRun: false, dir, candidates, totalBytes, deleted, freedBytes, skipped,
    hint: deleted.length ? '已删除 ' + deleted.length + ' 个文件，释放 ' + freedBytes + ' 字节。' : '没有删除任何文件。',
  }
}

/** 人话渲染（工具面用）。 */
export function renderClean(v) {
  if (!v || v.ok !== true) return '⚠ 清理失败：' + ((v && v.error) || '原因未回报')
  const head = v.dryRun
    ? '【只看不删】' + (v.candidates.length) + ' 个文件命中，共 ' + v.totalBytes + ' 字节'
    : '【已删除】' + v.deleted.length + ' 个文件，释放 ' + v.freedBytes + ' 字节'
  const lines = (v.candidates || []).slice(0, 20).map((c) => '  ' + basename(c.path) + '  ' + c.bytes + ' 字节（' + c.ageDays + ' 天前）')
  const more = (v.candidates || []).length > 20 ? '  …共 ' + v.candidates.length + ' 个' : ''
  const skips = (v.skipped || []).slice(0, 5).map((s) => '  ⏭ ' + basename(s.path) + '：' + s.reason)
  return [head, '目录：' + v.dir, ...lines, more, ...skips, v.hint].filter(Boolean).join('\n')
}
