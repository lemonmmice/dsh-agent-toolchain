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
 *
 * Fingerprints + recurrences (2026-10): every record carries a `fingerprint`
 * (class + task + description with paths/ids/numbers normalized away). A caller
 * that passes `dedupe: true` (the automatic recorders do) gets ONE full record
 * per fingerprint per window (DSH_FAILURE_DEDUPE_HOURS, default 24, 0 = off);
 * further occurrences inside the window append a compact `recurrence` event to
 * `recurrences.jsonl` instead. Counts are never lost — query() reports
 * `recurrences`/`lastSeenAt` per record and stats() ranks `topRecurring` —
 * they just stop masquerading as hundreds of separate failures.
 * The sidecar is a separate file on purpose: older readers only scan
 * `records*.jsonl`, so they keep seeing exactly what they saw before.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
// 用户级配置 → 经 env-fallback（长活宿主的环境块里没有用户后来设置的变量）。
import { envOr } from './env-fallback.mjs'
import { withFileTransaction } from './file-transaction.mjs'
import { createWorkerService } from './worker-service.mjs'

const readService = createWorkerService(new URL('./failure-corpus-worker.mjs', import.meta.url))

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

export const DEFAULT_DEDUPE_HOURS = 24

/** 去重窗口（毫秒）；DSH_FAILURE_DEDUPE_HOURS=0 关闭去重。 */
export function dedupeWindowMsFromEnv() {
  const raw = envOr('DSH_FAILURE_DEDUPE_HOURS')
  const hours = raw === undefined || raw === null || String(raw).trim() === '' ? DEFAULT_DEDUPE_HOURS : Number(raw)
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3600000) : 0
}

/**
 * 指纹前的归一化：把"同一种失败"每次都会变的部分抹平 —— 路径、长 hex/GUID、数字、多余空白。
 * 只为分组服务，不改写记录本身（description 原文照存）。
 */
