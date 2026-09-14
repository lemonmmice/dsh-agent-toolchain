// dsh-perf 单测：**报告读取的形状契约**（F-001 回归）
//
// 背景（2026-09-11 真机实测确证）：
//   perf_report 只要有历史记录就**必然**输出「监测失败：未知错误」。
//   根因是**渲染层的判定条件与生产者的返回形状不匹配**：
//     · lib/perf.mjs 的 report() 读的是 perf-probe.ps1 写下的 report.json
//       —— 那是脚本的输出形状（p50Ms/pid/samples/stutters/…），**没有 ok 字段**；
//     · 旧 report() 只补了 `hasRun: true`；
//     · index.js 的渲染层却是 `if (!v.ok) return '监测失败：' + (v.error || '未知错误')`
//     → 一份 20 样本、0 卡顿的正常报告被谎报成「监测失败」，逼 agent 去查不存在的故障。
//
// 这个测试的价值不在"覆盖一行代码"，而在于把 **生产者的真实形状**（不是我们希望的形状）
// 钉进断言：夹具直接复制真实 report.json 的字段，**刻意不含 ok**。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePerf } from '../lib/perf.mjs'
import { renderProbe, renderAnalysis } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-perf-report-'))
const evidenceDir = join(TMP, 'perf-evidence')
mkdirSync(evidenceDir, { recursive: true })

// 真实 report.json 的形状：**没有 ok**（这正是 F-001 的触发条件，必须保留）
const REAL_SHAPE = {
  p50Ms: 0, pid: 10156, durationSec: 6, capture: 'log', maxMs: 9, avgMs: 0,
  samples: 20, startedAt: '2026-09-08 18:13:52', p95Ms: 0,
  evidenceDir, thresholdMs: 500, stutters: [], p99Ms: 0, minMs: 0, stutterCount: 0,
}
const runAt = '2026-09-08T10:13:59.027Z'
writeFileSync(join(evidenceDir, 'report.json'), JSON.stringify(REAL_SHAPE, null, 2), 'utf8')
writeFileSync(join(evidenceDir, 'last-probe.json'),
  JSON.stringify({ at: runAt, reportPath: join(evidenceDir, 'report.json') }, null, 2), 'utf8')

const perf = makePerf({ evidenceDir })

// ------------------------------------------------- 1. F-001 的核心：不得谎报失败
{
  const r = perf.report()
  check('report() 有历史时 hasRun=true', r.hasRun === true, JSON.stringify(r).slice(0, 200))
  check('F-001 回归：report() 必须补 ok（形状与 probe() 对齐）', r.ok === true,
    'ok=' + JSON.stringify(r.ok) + ' keys=' + Object.keys(r).slice(0, 12).join(','))
  check('原始报告字段被完整保留', r.samples === 20 && r.p50Ms === 0 && r.stutterCount === 0, JSON.stringify({ s: r.samples, p50: r.p50Ms, sc: r.stutterCount }))

  const text = renderProbe(r)
  check('F-001 回归：渲染文本**不得**出现「监测失败」', !/监测失败/.test(text), text.slice(0, 200))
  check('渲染出真实样本数与百分位', /20 样本/.test(text) && /P50=0ms/.test(text), text.slice(0, 160))
}

// ------------------------------------------------- 2. 新鲜度：陈旧报告必须自曝年龄（F-005 同类）
{
  const r = perf.report()
  check('report() 回报报告年龄', typeof r.staleHours === 'number' && r.staleHours > 0,
    'staleHours=' + JSON.stringify(r.staleHours) + ' ranAt=' + r.ranAt)
  const text = renderProbe(r)
  check('陈旧报告渲染出「小时前的报告」警告', /小时前的报告/.test(text), text.slice(0, 300))
  check('陈旧警告里有下一步（重跑 perf_probe）', /重跑 perf_probe/.test(text), text.slice(0, 300))
}

// ------------------------------------------------- 3. 没有历史时不得伪装成"读到了空报告"
{
  const empty = makePerf({ evidenceDir: join(TMP, 'nope') })
  const r = empty.report()
  check('无历史 → hasRun=false（由调用方渲染「还没有监测记录」）', r.hasRun === false, JSON.stringify(r))
  check('无历史 → 不带 ok:true（不能冒充成功）', r.ok !== true, JSON.stringify(r))
}

// ------------------------------------------------- 4. 真失败必须给出可操作信息（不是「未知错误」）
{
  const text = renderProbe({ ok: false, clientNotRunning: true, stdout: 'CLIENT_NOT_RUNNING', stderr: '' })
  check('失败渲染含真实原因位', /客户端未运行|原因未回报/.test(text), text.slice(0, 200))
  check('失败渲染含下一步', /下一步/.test(text), text.slice(0, 200))
  check('失败渲染含原始输出尾部', /CLIENT_NOT_RUNNING/.test(text), text.slice(0, 300))
  check('失败渲染**不**出现裸的「未知错误」', !/未知错误/.test(text), text.slice(0, 200))

  const bare = renderProbe({ ok: false })
  check('连 error 都没有时，如实说明"原因未回报"而不是「未知错误」', /原因未回报/.test(bare), bare.slice(0, 200))
}

// ------------------------------------------------- 5. 样本不足要说实话（不伪造度量）
{
  const text = renderProbe({ ok: true, durationSec: 5, samples: 2, p50Ms: 1, p95Ms: 9, p99Ms: 9, maxMs: 9, stutterCount: 0, thresholdMs: 500, evidenceDir })
  check('样本 <5 → 明说 P95/P99 不具统计意义', /不具备统计意义/.test(text), text.slice(0, 300))
}

// ------------------------------------------------- 6. 同源第二处：分析失败不得静默返回空串
{
  check('renderAnalysis(undefined) 出声（旧实现返回空串）', /未产出分析/.test(renderAnalysis(undefined)), JSON.stringify(renderAnalysis(undefined)))
  const f = renderAnalysis({ ok: false, error: 'DumpStack 缺失：X' })
  check('renderAnalysis(ok:false) 出声并带原因', /dump 分析失败/.test(f) && /DumpStack 缺失/.test(f), f.slice(0, 200))
  check('renderAnalysis 成功路径仍正常渲染', /线程数/.test(renderAnalysis({ ok: true, threadCount: 3, uiThread: { managedId: 7, stack: ['A()', 'B()'] }, topLockThreads: [] })), '')
  const noUi = renderAnalysis({ ok: true, threadCount: 3, uiThread: null, topLockThreads: [] })
  check('识别不出 UI 线程时不许说成"没有卡死"', /识别失败本身就是结论|未识别出 UI 线程/.test(noUi), noUi.slice(0, 200))
}

rmSync(TMP, { recursive: true, force: true })

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-perf report-shape（F-001 回归）')
process.exit(failures ? 1 : 0)
