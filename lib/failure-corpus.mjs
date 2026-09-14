/**
 * lib/failure-corpus.mjs — local failure corpus: the data flywheel.
 *
 * Every human handoff, verification failure, agent misjudgment, or tool
 * malfunction appends one JSONL record. Failure classes are a FIXED taxonomy
 * on purpose: a small, stable vocabulary is what makes the data minable later.
 *
 * Framework-free (no DSH/MCP imports). Data stays local — never uploaded.
 *
 *   const c = makeFailureCorpus({})                 // ~/.dsh-agent-toolchain/failure-corpus
 *   c.record({ task, failureClass, description })   // -> full record with id/ts
 *   c.query({ q, failureClass, tag, fromTs, toTs }) // -> newest-first rows
 *   c.stats()                                       // -> totals + per-class counts
 *
 * Env: DSH_FAILURE_CORPUS_DIR overrides the data dir.
 * The active file rotates to records-<timestamp>.jsonl at 20 MB.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
// 用户级配置 → 经 env-fallback（长活宿主的环境块里没有用户后来设置的变量）。
import { envOr } from './env-fallback.mjs'

/**
 * Fixed failure taxonomy. Do not add classes casually: every new class
 * splits future statistics. Propose + document a new class before using it.
 */
export const FAILURE_CLASSES = [
  'verification-failure', // build / test / CI / UI check actually failed
  'agent-misjudge', // agent claimed success, evidence disagreed
  'human-handoff', // work stopped to ask a human
  'tool-error', // a toolchain component malfunctioned
  'flaky', // nondeterministic failure (passes on retry)
  'doc-gap', // docs / API mismatch caused the failure
  'design-flaw', // an architecture decision required rework
]

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024

