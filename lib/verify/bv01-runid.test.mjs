// lib/verify 单测：BV-01 —— build/api claim 必须绑定 runId 与仓库
//
// 病（Codex 第二轮独立复现，本机有 live 证据）：
//   `checkBuild(claim)` 只看 claim 自己的 runId；没有就退回全局 `last.json`，
//   且不校验 repoRoot/at → **"今天在 A 仓库宣布编译通过"可以拿 B 仓库昨天的成功日志判 pass**。
//   实测本机 `last.json` 指向的是另一个仓库的构建。
//
// 修法（与同文件既有的 expect.min 反绿洗纪律同源，fail closed）：
//   ① claim.runId 优先，缺省继承**报告级** runId；
//   ② 找不到 per-run 记录 → unverified 并给出可操作修法，**不再**退回 last.json 判 pass；
//   ③ 记录里的 repoRoot 与声明的仓库都能取到且不一致 → unverified（跨仓证据不背书）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeVerificationReport } from './report.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-verify-bv01-'))
const logsDir = join(TMP, 'build-logs')
const verifyDir = join(TMP, 'verify-reports')
mkdirSync(logsDir, { recursive: true })
mkdirSync(verifyDir, { recursive: true })
process.env.DSH_BUILD_LOGS_DIR = logsDir
process.env.DSH_VERIFY_DIR = verifyDir

const REPO_A = 'C:\\work\\repo-a'
const REPO_B = 'C:\\work\\repo-b'

/** 写一份 per-run 构建记录 */
/** 读回落盘报告里的完整裁决（返回值只带 claimsSummary，不含 evidence） */
const readReportClaims = (r) => JSON.parse(readFileSync(r.reportPath, 'utf8')).claims

const writeRun = (runId, rec) => writeFileSync(join(logsDir, 'run-' + runId + '.json'), JSON.stringify(rec, null, 2), 'utf8')

// 模拟"陷阱"：全局 last.json 是**另一个仓库**昨天的成功构建
writeFileSync(join(logsDir, 'last.json'), JSON.stringify({
  hasRun: true, ok: true, target: 'Rebuild', repoRoot: REPO_B,
  logPath: join(logsDir, 'build-old-other-repo.log'), at: '2026-09-10T09:13:25Z',
}, null, 2), 'utf8')

// ------------------------------------------------- 1. 核心：无 per-run 记录时不得用 last.json 判 pass
{
  const r = makeVerificationReport({
    runId: 'bv01-no-perrun', task: '无 per-run 记录', recordFailures: false,
    context: { repo: REPO_A },
    claims: [{ statement: '编译通过', kind: 'build' }],
  })
  check('BV-01 无 per-run 记录 → 不再判 pass（旧实现会被 last.json 骗成 pass）', r.verdict !== 'pass', JSON.stringify({ v: r.verdict, c: r.counts }))
  check('BV-01 判为 unverified（fail closed）', r.counts.unverified === 1 && r.counts.pass === 0, JSON.stringify(r.counts))
  const d = String(r.claims[0].detail || '')
  check('BV-01 说明"不退回 last.json"的理由', /last\.json/.test(d), d.slice(0, 240))
  check('BV-01 给出可操作修法（build_run 带 runId）', /build_run/.test(d) && /runId/.test(d), d.slice(0, 240))
  check('BV-01 证据字段为空（没有虚构证据）', !r.claims[0].evidence || !/other|repo-b/i.test(String(r.claims[0].evidence)), String(r.claims[0].evidence))
}

// ------------------------------------------------- 2. 有 per-run 记录且仓库一致 → pass
{
  writeRun('bv01-ok', { hasRun: true, ok: true, target: 'Rebuild', repoRoot: REPO_A, logPath: join(logsDir, 'a.log') })
  const r = makeVerificationReport({
    runId: 'bv01-ok', task: '有记录', recordFailures: false, context: { repo: REPO_A },
    claims: [{ statement: '编译通过', kind: 'build' }],
  })
  check('BV-01 继承报告级 runId 命中 per-run 记录 → pass', r.verdict === 'pass', JSON.stringify({ v: r.verdict, d: r.claims[0].detail }))
  check('BV-01 证据指向本次的日志', /a\.log/.test(String(readReportClaims(r)[0].evidence)), String(readReportClaims(r)[0].evidence))
}

// ------------------------------------------------- 3. 跨仓证据 → unverified
{
  // 报告级 runId=R，但那份记录属于别的仓库
  writeRun('bv01-crossrepo', { hasRun: true, ok: true, target: 'Rebuild', repoRoot: REPO_B, logPath: join(logsDir, 'b.log') })
  const r = makeVerificationReport({
    runId: 'bv01-crossrepo', task: '跨仓', recordFailures: false, context: { repo: REPO_A },
    claims: [{ statement: '编译通过', kind: 'build' }],
  })
  check('BV-01 记录属于别的仓库 → 不判 pass', r.verdict !== 'pass', JSON.stringify({ v: r.verdict, d: r.claims[0].detail }))
  check('BV-01 跨仓时点名两个仓库', /another repo/i.test(String(r.claims[0].detail)), String(r.claims[0].detail).slice(0, 240))
}

// ------------------------------------------------- 4. 失败记录必须判 fail（不能因为改动而不再报失败）
{
  writeRun('bv01-fail', { hasRun: true, ok: false, target: 'Build', repoRoot: REPO_A, logPath: join(logsDir, 'f.log') })
  const r = makeVerificationReport({
    runId: 'bv01-fail', task: '失败构建', recordFailures: false, context: { repo: REPO_A },
    claims: [{ statement: '编译通过', kind: 'build' }],
  })
  check('BV-01 本次构建失败 → 判 fail（不因收敛而放过）', r.verdict === 'fail' && r.counts.fail === 1, JSON.stringify({ v: r.verdict, c: r.counts }))
}

// ------------------------------------------------- 5. claim 级 runId 优先于报告级
{
  writeRun('claim-level', { hasRun: true, ok: true, target: 'Rebuild', repoRoot: REPO_A, logPath: join(logsDir, 'c.log') })
  const r = makeVerificationReport({
    runId: 'report-level', task: 'claim 级覆盖', recordFailures: false, context: { repo: REPO_A },
    claims: [{ statement: '编译通过', kind: 'build', runId: 'claim-level' }],
  })
  check('BV-01 claim 级 runId 优先（能命中 claim-level 的记录）', r.verdict === 'pass' && /c\.log/.test(String(readReportClaims(r)[0].evidence)), JSON.stringify({ v: r.verdict, e: readReportClaims(r)[0].evidence }))
}

// ------------------------------------------------- 6. 没有声明仓库时不做跨仓判断（不能误杀）
{
  writeRun('bv01-norepo', { hasRun: true, ok: true, target: 'Rebuild', logPath: join(logsDir, 'n.log') })
  const r = makeVerificationReport({
    runId: 'bv01-norepo', task: '无仓库声明', recordFailures: false,
    claims: [{ statement: '编译通过', kind: 'build' }],
  })
  check('BV-01 双方都报不出仓库时不做跨仓判断（不误杀）', r.verdict === 'pass', JSON.stringify({ v: r.verdict, d: r.claims[0].detail }))
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: verify_report BV-01（claim ↔ runId/仓库 绑定，fail closed）')
process.exit(failures ? 1 : 0)
