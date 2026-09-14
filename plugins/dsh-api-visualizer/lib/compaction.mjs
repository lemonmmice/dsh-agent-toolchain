/**
 * dsh-api-visualizer compaction — "这次该不该整库重写？"的**纯判定**。
 *
 * 为什么单独成模块：判定逻辑留在 `lib/index.js` 里就 import 不到（那里依赖宿主的
 * `@deepseek-ai/dsh-tools`），等于不可测 —— 而这个判定恰好是 AV-03 的病灶所在。
 * 纯函数也便于把"什么条件下允许重写"直接写成断言，而不是靠读代码相信。
 *
 * AV-03（2026-09-11 审计确证，真机可复现）：原条件是
 *     `all.length > MAX_RECORDS || duplicateAppends >= 200 || physicalBytes > 128MB`
 * 而 `persistAll()` 之后的物理大小 = **保留集**（≤MAX_RECORDS 条）的大小。
 * 一旦保留集本身超过 128MB，这个条件就**永真** → 每 800ms 的 flush 都整库重写一次，
 * 库越大越慢、且永远不会自愈（flush 由定时器驱动 = 持续做上百 MB 的同步 IO）。
 *
 * 修法：**分层**。
 *  · 硬上限（条数，且留 10% 余量防抖动）—— 必须立即执行，否则库无界增长；
 *  · 其余（去重积压、物理体积）—— 最快每 MIN_INTERVAL_MS 一次，因为它们只是"该整理了"，不是"必须立刻"。
 */

export const MAX_RECORDS_DEFAULT = 20000
/** 两次重写的最小间隔。flush 是 800ms 一次，这个下限把写放大压到可控范围。 */
export const COMPACT_MIN_INTERVAL_MS = 5 * 60 * 1000
/** 体积阈值（超过它说明历史 shard 累积了，值得整理）。 */
export const COMPACT_PHYSICAL_BYTES = 128 * 1024 * 1024
/** 去重积压阈值（重复 append 累积到这么多条就该去重了）。 */
export const COMPACT_DUPLICATE_BACKLOG = 200

/**
 * 保留集的**字节上限**（AV-03 剩余缺口，Claude 第六轮给出方案 A）。
 *
 * 为什么必须有它：触发看的是**字节**（`physicalBytes > 128MB`），而裁剪只看**条数**
 * （`slice(0, MAX_RECORDS)`）—— 两个维度不一致，于是"整理"可以回收 ≈0 字节：
 * 保留集自身 140MB 时，每 5 分钟全量重写一次、字节数纹丝不动、**永不自愈**（写放大只是被摊薄了）。
 * 按字节裁剪把触发与裁剪对齐：裁剪后 retention ≤ 0.9×上限 < 触发阈值 → 重写后 `want=false` → 空转不可能再发生。
 *
 * 真实磁盘上界（Claude 算实）：只有条数上限时 ≈ 22000 条 ×(2×2MB body) ≈ **85.9 GB** ——
 * 128MB 从来不是"上界"，而是"该整理了"的触发器。
 *
 * 取值约束：≥ 8×单条上限（单条 = reqBody+resBody ≤ 2×2MB = 4MB → ≥32MB）。
 * 这条约束保证"单条自身就超预算"在构造上不可能出现，因此**最旧优先永远不会被迫丢掉最新那条**。
 */
export const MAX_STORE_BYTES_DEFAULT = 128 * 1024 * 1024
/** 裁剪目标 = 上限 × 0.9：留出 hysteresis，裁剪后必定落到触发阈值以下。 */
export const BYTE_TRIM_TARGET_RATIO = 0.9

/** 单条记录在盘上的字节数（与 appendToShards 的 `JSON.stringify(rec) + '\n'` 同一序列化）。 */
export function recordBytes(rec) {
  try {
    return Buffer.byteLength(JSON.stringify(rec), 'utf8') + 1
  } catch {
    // 不可序列化的记录当作 0 字节：它本来也写不进盘（appendToShards 会抛），
    // 不在这里制造"凭空占满预算"的假象。
    return 0
  }
}