export function defaultCorpusDir() {
  return envOr('DSH_FAILURE_CORPUS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'failure-corpus')
}

export function makeFailureCorpus(opts = {}) {
  const dir = opts.dir || defaultCorpusDir()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES
  const activeFile = () => join(dir, 'records.jsonl')

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /**
   * 轮转：把活动文件改名成一个**不会重名**的归档分片。
   *
   * F-032-c（2026-09-12，r30 **由测试逼出来的真缺陷**）：旧实现用**分钟精度**的 stamp 直接
   * `renameSync(f, records-<stamp>.jsonl)`，而 Node 在 Windows 上是 `MOVEFILE_REPLACE_EXISTING`
   * —— **同一分钟内第二次轮转会把上一次的归档直接覆盖掉**，那批记录**无声消失**。
   * 实测证据：测试用 `maxBytes: 700` 连写 26 条，最后库里只剩 **6 条**（丢了 20 条）。
   * 真实场景下要写满 20MB 两次才触发，所以**至今没被生产碰到** —— 但"没触发"不等于"没问题"，
   * 而且这正是本仓反复修的那一类：**数据静默丢失**。
   * 现在：目标文件已存在就加 `-1`/`-2` 后缀，**绝不覆盖**。
   */
  function archiveName(now) {
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
    let name = `records-${stamp}.jsonl`
    let n = 1
    while (existsSync(join(dir, name))) {
      name = `records-${stamp}-${n}.jsonl`
      n += 1
    }
    return name
  }

  function rotateIfNeeded(now) {
    const f = activeFile()
    if (!existsSync(f) || statSync(f).size <= maxBytes) return null
    const target = join(dir, archiveName(now))
    renameSync(f, target)
    return target
  }

  function validate(rec) {
    if (!rec || typeof rec !== 'object') throw new Error('record must be an object')
    if (typeof rec.task !== 'string' || !rec.task.trim()) throw new Error('task (string) is required')
    if (!FAILURE_CLASSES.includes(rec.failureClass)) {
      throw new Error(`failureClass must be one of: ${FAILURE_CLASSES.join(', ')}`)
    }
    if (typeof rec.description !== 'string' || !rec.description.trim()) {
      throw new Error('description (string) is required')
    }
    if (rec.resolution !== undefined && typeof rec.resolution !== 'string') {
      throw new Error('resolution must be a string')
    }
    if (rec.tags !== undefined && (!Array.isArray(rec.tags) || rec.tags.some((t) => typeof t !== 'string'))) {
      throw new Error('tags must be an array of strings')
    }
    if (rec.context !== undefined && (typeof rec.context !== 'object' || rec.context === null || Array.isArray(rec.context))) {
      throw new Error('context must be an object')
    }
    if (rec.costMs !== undefined && (typeof rec.costMs !== 'number' || rec.costMs < 0)) {
      throw new Error('costMs must be a non-negative number')
    }
  }

  function record(rec) {
    validate(rec)
    ensureDir()
    const now = new Date()
    // F-034（2026-09-12，r33 @codex 证伪 + 我复核真库）：
    // 旧 id 是 `fc-<日期>-<2 字节 hex>` —— 每天只有 **65536** 种。
    // Codex 实测 2000 条就撞出 **31 个重复 id**（生日近似 2000²/(2·65536) ≈ 30.5，吻合）；
    // 我在**真库**里也复核到 2 组重复（4 条记录）：
    //   `fc-20260911-ff77` ×2、`fc-20260911-4b74` ×2。
    // 危害不是"好看不好看"：**撤回是按 id 生效的** ⇒ 撤回其中一条会**连带撤回同 id 的另一条**，
    // 于是**一条有效的失败记录被静默地从统计里抹掉** —— 又是"数据静默消失"。
    // 现在加宽到 **6 字节（48 bit）**：1 万条/天的碰撞概率 ≈ 1.8e-7。
    const full = {
      id: `fc-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('hex')}`,
      ts: now.toISOString(),
      task: rec.task.trim(),
      failureClass: rec.failureClass,
      description: rec.description.trim(),
      ...(rec.resolution !== undefined ? { resolution: rec.resolution } : {}),
      ...(rec.context !== undefined ? { context: rec.context } : {}),
      ...(rec.costMs !== undefined ? { costMs: rec.costMs } : {}),
      ...(rec.tags !== undefined ? { tags: rec.tags } : {}),
    }
    const f = activeFile()
    rotateIfNeeded(now)
    appendFileSync(activeFile(), JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  function readActive() {
    const f = activeFile()
    if (!existsSync(f)) return []
    const rows = []
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // skip a corrupt line; the rest of the corpus stays usable
      }
    }
    return rows
  }

  /**
   * 读**全部**分片（active + 轮转出去的 `records-*.jsonl`）。
   *
   * F-032（2026-09-12，r30 读代码发现）：旧实现只读 `records.jsonl`，而轮转会把旧文件 rename 成
   * `records-<stamp>.jsonl` —— 于是**轮转之后，那些记录对 query/stats 完全隐形**：
   * `failure_stats.total` 会**变小**，且没有任何字段提示"还有 N 个分片没读"。
   * 20MB 上限还没到，所以这个坑**至今没被触发过**（正因如此才更该先修：它属于"没读到 ≠ 没有"，
   * 而且是**数据静默丢失**那一档）。
   */
  function readAllShards() {
    ensureDir()
    const shards = []
    try {
      for (const name of readdirSync(dir)) {
        if (!/^records.*\.jsonl$/.test(name)) continue
        shards.push({ name, isActive: name === 'records.jsonl' })
      }
    } catch { /* 目录读不到就走下面的空集 */ }
    shards.sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name) : (a.isActive ? 1 : -1)))
    const rows = []
    let corruptLines = 0
    for (const s of shards) {
      try {
        for (const line of readFileSync(join(dir, s.name), 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            rows.push(JSON.parse(line))
          } catch { corruptLines++ }   // 坏行跳过，但**计数**（不能静默）
        }
      } catch { /* 单个分片读不到不该让整次查询失败 */ }
    }
    return { rows, files: shards.map((s) => s.name), corruptLines }
  }

  /** 把"撤回事件"作用到记录集上：返回仍在生效的行 + 被撤回的行（都带痕迹）。 */
  function applyRetractions(rows) {
    const retractions = rows.filter((r) => r && r.kind === 'retraction' && typeof r.retracts === 'string')
    // ★ F-034：撤回要**精确定位到某一条**。历史 id 会撞，所以撤回事件里记了目标 `retractsTs`：
    //   先按 (id, ts) 精确匹配；老式撤回事件没有 ts 时退回按 id 匹配（并可能影响同 id 的多条）。
    const byPair = new Map()
    const byIdOnly = new Map()
    for (const rt of retractions) {
      if (typeof rt.retractsTs === 'string') {
        const k = rt.retracts + '\u0000' + rt.retractsTs
        const prev = byPair.get(k)
        if (prev === undefined || String(rt.ts) > String(prev.ts)) byPair.set(k, rt)
      } else {
        const prev = byIdOnly.get(rt.retracts)
        if (prev === undefined || String(rt.ts) > String(prev.ts)) byIdOnly.set(rt.retracts, rt)
      }
    }
    const active = []
    const retracted = []
    for (const r of rows) {
      if (r && r.kind === 'retraction') continue
      const hit = (r && typeof r.id === 'string')
        ? (byPair.get(r.id + '\u0000' + String(r.ts)) ?? byIdOnly.get(r.id))
        : undefined
      if (hit !== undefined) {
        retracted.push({ ...r, retracted: true, retractedAt: hit.ts, retractedReason: hit.reason ?? null, retractedBy: hit.by ?? null })
      } else {
        active.push(r)
      }
    }
    return { active, retracted, retractions }
  }

  function query(q = {}) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const needle = (q.q ?? '').toLowerCase()
    // ★ 查询读**全部分片**：一个"查不到"的查询比一个"慢一点"的查询危险得多。
    const { rows, files, corruptLines } = readAllShards()
    const { active, retracted, retractions } = applyRetractions(rows)
    const includeRetracted = q.includeRetracted === true
    // 默认**不**把已撤回的算进来（它们已知是错的），但把数字如实报出去 —— 不静默丢弃。
    let list = includeRetracted ? [...active, ...retracted] : active
    if (needle) {
      list = list.filter((r) =>
        [r.task, r.description, r.resolution ?? ''].some((s) => String(s).toLowerCase().includes(needle))
      )
    }
    if (q.failureClass) list = list.filter((r) => r.failureClass === q.failureClass)
    if (q.tag) list = list.filter((r) => (r.tags ?? []).includes(q.tag))
    if (q.fromTs !== undefined) list = list.filter((r) => Date.parse(r.ts) >= q.fromTs)
    if (q.toTs !== undefined) list = list.filter((r) => Date.parse(r.ts) <= q.toTs)
    list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    const out = {
      total: list.length,
      count: Math.min(Math.max(list.length - offset, 0), limit),
      rows: list.slice(offset, offset + limit),
      filesScanned: files,
      retractionsApplied: retractions.length,
      retractedExcluded: includeRetracted ? 0 : retracted.length,
      ...(corruptLines > 0 ? { corruptLines, note: '有 ' + corruptLines + ' 行解析失败被跳过（其余仍可用）' } : {}),
      ...(includeRetracted ? { includeRetracted: true } : {}),
    }
    return out
  }

  /**
   * 撤回一条**已知记错了**的记录（append-only：不删原来的行，而是追加一条撤回事件）。
   *
   * 为什么需要它（2026-09-12 r28/r30）：F-023 让 `verify_report` 把**两句真话**判成了失败，
   * 于是失败库里留下了两条 `class=agent-misjudge` 的**假记录**。
   * 删掉它们等于掩盖"工具曾经诬告过我"；留着又会让所有统计**被污染**（而那正是唯一用来抓 agent 自说自话的数据源）。
   * 现在第三条路：**追加一条撤回事件**，原文还在（可审计），但 query/stats 不再把它算进去，并如实报告撤回了多少条。
   */
  function retract({ id, ts, reason, by } = {}) {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'id (string) is required' }
    if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason (string) is required —— 撤回必须写明理由' }
    const { rows } = readAllShards()
    const matches = rows.filter((r) => r && r.id === id && r.kind !== 'retraction')
    if (matches.length === 0) {
      return { ok: false, error: '没有找到 id=' + id + ' 的记录（撤回不存在的记录是无效动作，不做）' }
    }
    // ★ F-034：id **不再是全局唯一**（历史数据里已有重复 id 组）。
    //   此时"按 id 撤回"会产生歧义 —— 必须让调用方用 `ts` 指定是哪一条，否则**拒绝**。
    let target = matches[0]
    if (matches.length > 1) {
      if (ts === undefined) {
        return {
          ok: false, ambiguous: true, count: matches.length,
          error: `id=${id} 在库里对应 **${matches.length} 条**记录（历史 id 只有 2 字节随机，会撞）。`
            + '按 id 撤回会连带撤回其它条 —— 请附上 `ts`（记录时间戳）指明是哪一条：'
            + matches.map((r) => `${r.ts}(${r.failureClass})`).join('、'),
          candidates: matches.map((r) => ({ ts: r.ts, failureClass: r.failureClass, task: r.task })),
        }
      }
      const exact = matches.filter((r) => r.ts === ts)
      if (exact.length !== 1) {
        return { ok: false, ambiguous: true, count: exact.length, error: `id=${id} + ts=${ts} 匹配到 ${exact.length} 条（需要恰好 1 条）` }
      }
      target = exact[0]
    }
    if (rows.some((r) => r && r.kind === 'retraction' && r.retracts === id && (r.retractsTs === undefined || matches.length === 1 || r.retractsTs === target.ts))) {
      return { ok: false, error: 'id=' + id + ' 已经被撤回过了', id }
    }
    ensureDir()
    const now = new Date()
    const full = {
      kind: 'retraction',
      id: `fc-retract-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('hex')}`,
      ts: now.toISOString(),
      retracts: id,
      // ★ 记录**目标的时间戳**：id 可能不唯一，撤回必须能精确定位到某一条
      retractsTs: target.ts,
      reason: reason.trim(),
      ...(typeof by === 'string' && by.trim() ? { by: by.trim() } : {}),
      retractedOriginal: { failureClass: target.failureClass, task: target.task, description: String(target.description ?? '').slice(0, 200) },
    }
    const f = activeFile()
    rotateIfNeeded(now)
    appendFileSync(activeFile(), JSON.stringify(full) + '\n', 'utf8')
    return { ok: true, retractionId: full.id, retracts: id, ts: full.ts }
  }

  function stats() {
    const { rows, files, corruptLines } = readAllShards()
    const { active, retracted } = applyRetractions(rows)
    // ⚠ 口径（不要改掉，已有测试把它当契约）：`total` / `byClass` / `last7d` / `last30d` **只统计当前活动文件**。
    //   轮转会把旧记录移进 `records-<stamp>.jsonl`，那些**故意**不算进这几项（"活动窗口"语义）。
    //   但"变小了却不说为什么"是缺陷 —— 所以下面**同时**给出全量口径与分片清单，
    //   让调用方能分辨"库里就这么多"与"还有 N 条在归档分片里"（F-032-a）。
    const activeOnly = new Set(readActive().map((r) => r && r.id))
    const activeRows = active.filter((r) => r && activeOnly.has(r.id))
    const archivedRows = active.filter((r) => r && !activeOnly.has(r.id))
    const byClass = {}
    for (const cls of FAILURE_CLASSES) byClass[cls] = 0
    for (const r of activeRows) byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1
    const byClassAllShards = {}
    for (const cls of FAILURE_CLASSES) byClassAllShards[cls] = 0
    for (const r of active) byClassAllShards[r.failureClass] = (byClassAllShards[r.failureClass] ?? 0) + 1
    const byClassRetracted = {}
    for (const r of retracted) byClassRetracted[r.failureClass] = (byClassRetracted[r.failureClass] ?? 0) + 1
    const now = Date.now()
    const last7d = activeRows.filter((r) => now - Date.parse(r.ts) <= 7 * 86400000).length
    const last30d = activeRows.filter((r) => now - Date.parse(r.ts) <= 30 * 86400000).length
    return {
      total: activeRows.length, last7d, last30d, byClass, dir,
      // ★ 全量口径 + 分片清单：解释"为什么 total 会变小"，而不是让它悄悄变小
      totalAllShards: active.length,
      archivedRecords: archivedRows.length,
      byClassAllShards,
      filesScanned: files,
      ...(archivedRows.length > 0
        ? { archivedNote: '另有 ' + archivedRows.length + ' 条在已轮转的分片里（**不计入 total**，但 query 查得到）—— 别把 total 变小读成"库里就这么多"。' }
        : {}),
      // ★ 撤回的**如实报**：既不算进总数，也不藏起来 —— 否则"统计被污染"会变成"统计被悄悄改写"
      retracted: retracted.length,
      ...(retracted.length > 0 ? { byClassRetracted, retractedNote: '有 ' + retracted.length + ' 条已被撤回（已知记错），**没有**计入上面的总数；用 failure_query(includeRetracted=true) 可看到原文' } : {}),
      ...(corruptLines > 0 ? { corruptLines } : {}),
    }
  }

  return { record, query, stats, retract, dir }
}
