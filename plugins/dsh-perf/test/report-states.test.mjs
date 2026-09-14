// dsh-perf `perf_report` 的四种状态（F-030，2026-09-12 r30，**读代码发现**）。
//
// 病：旧实现把所有异常都吞成 `{hasRun:false}`（渲染成"还没有监测记录"），而它有四种截然不同的成因。
// 其中最容易被读反的一种：`last-probe.json` 记着一次运行，但**它指向的 report.json 已被清理/移动**
// ⇒ 工具说"没跑过"，真相是"**跑过、报告没了**"——**"没读到" 被说成了 "没有"**。
//
// ⚠ 更正（同轮复核后）：我最初以为**本机此刻就是这个状态**，依据是非递归目录列表只看到 `last-probe.json`；
//   核对后发现报告在**子目录**里、一直都在，那条"真机复现"是误判，**已撤回**。
//   本文件用**临时证据目录**逐条构造这四种状态来验证 —— 这才是本条的真正依据。
import { makePerf } from '../lib/perf.mjs'
import { renderReport } from '../lib/render.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const ok = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

const dir = mkdtempSync(join(tmpdir(), 'perf-report-'))
const perf = makePerf({ evidenceDir: dir, procName: 'perfselfcheck' })
const pointer = join(dir, 'last-probe.json')

// ① 从没跑过：指针文件都不存在
{
  const r = perf.report()
  ok('① 没指针文件 ⇒ hasRun=false + reason=never-ran', r.hasRun === false && r.reason === 'never-ran', JSON.stringify(r).slice(0, 160))
  const t = renderReport(r)
  ok('① 渲染明确说"确实没跑过"并给下一步', /确实没跑过/.test(t) && /perf_probe/.test(t), t.slice(0, 140))
}

// ② ★ 跑过、但报告文件没了（真机复现的那个状态）
{
  const gone = join(dir, '20260911-999999', 'report.json')
  writeFileSync(pointer, JSON.stringify({ at: new Date(Date.now() - 3600000).toISOString(), reportPath: gone }), 'utf8')
  const r = perf.report()
  ok('★ 指针在、报告不在 ⇒ hasRun=true + ok=false + reason=report-missing',
    r.hasRun === true && r.ok === false && r.reason === 'report-missing', JSON.stringify(r).slice(0, 200))
  ok('★ 文案说明"跑过监测"，并**明确否定**"没跑过/没卡顿"',
    /\*\*跑过\*\*监测/.test(String(r.error)) && /不是\*\*"没有跑过监测"/.test(String(r.error)),
    String(r.error).slice(0, 200))
  ok('★ 带出记录时间与报告路径（可核对）', typeof r.ranAt === 'string' && r.reportPath === gone,
    JSON.stringify({ ranAt: r.ranAt, reportPath: r.reportPath }))
  const t = renderReport(r)
  ok('★ 渲染层不写"还没有监测记录"，而是打出路径与下一步',
    !/还没有监测记录/.test(t) && t.includes(gone) && /重跑 perf_probe/.test(t), t.slice(0, 200))
}

// ③ 指针文件损坏
{
  writeFileSync(pointer, '{ 这不是 JSON', 'utf8')
  const r = perf.report()
  ok('③ 指针损坏 ⇒ reason=pointer-unreadable（不说"没跑过"）', r.reason === 'pointer-unreadable', JSON.stringify(r).slice(0, 160))
  ok('③ 文案点明"这不等于没跑过"', /不等于"没跑过"/.test(String(r.error)), String(r.error).slice(0, 160))
}

// ④ 报告文件存在但内容坏
{
  const bad = join(dir, 'bad-report.json')
  writeFileSync(bad, 'not json', 'utf8')
  writeFileSync(pointer, JSON.stringify({ at: new Date().toISOString(), reportPath: bad }), 'utf8')
  const r = perf.report()
  ok('④ 报告损坏 ⇒ reason=report-corrupt 且说明"不等于没有卡顿"',
    r.reason === 'report-corrupt' && /不等于"没有卡顿"/.test(String(r.error)), JSON.stringify(r).slice(0, 180))
}

// ⑤ 正常：指针 + 报告都在 ⇒ ok，且新鲜度/口径都在
{
  const goodDir = join(dir, 'good'); mkdirSync(goodDir, { recursive: true })
  const good = join(goodDir, 'report.json')
  writeFileSync(good, JSON.stringify({ seconds: 30, samples: 42, p50Ms: 0, p95Ms: 12, p99Ms: 260, maxMs: 500, stutters: 3 }), 'utf8')
  writeFileSync(pointer, JSON.stringify({ at: new Date(Date.now() - 120000).toISOString(), reportPath: good }), 'utf8')
  const r = perf.report()
  ok('⑤ 正常路径仍 ok=true 且字段透传', r.ok === true && r.hasRun === true && r.samples === 42, JSON.stringify(r).slice(0, 200))
  ok('⑤ 新鲜度与测量口径仍在（没被这次改写弄丢）',
    typeof r.ageMs === 'number' && typeof r.staleHours === 'number' && r.measurementScope !== undefined,
    JSON.stringify({ ageMs: r.ageMs, staleHours: r.staleHours, hasScope: r.measurementScope !== undefined }))
  const t = renderReport(r)
  ok('⑤ 渲染走原路径（含样本量与口径说明）', /报告时间|小时前的报告/.test(t), t.slice(0, 120))
}

rmSync(dir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nPERF-REPORT STATES TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nPERF-REPORT STATES TEST PASSED')