export function normalizeForFingerprint(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"'`，。；）)]*/g, '<path>')
    .replace(/(^|[\s"'(（])\/[^\s"'`]+/g, '$1<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** class + task + 归一化后的 description → sha256 前 16 位。老记录没有这个字段时读侧现算，口径一致。 */
export function fingerprintOf(rec) {
  const r = rec || {}
  return createHash('sha256')
    .update([r.failureClass ?? '', String(r.task ?? '').trim(), normalizeForFingerprint(r.description)].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
}

export function makeFailureCorpus(opts = {}) {
  const dir = opts.dir || defaultCorpusDir()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES
  const activeFile = () => join(dir, 'records.jsonl')
  const recurrenceFile = () => join(dir, 'recurrences.jsonl')
  // 去重只回看活动分片的末尾：窗口内的记录一定在最近写入的那一段里，不必每次读全库。
  const tailBytes = opts.tailBytes ?? 512 * 1024
  let shardCache = null
  let parsedShards = new Map()
  let recurrenceCache = null
  let statsCache = null
  const retractionCache = new WeakMap()
  const recurrenceIndexes = new WeakMap()
  const fingerprints = new WeakMap()

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
    if (rec.producer !== undefined && (typeof rec.producer !== 'object' || rec.producer === null || Array.isArray(rec.producer))) {
      throw new Error('producer must be an object')
    }
    if (rec.dedupe !== undefined && typeof rec.dedupe !== 'boolean') {
      throw new Error('dedupe must be a boolean')
    }
  }

  /** 读一个 JSONL 文件的末尾若干字节（丢掉被截断的半行）；读不了就当空。 */
  function tailRows(file, limitBytes) {
    let fd
    try {
      fd = openSync(file, 'r')
      const size = fstatSync(fd).size
      const start = Math.max(0, size - limitBytes)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      let text = buf.toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
      const rows = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行不影响去重判断 */ }
      }
      return rows
    } catch {
      return []
    } finally {
      if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
    }
  }

  /** 窗口内同指纹、且没被撤回的最近一条全量记录；没有就 null（→ 照常写全量记录）。 */
  function findRecentByFingerprint(fp, sinceMs) {
    const rows = tailRows(activeFile(), tailBytes)
    const retracted = new Set(rows.filter((r) => r && r.kind === 'retraction').map((r) => r.retracts + '\u0000' + (r.retractsTs ?? '')))
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (!r || r.kind || typeof r.id !== 'string') continue
      if (Date.parse(r.ts) < sinceMs) break // 追加写入 ⇒ 再往前只会更早
      if ((r.fingerprint ?? fingerprintOf(r)) !== fp) continue
      if (retracted.has(r.id + '\u0000' + r.ts) || retracted.has(r.id + '\u0000')) continue
      return r
    }
    return null
  }

  function readRecurrences() {
    const f = recurrenceFile()
    const events = []
    let corrupt = 0
    const skippedShards = []
    let dataVersion = null
    try {
      const stat = statSync(f, { bigint: true })
      dataVersion = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
      if (recurrenceCache?.dataVersion === dataVersion) return recurrenceCache
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e && e.kind === 'recurrence' && typeof e.of === 'string') events.push(e)
          else corrupt++
        } catch { corrupt++ }
      }
      const after = statSync(f, { bigint: true })
      if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') !== dataVersion) {
        skippedShards.push({ file: 'recurrences.jsonl', errorCode: 'SHARDS_CHANGED_DURING_READ' })
      }
      const snapshot = { events, corrupt, skippedShards, dataVersion }
      if (!skippedShards.length) recurrenceCache = snapshot
      return snapshot
    } catch (error) {
      if (error.code !== 'ENOENT' || dataVersion !== null) skippedShards.push({ file: 'recurrences.jsonl', errorCode: dataVersion !== null && error.code === 'ENOENT' ? 'SHARDS_CHANGED_DURING_READ' : error.code ?? 'READ_FAILED' })
    }
    return { events, corrupt, skippedShards, dataVersion: skippedShards.length ? 'unreadable' : 'missing' }
  }

  /** (记录 id, ts) → { count, lastTs } */
  function recurrenceIndex(events) {
    if (recurrenceIndexes.has(events)) return recurrenceIndexes.get(events)
    const idx = new Map()
    for (const e of events) {
      const k = e.of + '\u0000' + String(e.ofTs ?? '')
      const p = idx.get(k) ?? { count: 0, lastTs: null }
      p.count++
      if (p.lastTs === null || String(e.ts) > p.lastTs) p.lastTs = String(e.ts)
      idx.set(k, p)
    }
    recurrenceIndexes.set(events, idx)
    return idx
  }

  function record(rec) {
    validate(rec)
    return withFileTransaction(activeFile(), () => recordUnlocked(rec))
  }

  function recordUnlocked(rec) {
    validate(rec)
    ensureDir()
    const now = new Date()
    const fingerprint = fingerprintOf(rec)
    // 自动记录的去重：同一指纹在窗口内已有一条全量记录 ⇒ 只追加一条 recurrence 事件（计数不丢）。
    if (rec.dedupe === true) {
      const windowMs = opts.dedupeWindowMs ?? dedupeWindowMsFromEnv()
      if (windowMs > 0) {
        const prior = findRecentByFingerprint(fingerprint, now.getTime() - windowMs)
        if (prior) {
          const ev = {
            kind: 'recurrence',
            ts: now.toISOString(),
            of: prior.id,
            ofTs: prior.ts,
            fingerprint,
            ...(rec.producer !== undefined ? { producer: rec.producer } : {}),
          }
          appendFileSync(recurrenceFile(), JSON.stringify(ev) + '\n', 'utf8')
          return { ...ev, recurrence: true }
        }
      }
    }
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
      fingerprint,
      ...(rec.resolution !== undefined ? { resolution: rec.resolution } : {}),
      ...(rec.context !== undefined ? { context: rec.context } : {}),
      ...(rec.costMs !== undefined ? { costMs: rec.costMs } : {}),
      ...(rec.tags !== undefined ? { tags: rec.tags } : {}),
      ...(rec.producer !== undefined ? { producer: rec.producer } : {}),
    }
    const f = activeFile()
    rotateIfNeeded(now)
    appendFileSync(activeFile(), JSON.stringify(full) + '\n', 'utf8')
    return full
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
  function shardInventory() {
    const shards = []
    const skippedShards = []
    try {
      for (const name of readdirSync(dir)) {
        if (!/^records.*\.jsonl$/.test(name)) continue
        try {
          const stat = statSync(join(dir, name), { bigint: true })
          shards.push({ name, isActive: name === 'records.jsonl', signature: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') })
        } catch (error) { skippedShards.push({ file: name, errorCode: error.code ?? 'STAT_FAILED' }) }
      }
    } catch (error) { skippedShards.push({ file: '.', errorCode: error.code ?? 'READ_FAILED' }) }
    shards.sort((a, b) => (a.isActive === b.isActive ? a.name.localeCompare(b.name) : (a.isActive ? 1 : -1)))
    const dataVersion = createHash('sha256').update(JSON.stringify(shards)).digest('hex')
    return { shards, skippedShards, dataVersion }
  }

  function readAllShards() {
    ensureDir()
    const { shards, skippedShards, dataVersion } = shardInventory()
    if (!skippedShards.length && shardCache?.dataVersion === dataVersion) return { ...shardCache, readMetrics: { bytesRead: 0, linesParsed: 0, shardsReused: shards.length, cacheHit: true } }
    const rows = []
    const activeRows = []
    const files = []
    let corruptLines = 0
    const nextShards = new Map()
    const readMetrics = { bytesRead: 0, linesParsed: 0, shardsReused: 0, cacheHit: false }
    for (const s of shards) {
      try {
        let parsed = parsedShards.get(s.name)
        if (parsed?.signature === s.signature) readMetrics.shardsReused++
        else {
          const bytes = readFileSync(join(dir, s.name))
          readMetrics.bytesRead += bytes.length
          const appendOnly = parsed && parsed.endsWithNewline && bytes.length > parsed.bytes && createHash('sha256').update(bytes.subarray(0, parsed.bytes)).digest('hex') === parsed.digest
          const shardRows = appendOnly ? [...parsed.rows] : []
          let corrupt = appendOnly ? parsed.corrupt : 0
          const text = bytes.subarray(appendOnly ? parsed.bytes : 0).toString('utf8')
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            readMetrics.linesParsed++
            try {
              const row = JSON.parse(line)
              if (!row || typeof row !== 'object' || Array.isArray(row)) { corrupt++; continue }
              shardRows.push(row)
            } catch { corrupt++ }
          }
          parsed = { signature: s.signature, rows: shardRows, corrupt, bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), endsWithNewline: bytes.length === 0 || bytes[bytes.length - 1] === 10 }
        }
        nextShards.set(s.name, parsed)
        for (const row of parsed.rows) { rows.push(row); if (s.isActive) activeRows.push(row) }
        corruptLines += parsed.corrupt
        files.push(s.name)
      } catch (error) { skippedShards.push({ file: s.name, errorCode: error.code ?? 'READ_FAILED' }) }
    }
    const after = shardInventory()
    if (after.dataVersion !== dataVersion || after.skippedShards.length) skippedShards.push({ file: '.', errorCode: 'SHARDS_CHANGED_DURING_READ' })
    const snapshot = { rows, activeRows, files, corruptLines, skippedShards, dataVersion, readMetrics }
    if (!skippedShards.length) { shardCache = snapshot; parsedShards = nextShards }
    return snapshot
  }

  function snapshotChanges(dataVersion, recurrenceVersion) {
    const changed = []
    const after = shardInventory()
    if (after.dataVersion !== dataVersion || after.skippedShards.length) changed.push({ file: '.', errorCode: 'SHARDS_CHANGED_DURING_READ' })
    try {
      const stat = statSync(recurrenceFile(), { bigint: true })
      if ([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') !== recurrenceVersion) changed.push({ file: 'recurrences.jsonl', errorCode: 'SHARDS_CHANGED_DURING_READ' })
    } catch (error) {
      if (error.code !== 'ENOENT' || recurrenceVersion !== 'missing') changed.push({ file: 'recurrences.jsonl', errorCode: 'SHARDS_CHANGED_DURING_READ' })
    }
    return changed
  }

  /** 把"撤回事件"作用到记录集上：返回仍在生效的行 + 被撤回的行（都带痕迹）。 */
  function applyRetractions(rows) {
    if (retractionCache.has(rows)) return retractionCache.get(rows)
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
    active.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
    const result = { active, retracted, retractions }
    retractionCache.set(rows, result)
    return result
  }

  // 稳定游标（keyset）：把"最新在前"列表里某条记录的 (ts,id) 编成不透明游标；翻页时据此跳过更新的记录。
  function cursorFor(record) {
    return Buffer.from(`${Date.parse(record.ts)}:${record.id}`, 'utf8').toString('base64url')
  }
  function parseCursor(value) {
    if (typeof value !== 'string' || value === '') return null
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8')
      const idx = decoded.indexOf(':')
      if (idx < 0) return null
      const tsMs = Number(decoded.slice(0, idx))
      const id = decoded.slice(idx + 1)
      return Number.isFinite(tsMs) && id ? { tsMs, id } : null
    } catch { return null }
  }
  function query(q = {}) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)
    const needle = (q.q ?? '').toLowerCase()
    // ★ 查询读**全部分片**：一个"查不到"的查询比一个"慢一点"的查询危险得多。
    const { rows, files, corruptLines, skippedShards, dataVersion, readMetrics } = readAllShards()
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
    // 稳定游标要求**全序**：ts 降序 + 相同 ts 再按 id 降序。applyRetractions 只按 ts 排，同毫秒记录的
    // 相对序不定，会让 keyset 游标重/漏；includeRetracted 的合并列表同样需要重排。对非游标（offset）路径
    // 只是把"同毫秒记录"的展示次序定死，不改变跨 ts 的新→旧顺序。
    list = [...list].sort((a, b) => {
      const d = Date.parse(b.ts) - Date.parse(a.ts)
      if (d !== 0) return d
      const ai = String(a.id), bi = String(b.id)
      return ai < bi ? 1 : ai > bi ? -1 : 0
    })
    // 去重窗口里被折叠的重复发生次数挂回到对应记录上（计数不丢，只是不再冒充成独立的失败）
    const recurrence = readRecurrences()
    const recIdx = recurrenceIndex(recurrence.events)
    const skipped = [...skippedShards, ...recurrence.skippedShards, ...snapshotChanges(dataVersion, recurrence.dataVersion)]
    // stable cursor（keyset 分页）：游标锚定上一页最后一条的 (ts,id)，优先于 offset；
    // list 已按 ts 降序，轮转或顶部新增都不会让翻页重复/漏条（offset 在数据变动时会）。
    const cursor = parseCursor(q.cursor)
    let start = offset
    if (cursor) {
      const idx = list.findIndex((r) => {
        const t = Date.parse(r.ts)
        return t < cursor.tsMs || (t === cursor.tsMs && String(r.id) < cursor.id)
      })
      start = idx < 0 ? list.length : idx
    }
    const pageList = list.slice(start, start + limit)
    const page = pageList.map((r) => {
      const hit = recIdx.get(r.id + '\u0000' + String(r.ts))
      return hit ? { ...r, recurrences: hit.count, lastSeenAt: hit.lastTs } : r
    })
    const lastRow = pageList[pageList.length - 1]
    const hasMore = start + pageList.length < list.length
    const out = {
      total: list.length,
      count: pageList.length,
      rows: page,
      nextCursor: hasMore && lastRow ? cursorFor(lastRow) : null,
      hasMore,
      filesScanned: files,
      readMetrics,
      dataVersion: dataVersion + ':' + recurrence.dataVersion,
      incomplete: skipped.length > 0 || corruptLines > 0 || recurrence.corrupt > 0,
      skippedShards: skipped,
      ...(recurrence.corrupt > 0 ? { recurrenceCorruptLines: recurrence.corrupt } : {}),
      retractionsApplied: retractions.length,
      retractedExcluded: includeRetracted ? 0 : retracted.length,
      ...(corruptLines > 0 ? { corruptLines, note: '有 ' + corruptLines + ' 行解析失败被跳过（其余仍可用）' } : {}),
      ...(includeRetracted ? { includeRetracted: true } : {}),
    }
    return structuredClone(out)
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
    return withFileTransaction(activeFile(), () => retractUnlocked({ id, ts, reason, by }))
  }

  function retractUnlocked({ id, ts, reason, by } = {}) {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'id (string) is required' }
    if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason (string) is required —— 撤回必须写明理由' }
    const { rows, skippedShards, corruptLines } = readAllShards()
    if (skippedShards.length || corruptLines) return { ok: false, incomplete: true, skippedShards, corruptLines, error: 'Corpus is incomplete; retraction was not written' }
    const matches = rows.filter((r) => r && r.id === id && r.kind !== 'retraction')
    if (matches.length === 0) {
      return { ok: false, error: '没有找到 id=' + id + ' 的记录（撤回不存在的记录是无效动作，不做）' }
    }
    // ★ F-034：id **不再是全局唯一**（历史数据里已有重复 id 组）。
    //   此时"按 id 撤回"会产生歧义 —— 必须让调用方用 `ts` 指定是哪一条，否则**拒绝**。
    let target = matches[0]
    if (ts !== undefined && !matches.some(row => row.ts === ts)) return { ok: false, error: 'id and ts do not match a stored record', id }
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
    const { rows, activeRows: activeShardRows, files, corruptLines, skippedShards, dataVersion, readMetrics } = readAllShards()
    const { events: recurrenceEvents, corrupt: recurrenceCorrupt, skippedShards: skippedRecurrences, dataVersion: recurrenceVersion } = readRecurrences()
    const version = dataVersion + ':' + recurrenceVersion
    const now = Date.now()
    const changedShards = snapshotChanges(dataVersion, recurrenceVersion)
    const incomplete = skippedShards.length > 0 || skippedRecurrences.length > 0 || changedShards.length > 0 || corruptLines > 0 || recurrenceCorrupt > 0
    if (!incomplete && statsCache?.version === version && now >= statsCache.observedAt && now < statsCache.expiresAt) return structuredClone({ ...statsCache.result, readMetrics })
    const { active, retracted } = applyRetractions(rows)
    // ⚠ 口径（不要改掉，已有测试把它当契约）：`total` / `byClass` / `last7d` / `last30d` **只统计当前活动文件**。
    //   轮转会把旧记录移进 `records-<stamp>.jsonl`，那些**故意**不算进这几项（"活动窗口"语义）。
    //   但"变小了却不说为什么"是缺陷 —— 所以下面**同时**给出全量口径与分片清单，
    //   让调用方能分辨"库里就这么多"与"还有 N 条在归档分片里"（F-032-a）。
    const activeOnly = new Set(activeShardRows)
    const activeRows = active.filter((row) => activeOnly.has(row))
    const archivedRows = active.filter((row) => !activeOnly.has(row))
    const byClass = {}
    for (const cls of FAILURE_CLASSES) byClass[cls] = 0
    for (const r of activeRows) byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1
    const byClassAllShards = {}
    for (const cls of FAILURE_CLASSES) byClassAllShards[cls] = 0
    for (const r of active) byClassAllShards[r.failureClass] = (byClassAllShards[r.failureClass] ?? 0) + 1
    const byClassRetracted = {}
    for (const r of retracted) byClassRetracted[r.failureClass] = (byClassRetracted[r.failureClass] ?? 0) + 1
    let last7d = 0, last30d = 0, expiresAt = Infinity
    for (const row of activeRows) {
      const timestamp = Date.parse(row.ts)
      if (now - timestamp <= 7 * 86400000) { last7d++; expiresAt = Math.min(expiresAt, timestamp + 7 * 86400000 + 1) }
      if (now - timestamp <= 30 * 86400000) { last30d++; expiresAt = Math.min(expiresAt, timestamp + 30 * 86400000 + 1) }
    }
    // 「反复出现」排行：全部分片里未撤回的记录按指纹聚合（老记录没有 fingerprint，现算），
    // 再加上去重窗口折叠掉的 recurrence 次数。一种失败出现 500 次，应该是一行 ×500，而不是 500 行。
    const recIdx = recurrenceIndex(recurrenceEvents)
    const groups = new Map()
    for (const r of active) {
      let fp = r.fingerprint ?? fingerprints.get(r)
      if (fp === undefined) { fp = fingerprintOf(r); fingerprints.set(r, fp) }
      const g = groups.get(fp) ?? { fingerprint: fp, failureClass: r.failureClass, task: r.task, sample: String(r.description ?? '').slice(0, 140), records: 0, recurrences: 0, firstTs: String(r.ts), lastTs: String(r.ts) }
      g.records++
      const hit = recIdx.get(r.id + '\u0000' + String(r.ts))
      if (hit) {
        g.recurrences += hit.count
        if (hit.lastTs > g.lastTs) g.lastTs = hit.lastTs
      }
      if (String(r.ts) < g.firstTs) g.firstTs = String(r.ts)
      if (String(r.ts) > g.lastTs) g.lastTs = String(r.ts)
      groups.set(fp, g)
    }
    const topRecurring = [...groups.values()]
      .map((g) => ({ ...g, occurrences: g.records + g.recurrences }))
      .filter((g) => g.occurrences > 1)
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 5)
    const result = {
      total: activeRows.length, last7d, last30d, byClass, dir,
      // ★ 去重窗口折叠掉的重复发生次数（**不**计入 total / byClass）；明细挂在 query 的 recurrences 字段上
      recurrences: recurrenceEvents.length,
      ...(recurrenceCorrupt > 0 ? { recurrenceCorruptLines: recurrenceCorrupt } : {}),
      topRecurring,
      ...(topRecurring.length > 0
        ? { topRecurringNote: 'topRecurring 按指纹聚合**全部分片**里未撤回的记录 + 被去重折叠的次数；occurrences 越大越可能是同一个根因在反复出现（也可能是测试/脚本在反复制造它 —— 看 producer）。' }
        : {}),
      // ★ 全量口径 + 分片清单：解释"为什么 total 会变小"，而不是让它悄悄变小
      totalAllShards: active.length,
      readMetrics,
      archivedRecords: archivedRows.length,
      byClassAllShards,
      filesScanned: files,
      dataVersion: version,
      incomplete,
      skippedShards: [...skippedShards, ...skippedRecurrences, ...changedShards],
      ...(archivedRows.length > 0
        ? { archivedNote: '另有 ' + archivedRows.length + ' 条在已轮转的分片里（**不计入 total**，但 query 查得到）—— 别把 total 变小读成"库里就这么多"。' }
        : {}),
      // ★ 撤回的**如实报**：既不算进总数，也不藏起来 —— 否则"统计被污染"会变成"统计被悄悄改写"
      retracted: retracted.length,
      ...(retracted.length > 0 ? { byClassRetracted, retractedNote: '有 ' + retracted.length + ' 条已被撤回（已知记错），**没有**计入上面的总数；用 failure_query(includeRetracted=true) 可看到原文' } : {}),
      ...(corruptLines > 0 ? { corruptLines } : {}),
    }
    if (!incomplete) statsCache = { version, observedAt: now, expiresAt, result }
    return structuredClone(result)
  }

  const queryAsync = async (args = {}) => {
    const { value, timing } = await readService.call({ directory: dir, operation: 'query', args: {
      q: args.q, failureClass: args.failureClass, tag: args.tag, fromTs: args.fromTs,
      toTs: args.toTs, limit: args.limit, offset: args.offset, cursor: args.cursor, includeRetracted: args.includeRetracted,
    } })
    return { ...value, timing }
  }
  const statsAsync = async () => {
    const { value, timing } = await readService.call({ directory: dir, operation: 'stats' })
    return { ...value, timing }
  }
  return { record, query, stats, retract, queryAsync, statsAsync, dir }
}
