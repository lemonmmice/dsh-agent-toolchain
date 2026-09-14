// dsh-api-visualizer 单测：AV-03 —— 整库重写必须被节流，且"被节流"本身要可观测
//
// 病（审计确证）：`physicalBytes > 128MB` 是状态型条件，而重写后的物理大小 = 保留集大小。
// 保留集自身超过 128MB 时条件**永真** → 800ms 一次的 flush 每次都整库重写。
import { shouldCompact, COMPACT_MIN_INTERVAL_MS, COMPACT_PHYSICAL_BYTES } from '../lib/compaction.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const NOW = 1_800_000_000_000

// ------------------------------------------------- 1. 正常状态：不重写
{
  const r = shouldCompact({ allCount: 100, physicalBytes: 1024, duplicateAppends: 0, now: NOW, lastCompactAt: 0 })
  check('小库不重写', r.compact === false && r.reason === null && r.throttled === false, JSON.stringify(r))
}

// ------------------------------------------------- 2. 核心：体积超阈值时，短时间内不得反复重写
{
  // 第一次：从未重写过 → 允许
  const first = shouldCompact({ allCount: 5000, physicalBytes: COMPACT_PHYSICAL_BYTES + 1, duplicateAppends: 0, now: NOW, lastCompactAt: 0 })
  check('体积超阈值且从未重写 → 执行一次', first.compact === true && first.reason === 'physical-bytes', JSON.stringify(first))

  // 紧接着再来（模拟 800ms 后的下一次 flush）：必须被节流
  const second = shouldCompact({ allCount: 5000, physicalBytes: COMPACT_PHYSICAL_BYTES + 1, duplicateAppends: 0, now: NOW + 800, lastCompactAt: NOW })
  check('AV-03 800ms 后条件仍成立 → **被节流、不重写**（旧实现这里会再重写一次）', second.compact === false, JSON.stringify(second))
  check('AV-03 节流状态可观测（throttled=true）', second.throttled === true, JSON.stringify(second))

  // 超过最小间隔后 → 允许再来一次
  const third = shouldCompact({ allCount: 5000, physicalBytes: COMPACT_PHYSICAL_BYTES + 1, duplicateAppends: 0, now: NOW + COMPACT_MIN_INTERVAL_MS + 1, lastCompactAt: NOW })
  check('超过最小间隔后允许重写一次', third.compact === true, JSON.stringify(third))
}

// ------------------------------------------------- 3. 硬上限**不受节流**（否则库会无界增长）
{
  const over = shouldCompact({ allCount: 30000, physicalBytes: 0, duplicateAppends: 0, now: NOW + 800, lastCompactAt: NOW })
  check('AV-03 条数超硬上限 → 即使刚重写过也立即执行（防无界增长）', over.compact === true && over.reason === 'over-hard-cap', JSON.stringify(over))
  const justOver = shouldCompact({ allCount: 20500, physicalBytes: 0, duplicateAppends: 0, now: NOW + 800, lastCompactAt: NOW })
  check('AV-03 刚过上限但未超 10% 余量 → 走节流（防抖动）', justOver.compact === false && justOver.throttled === true, JSON.stringify(justOver))
}

// ------------------------------------------------- 4. 去重积压
{
  const dup = shouldCompact({ allCount: 100, physicalBytes: 0, duplicateAppends: 200, now: NOW, lastCompactAt: 0 })
  check('去重积压达阈值 → 重写且原因是 duplicate-backlog', dup.compact === true && dup.reason === 'duplicate-backlog', JSON.stringify(dup))
}

// ------------------------------------------------- 5. 边界与坏输入
{
  check('空对象不炸且不重写', shouldCompact().compact === false, JSON.stringify(shouldCompact()))
  check('undefined 不炸', shouldCompact(undefined).compact === false, '')
  check('负数/NaN 当 0 处理', shouldCompact({ allCount: NaN, physicalBytes: -1, duplicateAppends: 'x', now: NaN, lastCompactAt: NaN }).compact === false, '')
  check('正好等于阈值不触发（严格大于）', shouldCompact({ allCount: 20000, physicalBytes: COMPACT_PHYSICAL_BYTES, duplicateAppends: 199, now: NOW, lastCompactAt: 0 }).compact === false, '')
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-api-visualizer compaction（AV-03 写放大节流）')
process.exit(failures ? 1 : 0)
