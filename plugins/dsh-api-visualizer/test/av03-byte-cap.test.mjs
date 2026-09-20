// dsh-api-visualizer AV-03 剩余缺口单测：**按字节裁剪保留集**（Claude 第六轮方案 A）
//
// 病：触发看**字节**（physicalBytes > 128MB），裁剪只看**条数**（slice(0, MAX_RECORDS)）—— 两维不一致，
// 于是"整理"可以回收 ≈0 字节：保留集自身 140MB 时，每 5 分钟全量重写一次、字节数纹丝不动、**永不自愈**。
// 只有条数上限时**真实磁盘上界** ≈ 22000 条 × (2×2MB body) ≈ 85.9GB —— 128MB 从来不是"上界"，
// 而是"该整理了"的触发器。
//
// 本单测锁死四件事：
//   1. 裁剪**最旧优先**，最新那条永远在（它是调用方最需要的那条）；
//   2. 双上限（条数 + 字节）各自都能触发，并如实回报是哪个触发的；
//   3. **空转不可能再发生**：裁剪后保留集必须落到触发阈值以下 → 再喂给 shouldCompact 得到 want=false；
//   4. 字节侧也有硬上限旁路（盘要爆时不该等那 5 分钟），且与条数硬上限互不遮蔽。
import {
  shouldCompact, trimToCaps, recordBytes,
  MAX_STORE_BYTES_DEFAULT, BYTE_TRIM_TARGET_RATIO, COMPACT_MIN_INTERVAL_MS,
} from '../lib/compaction.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 造一条大小可控的记录（recBytes 是它落在盘上的字节数）。 */
function rec(i, bodyLen) {
  return { id: 'r' + i, ts: 1700000000000 + i, method: 'GET', url: '/x/' + i, resBody: 'a'.repeat(Math.max(0, bodyLen)) }
}
/** 最新在前（与 store 的 sortNewestFirst 同序）。 */
const newestFirst = (n, bodyLen) => Array.from({ length: n }, (_, k) => rec(n - k, bodyLen))

// ------------------------------------------------- 1. recordBytes 与真实序列化一致
{
  const r = rec(1, 10)
  const expect = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1
  check('recordBytes = JSON.stringify + 换行（与 appendToShards 同一序列化）', recordBytes(r) === expect, JSON.stringify({ got: recordBytes(r), expect }))
  check('recordBytes 对不可序列化对象不抛（返回 0）', (() => {
    const circ = {}; circ.self = circ
    try { return recordBytes(circ) === 0 } catch { return false }
  })())
}

// ------------------------------------------------- 2. 最旧优先 + 最新必留
{
  const maxBytes = 2000
  const list = newestFirst(50, 100) // 每条 ≈140B，共 ≈7KB > 2KB
  const t = trimToCaps(list, { maxRecords: 1000, maxBytes })
  check('字节超限时触发裁剪', t.dropped > 0 && t.truncatedBy === 'max-bytes', JSON.stringify({ dropped: t.dropped, by: t.truncatedBy }))
  check('裁剪后字节 ≤ 预算（0.9×上限）', t.keptBytes <= Math.floor(maxBytes * BYTE_TRIM_TARGET_RATIO), JSON.stringify({ keptBytes: t.keptBytes, budget: Math.floor(maxBytes * BYTE_TRIM_TARGET_RATIO) }))
  check('保留的是**最新**那批（最旧优先丢）', t.keep[0].id === list[0].id && t.keep[t.keep.length - 1].id === list[t.keep.length - 1].id, JSON.stringify({ head: t.keep[0].id, tail: t.keep[t.keep.length - 1].id }))
  check('丢掉的确实是最旧的（tail 之后全没了）', !t.keep.some((r) => r.id === list[list.length - 1].id), JSON.stringify(t.keep.map((r) => r.id).slice(-3)))
  check('keptBytes 与逐条累加一致', t.keptBytes === t.keep.reduce((s, r) => s + recordBytes(r), 0), JSON.stringify(t.keptBytes))
}

// ------------------------------------------------- 3. 条数上限仍然生效，且报告是条数触发的
{
  const list = newestFirst(100, 0) // 很小的记录，字节远没到
  const t = trimToCaps(list, { maxRecords: 10, maxBytes: MAX_STORE_BYTES_DEFAULT })
  check('条数上限照旧（保留 10 条）', t.keep.length === 10 && t.dropped === 90, JSON.stringify({ keep: t.keep.length, dropped: t.dropped }))
  check('报告 truncatedBy=max-records', t.truncatedBy === 'max-records', String(t.truncatedBy))
  check('未超上限时原样保留、不报裁剪', (() => {
    const small = newestFirst(5, 0)
    const s = trimToCaps(small, { maxRecords: 10, maxBytes: MAX_STORE_BYTES_DEFAULT })
    return s.keep.length === 5 && s.dropped === 0 && s.truncatedBy === null
  })())
}

// ------------------------------------------------- 4. 单条自身超预算：至少留 1 条，绝不把库清空
{
  const huge = { id: 'huge', ts: 1, method: 'GET', url: '/huge', resBody: 'a'.repeat(5000) }
  const t = trimToCaps([huge, rec(2, 10)], { maxRecords: 1000, maxBytes: 100 })
  check('单条超预算时仍保留最新那条（空库会被读成"没有请求"）', t.keep.length === 1 && t.keep[0].id === 'huge', JSON.stringify(t.keep.map((r) => r.id)))
  check('空输入不抛', trimToCaps([], { maxBytes: 100 }).keep.length === 0)
  check('非数组入参不抛', trimToCaps(null, {}).keep.length === 0 && trimToCaps(undefined, {}).keep.length === 0)
}

