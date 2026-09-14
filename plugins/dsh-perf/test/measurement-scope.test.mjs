// dsh-perf renderProbe 测量口径测试（Claude 第九轮 Q3：探针结果不能外推）。
//
// 背景（本机标定，bench-runs/dbg-20260911/perf-probe-calibrate.ps1）：
//   · UI 线程阻塞 2000ms → 4/4 命中；500ms → 部分命中（阈值恰好取 500ms 时 1/10）；300ms → 部分；120ms → 1/5
//   · **后台线程**阻塞 2000ms → 命中 0 次、max 仅 8~9ms（与空闲无异）
//   · 以上所有情况下 **P50 恒为 0ms**
// 于是「0 次卡顿」「P50=0ms」「阈值 300ms 也没测到」这三种读数都会被误读成"客户端很流畅"。
// 渲染层与数据层都必须把口径说清楚 —— 这条测试锁死它。
import { renderProbe } from '../lib/render.mjs'
import { makePerf } from '../lib/perf.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const base = {
  ok: true, durationSec: 12, samples: 42, p50Ms: 0, p95Ms: 8, p99Ms: 1969, maxMs: 2008,
  stutterCount: 4, thresholdMs: 500, evidenceDir: 'C:\\ev\\x',
  measurementScope: {
    what: '只测 UI 线程消息泵响应',
    blind: ['非 UI 线程的卡顿完全测不到', '阻塞落在两次采样之间会错过'],
    reliableFloorMs: 500,
    calibration: 'UI 2000ms → 4/4 …',
    tuning: '阈值用 200~300ms，intervalMs 用 100~150ms',
  },
}

// ------------------------------------------------- 1. 有卡顿时：口径、P50 说明、盲区都必须印出来
{
  const t = renderProbe(base)
  check('印出测量口径', /测量口径：/.test(t), t.slice(0, 200))
  check('明说 P50=0 是正常读数（别读成没卡顿）', /P50=0ms 是\*\*正常读数\*\*/.test(t) && /别把 P50=0 读成「没卡顿」/.test(t), t.slice(0, 400))
  check('明说非 UI 线程测不到', /非 UI 线程的卡顿完全测不到/.test(t), t.slice(0, 600))
  check('给出调参建议', /调参建议：/.test(t) && /200~300ms/.test(t), t.slice(0, 600))
  check('原有数字仍完整（不因加口径而丢字段）', /监测 12s：42 样本/.test(t) && /卡顿事件 4 次/.test(t) && /C:\\ev\\x/.test(t), t.slice(0, 200))
}

// ------------------------------------------------- 2. 0 卡顿：最强歧义点，必须显式反误读
{
  const t = renderProbe({ ...base, stutterCount: 0, stutters: [], maxMs: 9, p99Ms: 9 })
  check('0 卡顿时明说"不等于客户端流畅"', /\*\*0 次卡顿\*\*/.test(t) && /不等于客户端流畅/.test(t), t.slice(0, 500))
  check('0 卡顿时给出反例数字（后台阻塞 2000ms 也测不到）', /命中 0 次/.test(t), t.slice(0, 600))
}

// ------------------------------------------------- 3. 阈值低于可靠下限：明确警告，别当结论
{
  const t = renderProbe({ ...base, thresholdMs: 300, stutterCount: 0 })
  check('阈值 300ms 时警告低于可靠下限', /低于本方法的\*\*可靠下限/.test(t), t.slice(0, 700))
  check('警告里说清"不能用来下没有卡顿的结论"', /不能用来下「没有卡顿」的结论/.test(t), t.slice(0, 700))
  const t2 = renderProbe({ ...base, thresholdMs: 500 })
  check('阈值等于下限时不误报该警告', !/低于本方法的\*\*可靠下限/.test(t2), t2.slice(0, 300))
}

// ------------------------------------------------- 4. 数据层同样带口径（MCP 面走 jtext，看不到渲染文本）
{
  const p = makePerf({ procName: 'X', evidenceDir: 'C:\\ev', scriptsDir: 'C:\\nonexistent-scripts-dir' })
  // 未跑过 → hasRun:false；这里只验"口径常量本身在模块里、且会随 probe/report 一起返回"
  const r = p.report()
  check('report() 对未跑过的情况仍返回 hasRun:false（不抛）', r && r.hasRun === false, JSON.stringify(r))
  const src = (await import('node:fs')).readFileSync(new URL('../lib/perf.mjs', import.meta.url), 'utf8')
  check('probe() 返回值带 measurementScope', /return \{ ok: true, \.\.\.report, measurementScope: MEASUREMENT_SCOPE \}/.test(src))
  check('report() 返回值带 measurementScope', /measurementScope: MEASUREMENT_SCOPE/.test(src.split('function report()')[1] || ''))
  check('口径里含盲区与可靠下限（结构化字段，不只是散文）', /reliableFloorMs: 500/.test(src) && /blind: \[/.test(src))
}

// ------------------------------------------------- 5. 缺 measurementScope 时不许炸（老报告/半形状）
{
  const t = renderProbe({ ...base, measurementScope: undefined })
  check('没有 measurementScope 也能渲染（回退口径文案）', /测量口径：/.test(t) && /监测 12s/.test(t), t.slice(0, 200))
  const t2 = renderProbe({ ...base, p50Ms: 3 })
  check('P50≠0 时不打印 P50 说明', !/P50=0ms 是/.test(t2), t2.slice(0, 200))
}

console.log(failures === 0 ? '\nPASS: dsh-perf 测量口径（Q3）测试' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
