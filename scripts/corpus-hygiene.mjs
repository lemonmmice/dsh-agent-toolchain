#!/usr/bin/env node
/**
 * 失败库卫生：把"闸门按设计拒绝 / 目标未配置"被误记成 tool-error 的历史记录撤回。
 *
 * 背景（2026-10 真库复盘）：811 条 tool-error 里约 94% 是三种签名，248 组「3 条 / 2 秒」的突发，
 * 基本由 plugins/dsh-ui-drive/test/mcp-snapshot-gate.test.mjs 每跑一次写进真库。现在
 *   ① 测试运行器给每个测试独立的临时失败库（scripts/run-tests.mjs「测试硬闸二」）；
 *   ② 闸门拒绝 / 未配置不再自动记录（plugins/dsh-ui-drive/lib/refusal.mjs）。
 * 这个脚本处理**已经写进去的**那部分。撤回是 append-only：原文保留、可审计，只是不再计入统计。
 *
 * 用法：
 *   node scripts/corpus-hygiene.mjs                 # 演练（默认）：只列出会撤回哪些
 *   node scripts/corpus-hygiene.mjs --apply         # 真的追加撤回事件
 *   node scripts/corpus-hygiene.mjs --dir <path>    # 指定失败库目录（默认 DSH_FAILURE_CORPUS_DIR / ~/.dsh-agent-toolchain/failure-corpus）
 */
import { makeFailureCorpus } from '../lib/failure-corpus.mjs'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dirIdx = argv.indexOf('--dir')
const dir = dirIdx >= 0 ? argv[dirIdx + 1] : undefined

/** 只认这几种**已核实**的签名；拿不准的一律不动。 */
const SIGNATURES = [
  { key: 'unknown-snapshot', tasks: ['ui_drive', 'ui_act', 'ui_jev'], re: /未知 snapshotId（无法解析或从未签发）：拒绝执行/,
    why: '快照新鲜度门按设计拒绝（未知 snapshotId），不是工具失灵' },
  { key: 'unconfigured-target', tasks: ['ui_drive', 'ui_act'], re: /未配置目标进程/,
    why: '目标进程未配置是环境状态（toolchain_status 已如实报告），不是工具失灵' },
  { key: 'get-process-null-name', tasks: ['ui_drive'], re: /Get-Process : 无法对参数.Name.执行参数验证/,
    why: '未配置目标进程时旧版脚本漏出的原始 PowerShell 报错（同日已修成"未配置目标进程"），同属环境状态' },
]
const SOURCE_NOTE = '2026-10 复盘查明这批记录基本由 plugins/dsh-ui-drive/test/mcp-snapshot-gate.test.mjs 每次运行写入真库（现已隔离）；且此类失败现已不再自动记录。'

const corpus = makeFailureCorpus(dir ? { dir } : {})
const rows = []
for (let offset = 0; ; offset += 500) {
  const page = corpus.query({ failureClass: 'tool-error', limit: 500, offset })
  rows.push(...page.rows)
  if (page.rows.length < 500) break
}

const plan = []
for (const r of rows) {
  if (!Array.isArray(r.tags) || !r.tags.includes('auto')) continue // 手工记录一律不动
  const sig = SIGNATURES.find((s) => s.tasks.includes(r.task) && s.re.test(String(r.description ?? '')))
  if (sig) plan.push({ r, sig })
}

const bySig = {}
for (const { r, sig } of plan) {
  const g = (bySig[sig.key] ??= { count: 0, first: r.ts, last: r.ts })
  g.count++
  if (r.ts < g.first) g.first = r.ts
  if (r.ts > g.last) g.last = r.ts
}
console.log(`失败库：${corpus.dir}`)
console.log(`活动的 tool-error 共 ${rows.length} 条；匹配到 ${plan.length} 条可撤回：`)
for (const s of SIGNATURES) {
  const g = bySig[s.key]
  console.log(`  ${s.key.padEnd(22)} ${String(g ? g.count : 0).padStart(4)} 条` + (g ? `  ${g.first.slice(0, 10)} → ${g.last.slice(0, 10)}` : ''))
}

if (!apply) {
  console.log('\n（演练模式，没有写入任何东西。确认后加 --apply 追加撤回事件；原文保留、可用 failure_query includeRetracted=true 查看。）')
  process.exit(0)
}

let done = 0
let failed = 0
for (const { r, sig } of plan) {
  const res = corpus.retract({ id: r.id, ts: r.ts, reason: sig.why + '。' + SOURCE_NOTE, by: 'scripts/corpus-hygiene.mjs' })
  if (res.ok) done++
  else failed++
}
console.log(`\n已撤回 ${done} 条` + (failed ? `，${failed} 条未撤回（多为已撤回过）` : ''))
process.exit(failed > 0 && done === 0 ? 1 : 0)