/**
 * 按**双上限**（条数 + 字节）裁剪保留集，**最旧优先丢弃**。
 * @param {Array} recordsNewestFirst 已经按"最新在前"排好的记录
 * @returns {{keep: Array, keptBytes: number, dropped: number, truncatedBy: string|null}}
 *   `keep` 仍是最新在前（调用方按需 reverse）；`truncatedBy` 说明是哪个上限触发的裁剪。
 */
export function trimToCaps(recordsNewestFirst, opts = {}) {
  const maxRecords = Number.isFinite(opts.maxRecords) ? opts.maxRecords : MAX_RECORDS_DEFAULT
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : MAX_STORE_BYTES_DEFAULT
  const budget = Math.floor(maxBytes * BYTE_TRIM_TARGET_RATIO)
  const list = Array.isArray(recordsNewestFirst) ? recordsNewestFirst : []
  const keep = []
  let keptBytes = 0
  let truncatedBy = null
  for (const rec of list) {
    if (keep.length >= maxRecords) { truncatedBy = truncatedBy || 'max-records'; break }
    const sz = recordBytes(rec)
    // `keep.length > 0`：至少留最新那一条。单条超预算时宁可留着它，
    // 也不要让库变成"什么都没有"（调用方会把空库读成"没有请求"）。
    if (keep.length > 0 && keptBytes + sz > budget) { truncatedBy = truncatedBy || 'max-bytes'; break }
    keptBytes += sz
    keep.push(rec)
  }
  return { keep, keptBytes, dropped: list.length - keep.length, truncatedBy }
}

/**
 * 判定是否重写整库。
 * @param {object} s
 * @param {number} s.allCount            当前记录条数
 * @param {number} [s.maxRecords]        条数硬上限
 * @param {number} [s.physicalBytes]     当前磁盘占用
 * @param {number} [s.maxBytes]          保留集字节上限（AV-03 剩余缺口）
 * @param {number} [s.duplicateAppends]  自上次重写以来的重复追加数
 * @param {number} [s.now]               当前时间
 * @param {number} [s.lastCompactAt]     上次重写时间（0 = 从未）
 * @returns {{compact: boolean, reason: string|null, throttled: boolean}}
 *   `throttled: true` 表示"条件成立但被节流挡下"—— 这一个字段让"写放大被抑制"这件事可观测。
 */
export function shouldCompact(s = {}) {
  const maxRecords = Number.isFinite(s.maxRecords) ? s.maxRecords : MAX_RECORDS_DEFAULT
  const maxBytes = Number.isFinite(s.maxBytes) && s.maxBytes > 0 ? s.maxBytes : MAX_STORE_BYTES_DEFAULT
  const allCount = Number(s.allCount) || 0
  const physicalBytes = Number(s.physicalBytes) || 0
  const dup = Number(s.duplicateAppends) || 0
  const now = Number.isFinite(s.now) ? s.now : Date.now()
  const last = Number(s.lastCompactAt) || 0

  // 硬上限：留 10% 余量，避免在阈值上下反复抖动（每次抖动都是一次整库重写）
  const overHardCap = allCount > maxRecords * 1.1
  // AV-03 剩余缺口：字节侧也要有对称的硬上限旁路 —— 盘要被吃爆时不该等那 5 分钟。
  // 注意它和 `overHardCap` 的判据不同：条数硬上限看的是"保留集会不会无界增长"，
  // 字节硬上限看的是"缓冲区会不会无界增长"，两者都可能单独超标。
  const overByteHardCap = physicalBytes > maxBytes * 1.1
  const want = allCount > maxRecords || dup >= COMPACT_DUPLICATE_BACKLOG || physicalBytes > maxBytes
  if (!want) return { compact: false, reason: null, throttled: false }

  const due = now - last >= COMPACT_MIN_INTERVAL_MS
  if (overHardCap) return { compact: true, reason: 'over-hard-cap', throttled: false }
  if (overByteHardCap) return { compact: true, reason: 'over-byte-hard-cap', throttled: false }
  if (!due) return { compact: false, reason: null, throttled: true }
  const reason = dup >= COMPACT_DUPLICATE_BACKLOG ? 'duplicate-backlog'
    : (physicalBytes > maxBytes ? 'physical-bytes' : 'over-cap')
  return { compact: true, reason, throttled: false }
}