// ------------------------------------------------- 5. **空转不可能再发生**（这条才是本 issue 的正解）
{
  const maxBytes = 100 * 1024 // 100KB（把真实 128MB 等比缩小，结论同构）
  const NOW = 1789000000000
  // 构造"库比触发阈值大一点点"的稳态。为什么要卡在这个带子里：Claude 第六轮给的真实数字是
  // retention 140MB vs 触发 128MB ≈ **1.09×** —— 正好落在 10% 余量带内，
  // 这才是真实世界里那个"每 5 分钟白跑一次全量重写"的形态（远超 1.1× 会被字节硬上限立刻压掉）。
  const big = []
  {
    let b = 0
    let i = 0
    while (b < maxBytes * 1.05) {
      const r = rec(100000 - i, 200)
      b += recordBytes(r)
      big.push(r)
      i++
    }
  }
  const retentionBytes = big.reduce((s, r) => s + recordBytes(r), 0)

  // 5a) 修之前的行为（只有条数裁剪）：字节纹丝不动 → 触发条件**永真**
  const countOnly = big.slice(0, 20000)
  const countOnlyBytes = countOnly.reduce((s, r) => s + recordBytes(r), 0)
  check('病：只按条数裁剪时保留集大小一点没变（且在 1.0×~1.1× 的节流带内）',
    countOnlyBytes === retentionBytes && countOnlyBytes > maxBytes && countOnlyBytes <= maxBytes * 1.1,
    JSON.stringify({ countOnlyBytes, maxBytes, ratio: +(countOnlyBytes / maxBytes).toFixed(3) }))
  const inWindow = shouldCompact({ allCount: countOnly.length, maxRecords: 20000, physicalBytes: countOnlyBytes, maxBytes, now: NOW, lastCompactAt: NOW })
  check('病：节流窗口内被挡下（AV-03 第一版修好的那半）', inWindow.compact === false && inWindow.throttled === true, JSON.stringify(inWindow))
  const spin = shouldCompact({ allCount: countOnly.length, maxRecords: 20000, physicalBytes: countOnlyBytes, maxBytes, now: NOW + COMPACT_MIN_INTERVAL_MS, lastCompactAt: NOW })
  check('病：节流窗口过去后条件**仍然成立** → 每 5 分钟白跑一次全量重写', spin.compact === true && spin.reason === 'physical-bytes', JSON.stringify(spin))

  // 5b) 修之后：按字节裁剪 → 保留集落到 0.9×上限以下 → 再判定 want=false（永不自愈被终结）
  const t = trimToCaps(big, { maxRecords: 20000, maxBytes })
  const after = shouldCompact({ allCount: t.keep.length, maxRecords: 20000, physicalBytes: t.keptBytes, maxBytes, now: NOW + COMPACT_MIN_INTERVAL_MS, lastCompactAt: NOW })
  check('修：裁剪后保留集 ≤ 0.9×上限', t.keptBytes <= maxBytes * BYTE_TRIM_TARGET_RATIO, JSON.stringify({ keptBytes: t.keptBytes, limit: maxBytes * BYTE_TRIM_TARGET_RATIO }))
  check('修：裁剪后 shouldCompact 给 want=false（空转条件不再成立）', after.compact === false && after.throttled === false, JSON.stringify(after))
  check('修：回收的字节是真实可观的数量级（不是 ≈0）', retentionBytes - t.keptBytes > maxBytes * 0.05, JSON.stringify({ before: retentionBytes, after: t.keptBytes }))
}

// ------------------------------------------------- 6. 字节硬上限旁路（不该等 5 分钟）
{
  const maxBytes = 1000
  const NOW = 1789000000000
  const justOver = shouldCompact({ allCount: 1, maxRecords: 20000, physicalBytes: 1050, maxBytes, now: NOW, lastCompactAt: NOW })
  check('刚过阈值（1.05×）→ 落在节流窗口里，throttled（不抖）', justOver.compact === false && justOver.throttled === true, JSON.stringify(justOver))
  const wayOver = shouldCompact({ allCount: 1, maxRecords: 20000, physicalBytes: 1200, maxBytes, now: NOW, lastCompactAt: NOW })
  check('远超阈值（1.2×）→ 立即压缩，旁路节流', wayOver.compact === true && wayOver.reason === 'over-byte-hard-cap', JSON.stringify(wayOver))
  const both = shouldCompact({ allCount: 30000, maxRecords: 20000, physicalBytes: 1200, maxBytes, now: NOW, lastCompactAt: NOW })
  check('条数硬上限与字节硬上限并存时报条数（更根本的那个）', both.reason === 'over-hard-cap', JSON.stringify(both))
  check('两者都没超时 want=false（不产生自我维持的写放大）', shouldCompact({ allCount: 5, physicalBytes: 10, maxBytes, now: NOW, lastCompactAt: NOW }).compact === false)
}

// Host wiring is exercised through the actual module in capture-native-parity.test.mjs.
// Retention behavior is checked there instead of requiring a particular JS helper name.

console.log(failures === 0 ? '\nPASS: dsh-api-visualizer AV-03 按字节裁剪（双上限 + 空转终结）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
