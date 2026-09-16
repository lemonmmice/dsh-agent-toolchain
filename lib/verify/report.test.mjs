// lib/verify/report.test.mjs — verification-report self-test:
// evidence adjudication (build/api/file/manual), verdicts, auto-record of
// agent-misjudge, runId sanitize, opt-out. Temp dirs only, no network.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeVerificationReport, sanitizeRunId, adjudicateClaim } from './report.mjs'
import { makeFailureCorpus } from '../failure-corpus.mjs'
import { appendRecords } from '../capture-store.mjs'

const reportsDir = mkdtempSync(join(tmpdir(), 'verify-'))
const corpusDir = mkdtempSync(join(tmpdir(), 'verify-corpus-'))
const logsDir = mkdtempSync(join(tmpdir(), 'verify-logs-'))
const captureDir = mkdtempSync(join(tmpdir(), 'verify-cap-'))
process.env.DSH_VERIFY_DIR = reportsDir
process.env.DSH_FAILURE_CORPUS_DIR = corpusDir
process.env.DSH_BUILD_LOGS_DIR = logsDir
process.env.DSH_API_CAPTURE_STORE = captureDir

// seed evidence: build records + capture records
mkdirSync(logsDir, { recursive: true })
writeFileSync(join(logsDir, 'run-pass.json'), JSON.stringify({ ok: true, target: 'Build', logPath: 'build-pass.log' }))
writeFileSync(join(logsDir, 'run-fail.json'), JSON.stringify({ ok: false, target: 'Build', errorCount: 2, codeErrorCount: 2, logPath: 'build-fail.log' }))
const base = Date.now()
appendRecords([
  { id: 'c1', ts: base, method: 'GET', url: 'https://api.example.com/v1/ok', status: 200 },
  { id: 'c2', ts: base + 100, method: 'GET', url: 'https://api.example.com/v1/bad', status: 500 },
], { runId: 'api-run' })

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}
const throws = (fn, msg) => {
  try {
    fn()
    failures++
    console.error('  FAIL - ' + msg + ' (did not throw)')
  } catch {
    console.log('  ok - ' + msg + ' (rejected)')
  }
}

// ---- kind=build: adjudicated from the build record, not self-rated
const b1 = makeVerificationReport({
  runId: 'build-pass-case',
  task: 't1',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'pass' }],
})
ok(b1.verdict === 'pass' && b1.recorded === 0, 'build claim adjudicated pass from build record')

const b2 = makeVerificationReport({
  runId: 'build-fail-case',
  task: 't2',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'fail' }],
})
ok(b2.verdict === 'fail' && b2.mismatchCount === 1 && b2.recorded === 1, 'build claim adjudicated fail -> verdict fail + auto-record')

const b3 = makeVerificationReport({
  runId: 'build-missing-case',
  task: 't3',
  claims: [{ statement: 'build passes', kind: 'build', runId: 'no-such-run' }],
})
ok(b3.verdict === 'incomplete', 'missing build record -> unverified -> incomplete')

// ---- kind=api: adjudicated from the capture store
const a1 = makeVerificationReport({
  runId: 'api-2xx-case',
  task: 't4',
  claims: [{ statement: 'the page fires the API', kind: 'api', runId: 'api-run', filter: { host: 'api.example.com' }, expect: { min: 1, all2xx: true } }],
})
ok(a1.verdict === 'fail' && a1.mismatchCount === 1 && a1.recorded === 1, 'api claim with a 500 in evidence -> fail + auto-record')

const a2 = makeVerificationReport({
  runId: 'api-min-case',
  task: 't5',
  claims: [{ statement: 'the page fires the API', kind: 'api', runId: 'api-run', filter: { host: 'api.example.com' }, expect: { min: 2 } }],
})
ok(a2.verdict === 'pass', 'api claim min=2 matches -> pass')

const a3 = makeVerificationReport({
  runId: 'api-no-match-case',
  task: 't6',
  claims: [{ statement: 'the page fires a ghost API', kind: 'api', runId: 'api-run', filter: { host: 'ghost.example.com' } }],
})
ok(a3.verdict === 'fail' && a3.recorded === 1, 'no match while store has records -> contradiction -> fail')

const emptyCap = mkdtempSync(join(tmpdir(), 'verify-cap-empty-'))
process.env.DSH_API_CAPTURE_STORE = emptyCap
const a4 = makeVerificationReport({
  runId: 'api-empty-case',
  task: 't7',
  claims: [{ statement: 'the page fires an API', kind: 'api', filter: { host: 'x.example.com' } }],
})
ok(a4.verdict === 'incomplete' && a4.mismatchCount === 0, 'empty capture store -> unverified, not a contradiction')
process.env.DSH_API_CAPTURE_STORE = captureDir

// ---- kind=file
const artifact = join(reportsDir, 'shot.png')
writeFileSync(artifact, 'fake')
const f1 = makeVerificationReport({
  runId: 'file-case',
  task: 't8',
  claims: [
    { statement: 'screenshot exists', kind: 'file', path: artifact },
    { statement: 'log exists', kind: 'file', path: join(reportsDir, 'nope.log') },
  ],
})
ok(f1.verdict === 'fail' && f1.counts.pass === 1 && f1.counts.fail === 1, 'file check: exists=pass, missing=fail')

// ---- kind=manual: explicit opt-out (backwards compatible with old shape)
const m1 = makeVerificationReport({
  runId: 'manual-case',
  task: 't9',
  claims: [{ statement: 'visual check', status: 'fail', evidence: 'human says no' }],
})
ok(m1.verdict === 'fail' && m1.recorded === 1, 'manual claim (legacy shape) still adjudicates + records')

const m2 = makeVerificationReport({
  runId: 'manual-optout-case',
  task: 't10',
  claims: [{ statement: 'x', status: 'fail' }],
  recordFailures: false,
})
ok(m2.recorded === 0 && m2.mismatchCount === 1, 'recordFailures=false opt-out works')

// ---- kind=git / kind=gate (offline cases)
const gitRepo = mkdtempSync(join(tmpdir(), 'verify-git-'))
execFileSync('git', ['init', '-q', gitRepo])
writeFileSync(join(gitRepo, 'a.txt'), 'x')
execFileSync('git', ['-C', gitRepo, 'add', '-A'])
execFileSync('git', ['-C', gitRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

const g1 = makeVerificationReport({
  runId: 'git-clean-case',
  task: 't11',
  claims: [{ statement: 'working tree clean', kind: 'git', repo: gitRepo, check: 'clean' }],
})
ok(g1.verdict === 'pass', 'git clean check -> pass')

writeFileSync(join(gitRepo, 'b.txt'), 'dirty')
const g2 = makeVerificationReport({
  runId: 'git-dirty-case',
  task: 't12',
  claims: [{ statement: 'working tree clean', kind: 'git', repo: gitRepo, check: 'clean' }],
})
ok(g2.verdict === 'fail' && g2.recorded === 1, 'dirty tree -> fail + auto-record')

const g3 = makeVerificationReport({
  runId: 'git-pushed-no-remote-case',
  task: 't13',
  claims: [{ statement: 'pushed', kind: 'git', repo: gitRepo, check: 'pushed' }],
})
ok(g3.verdict === 'incomplete' && g3.mismatchCount === 0, 'pushed check without remote -> unverified, not a contradiction')

const ga1 = makeVerificationReport({
  runId: 'gate-pass-case',
  task: 't14',
  claims: [{ statement: 'sanity gate green', kind: 'gate', cmd: 'node -e "process.exit(0)"' }],
})
ok(ga1.verdict === 'pass', 'gate exit 0 -> pass')

const ga2 = makeVerificationReport({
  runId: 'gate-fail-case',
  task: 't15',
  claims: [{ statement: 'sanity gate green', kind: 'gate', cmd: 'node -e "process.exit(1)"' }],
})
ok(ga2.verdict === 'fail' && ga2.recorded === 1, 'gate exit 1 -> fail + auto-record')

// vacuous gates: exit 0 with zero tests executed must NOT pass
const ga3 = makeVerificationReport({
  runId: 'gate-vacuous-en',
  task: 'gate vacuous en',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('No test matches the given testcase filter.')\"" }],
  recordFailures: false,
})
ok(ga3.verdict === 'fail' && ga3.counts.fail === 1, 'gate exit 0 + no-test-match -> fail')
const ga4 = makeVerificationReport({
  runId: 'gate-vacuous-cn',
  task: 'gate vacuous cn',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('已通过! - 失败: 0，通过: 0，总计: 0')\"" }],
  recordFailures: false,
})
ok(ga4.verdict === 'fail', 'gate exit 0 + 0/0 CN summary -> fail')
const ga5 = makeVerificationReport({
  runId: 'gate-real-pass',
  task: 'gate real pass',
  claims: [{ statement: 'tests pass', kind: 'gate', cmd: "node -e \"console.log('Passed! - Failed: 0, Passed: 4, Skipped: 0, Total: 4')\"" }],
  recordFailures: false,
})
ok(ga5.verdict === 'pass' && ga5.counts.pass === 1, 'gate exit 0 + real test counts -> still pass')

// vacuous detail: names the matched pattern + keeps the full failure tail
const vacDetail = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('Running tests...\\nNo test matches the given testcase filter: Foo.Bar\\nDone.')\"" })
ok(vacDetail.status === 'fail' && vacDetail.detail.includes('no-test-matches (EN)') && vacDetail.detail.includes('Foo.Bar'), 'vacuous gate detail names the pattern and keeps the tail')
// real failure detail: the 6-line tail shows the failing assertion
const failDetail = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('L1\\nL2\\nL3\\nL4\\nL5\\nAssertion failed: expected 2 got 3'); process.exit(1)\"" })
ok(failDetail.status === 'fail' && failDetail.detail.includes('Assertion failed'), 'real gate failure keeps the failing line in the tail')

// .NET "no tests discovered" wordings must also be vacuous-fail
const vacDotnet = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('No test is available in the specified test containers.')\"" })
ok(vacDotnet.status === 'fail' && vacDotnet.detail.includes('no-tests-in-containers'), 'dotnet no-test-containers wording -> vacuous fail')
const vacRun0 = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('Tests run: 0')\"" })
ok(vacRun0.status === 'fail', 'Tests run: 0 -> vacuous fail')
const vacOk0 = adjudicateClaim({ kind: 'gate', cmd: "node -e \"console.log('OK (0 tests)')\"" })
ok(vacOk0.status === 'fail', 'OK (0 tests) -> vacuous fail')

// api anti-green-wash: expect.min < 1 must not certify pass with zero evidence
const apiMin0 = adjudicateClaim({ kind: 'api', expect: { min: 0 } })
ok(apiMin0.status !== 'pass', 'api expect.min=0 -> never pass (anti-green-wash)')
const apiMinNeg = adjudicateClaim({ kind: 'api', expect: { min: -2 } })
ok(apiMinNeg.status !== 'pass', 'api expect.min negative -> never pass')

// ---- misc
ok(sanitizeRunId('a\\b/c:d') === 'a_b_c_d', 'sanitizeRunId strips separators')
throws(() => makeVerificationReport({}), 'missing runId/task rejected')

const corpus = makeFailureCorpus({})
const auto = corpus.query({ q: 'claim contradicted by evidence' })
ok(auto.total >= 3, 'adjudicated mismatches auto-recorded as agent-misjudge')
ok(auto.rows.every((r) => r.failureClass === 'agent-misjudge' && r.tags.includes('auto')), 'auto records carry class + tag')

const saved = JSON.parse(readFileSync(join(reportsDir, 'build-fail-case.json'), 'utf8'))
ok(saved.verdict === 'fail' && saved.claims[0].status === 'fail' && saved.claims[0].check === 'build' && typeof saved.claims[0].detail === 'string', 'report JSON carries adjudication detail')

rmSync(reportsDir, { recursive: true, force: true })
rmSync(corpusDir, { recursive: true, force: true })
rmSync(logsDir, { recursive: true, force: true })
rmSync(captureDir, { recursive: true, force: true })
rmSync(emptyCap, { recursive: true, force: true })
rmSync(gitRepo, { recursive: true, force: true })
delete process.env.DSH_VERIFY_DIR
delete process.env.DSH_FAILURE_CORPUS_DIR
// ---------------------------------------------------------------- 空声明 ≠ 验证通过
// 实测（2026-09-12）：`claims: []` 原先得到 `verdict: "pass"`（counts 全 0），而且照样落盘一份
// `verify-reports/<runId>.json` 写着 pass —— "什么都不声明"就能拿到"验证通过"的凭证。
// 这正是"没读到 → 没问题"，只是落在**裁决本身**上；而交接纪律依赖"总结 = claims + verdict"。
{
  const empty = makeVerificationReport({ runId: 'empty-claims-regression', task: '空声明', claims: [] })
  ok(empty.verdict === 'incomplete', '★ claims 为空 → verdict 必须是 incomplete（不是 pass）；实际=' + String(empty.verdict))
  const saved = JSON.parse(readFileSync(empty.reportPath, 'utf8'))
  ok(typeof saved.note === 'string' && /不等于验证通过/.test(saved.note),
    '★ 落盘的报告里写明"没有可验证的声明不等于验证通过"')
  ok(saved.counts.pass === 0 && saved.counts.fail === 0 && saved.counts.unverified === 0,
    '空声明的 counts 仍是全 0（不伪造数字）')
  const onePass = makeVerificationReport({ runId: 'one-pass-regression', task: '一条人工通过', claims: [{ statement: 'x', kind: 'manual', status: 'pass' }] })
  ok(onePass.verdict === 'pass', '有一条通过 claim 时 verdict 仍为 pass（没有修过头）')
}

// F-023（2026-09-12，r28 我自己用这个工具时踩到）：kind=file 的**相对路径基准**。
// 旧实现裸 existsSync(相对路径) → 按 DSH 宿主/MCP 进程的 cwd 解析（通常不是仓库根），
// 于是"文件明明存在"却判 fail，还被**自动记进失败样本库 class=agent-misjudge** ——
// 一个专门防 agent 自说自话的工具，反过来把一句真话记成了谎话。
{
  const repo = mkdtempSync(join(tmpdir(), 'verify-repo-'))
  mkdirSync(join(repo, 'bench-runs'), { recursive: true })
  const f = join(repo, 'bench-runs', 'evidence.md')
  writeFileSync(f, 'x')

  // ① 用 claim.repo 指定仓库根 → 相对路径必须能命中
  const r1 = makeVerificationReport({
    runId: 'f023-with-repo', task: '相对路径 + repo', recordFailures: false,
    claims: [{ statement: '证据文件存在', kind: 'file', path: 'bench-runs/evidence.md', repo }],
  })
  ok(r1.claims[0].status === 'pass',
    '★ 相对路径按 claim.repo 解析 → pass（旧实现在这里判 fail，误记 agent-misjudge）；实际=' + String(r1.claims[0].status)
    + ' detail=' + String(r1.claims[0].detail).slice(0, 120))
  ok(/相对基准/.test(String(r1.claims[0].detail)),
    '★ pass 时把**基准**印出来（否则无法核对解析对不对）')

  // ② 环境变量基准 DSH_VERIFY_REPO_ROOT
  process.env.DSH_VERIFY_REPO_ROOT = repo
  const r2 = makeVerificationReport({
    runId: 'f023-env-repo', task: '相对路径 + env 基准', recordFailures: false,
    claims: [{ statement: '证据文件存在', kind: 'file', path: 'bench-runs/evidence.md' }],
  })
  ok(r2.claims[0].status === 'pass', '★ 相对路径按 DSH_VERIFY_REPO_ROOT 解析 → pass；实际=' + String(r2.claims[0].status))
  delete process.env.DSH_VERIFY_REPO_ROOT

  // ③ 真的不存在时：必须列出**试过哪些基准**（分得清"没有"与"基准错了"）
  const r3 = makeVerificationReport({
    runId: 'f023-missing', task: '真不存在', recordFailures: false,
    claims: [{ statement: '证据文件不存在', kind: 'file', path: 'bench-runs/nope.md', repo }],
  })
  ok(r3.claims[0].status === 'fail', '真不存在时仍判 fail（没有把 fail 修没）')
  ok(/已按这些基准找过/.test(String(r3.claims[0].detail)),
    '★ fail 时列出所有试过的基准 —— 否则分不清"文件真没有"与"基准搞错了"；实际=' + String(r3.claims[0].detail).slice(0, 160))

  // ④ 绝对路径不受影响（零回归）
  const r4 = makeVerificationReport({
    runId: 'f023-abs', task: '绝对路径', recordFailures: false,
    claims: [{ statement: '证据文件存在', kind: 'file', path: f }],
  })
  ok(r4.claims[0].status === 'pass', '绝对路径照旧 pass；实际=' + String(r4.claims[0].status))

  // ⑤ manual 不给 status → 必须**说清原因**，不能一句 "agent-supplied" 糊过去
  const r5 = makeVerificationReport({
    runId: 'f023-manual-nostatus', task: 'manual 缺 status', recordFailures: false,
    claims: [{ statement: '人工判断', kind: 'manual', evidence: '我看了' }],
  })
  ok(r5.claims[0].status === 'unverified', 'manual 缺 status → unverified；实际=' + String(r5.claims[0].status))
  ok(/必须.*声明.*status/.test(String(r5.claims[0].detail)),
    '★ 缺 status 时明说"必须显式声明 status: pass|fail"，而不是让调用方猜；实际=' + String(r5.claims[0].detail).slice(0, 140))

  // ⑥ ★ Codex r29 证伪：**目录也能冒充"文件证据"通过**（existsSync 对目录也为真）。
  {
    const dirAsFile = mkdtempSync(join(tmpdir(), 'verify-dir-'))
    const r6 = makeVerificationReport({
      runId: 'f023-dir-as-file', task: '目录冒充文件', recordFailures: false,
      claims: [{ statement: '证据文件存在（其实给的是目录）', kind: 'file', path: dirAsFile }],
    })
    ok(r6.claims[0].status === 'fail',
      '★ 传一个**目录**必须判 fail（kind=file 承诺的是"文件"存在）；实际=' + String(r6.claims[0].status))
    ok(/不是普通文件/.test(String(r6.claims[0].detail)) && /directory/.test(String(r6.claims[0].detail)),
      '★ 失败原因写明"不是普通文件"并给出**实际类型**；实际=' + String(r6.claims[0].detail).slice(0, 160))
    const r7 = makeVerificationReport({
      runId: 'f023-repo-relative', task: 'repo 为相对路径要提醒', recordFailures: false,
      claims: [{ statement: '相对 repo', kind: 'file', path: 'bench-runs/evidence.md', repo: 'relative/repo' }],
    })
    ok(/claim\.repo 是相对路径/.test(String(r7.claims[0].detail)),
      '★ claim.repo 给相对路径时要提醒（否则"存在"可能指的是另一份文件）；实际=' + String(r7.claims[0].detail).slice(0, 140))
    rmSync(dirAsFile, { recursive: true, force: true })
  }

  // ⑦ ★ 相对路径 + **没给任何仓库根基准**（既无 claim.repo 也无 DSH_VERIFY_REPO_ROOT）→ unverified，
  //    不是 fail，且**不写失败样本库**。与 ③ 对照：③ 给了 repo 未命中=fail；这里没给基准=「没读到」≠「没有」。
  //    旧实现按宿主 cwd 误判 fail 并自动记 agent-misjudge，污染 the moat（DSH R2 §3.5）。
  {
    const cdir = mkdtempSync(join(tmpdir(), 'verify-corpus-nobase-'))
    process.env.DSH_FAILURE_CORPUS_DIR = cdir              // 默认 recordFailures=true：验证它确实不记
    const r8 = makeVerificationReport({
      runId: 'f023-relpath-nobase', task: '相对路径无基准',
      claims: [{ statement: '相对路径证据（未给仓库根）', kind: 'file', path: 'no-such-dir-xyzzy-0916/nope.md' }],
    })
    ok(r8.claims[0].status === 'unverified',
      '★ 相对路径 + 无仓库根基准 + 未命中 → unverified（不是 fail）；实际=' + String(r8.claims[0].status))
    ok(r8.recorded === 0,
      '★ 判 unverified 不写失败样本库（不污染 the moat）；实际 recorded=' + String(r8.recorded))
    ok(/未给仓库根基准|没读到/.test(String(r8.claims[0].detail)),
      '★ detail 说清是"基准没给"而非"文件不存在"；实际=' + String(r8.claims[0].detail).slice(0, 140))
    rmSync(cdir, { recursive: true, force: true })
    delete process.env.DSH_FAILURE_CORPUS_DIR
  }

  rmSync(repo, { recursive: true, force: true })
}

// F-026（2026-09-12，r29 我读返回体时踩到）：**返回体里的 claim 丢了检查类型**。
// `adjudicated` 的字段叫 `check`，而汇总时读的是 `c.kind` ⇒ 恒 undefined ⇒ 调用方拿到的每条 claim
// 都没有类型，而落盘报告里有。同一个对象两个面两个字段名（第 1 类缺陷落在裁决工具自己身上）。
{
  const r = makeVerificationReport({
    runId: 'f026-return-shape', task: '返回体字段名', recordFailures: false,
    claims: [
      { statement: '文件存在', kind: 'file', path: import.meta.filename },
      { statement: '人工判断', kind: 'manual', status: 'pass' },
    ],
  })
  ok(Array.isArray(r.claims) && r.claims.length === 2, '返回体里带 claims 数组；实际=' + JSON.stringify(r.claims?.length))
  ok(r.claims[0].kind === 'file',
    '★ 返回体的每条 claim 必须带**检查类型**（kind 与 schema 对齐）；实际=' + JSON.stringify(r.claims[0].kind))
  ok(r.claims[0].check === 'file',
    '★ 同时给出 `check`（与落盘报告字段名对齐），两个面谁读都不拿到 undefined；实际=' + JSON.stringify(r.claims[0].check))
  ok(r.claims.every((c) => c.kind !== undefined && c.kind !== null),
    '★ 任何一条都不许出现 undefined 的检查类型；实际=' + JSON.stringify(r.claims.map((c) => c.kind)))
  const saved = JSON.parse(readFileSync(r.reportPath, 'utf8'))
  ok(saved.claims[0].check === 'file' && saved.claims[0].kind === undefined,
    '落盘报告的字段名保持 `check`（未破坏既有契约）；实际=' + JSON.stringify(Object.keys(saved.claims[0])))
}

// ---------------------------------------------------------------- kind="compiled"（r41）
// 这一类的存在理由：`kind="file"` 只验"文件**存在**"，一个没被任何工程引用的 .cs 也会 pass
// ⇒ G1 黑盒 agent 的原话是"**裁决器给了一份假安全感**"。这里钉住三态映射。
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-compiled-'))
  try {
    const legacy = join(dir, 'App')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'App.csproj'), '<Project ToolsVersion="15.0"><ItemGroup><Compile Include="Listed.cs" /></ItemGroup></Project>')
    writeFileSync(join(legacy, 'Listed.cs'), '// listed')
    writeFileSync(join(legacy, 'Forgotten.cs'), '// forgotten —— 这正是"构建通过但没编"的那种文件')
    const sdkDir = join(dir, 'Modern')
    mkdirSync(sdkDir, { recursive: true })
    writeFileSync(join(sdkDir, 'Modern.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>')
    writeFileSync(join(sdkDir, 'Anything.cs'), '// sdk default glob')

    const r = makeVerificationReport({
      runId: 'compiled-kinds', task: '编译成员三态', recordFailures: false,
      claims: [
        { statement: '列进编译项的文件会进编译', kind: 'compiled', path: join(legacy, 'Listed.cs') },
        { statement: '**没被任何工程引用**的文件不会进编译', kind: 'compiled', path: join(legacy, 'Forgotten.cs') },
        { statement: 'SDK 风格默认包含', kind: 'compiled', path: join(sdkDir, 'Anything.cs') },
        { statement: '文件不存在时不许判"不在"', kind: 'compiled', path: join(legacy, 'NoSuchFile.cs') },
        { statement: '没给 path', kind: 'compiled' },
      ],
    })
    const byStatement = Object.fromEntries(r.claims.map((c) => [c.statement, c]))
    ok(byStatement['列进编译项的文件会进编译'].status === 'pass',
      '★ 显式列进编译项 ⇒ pass；实际=' + JSON.stringify(byStatement['列进编译项的文件会进编译']))
    ok(byStatement['**没被任何工程引用**的文件不会进编译'].status === 'fail',
      '★★ 没被列进编译项 ⇒ **fail**（这正是要拦住的"假通过"）；实际=' + JSON.stringify(byStatement['**没被任何工程引用**的文件不会进编译']))
    ok(/不会进编译/.test(byStatement['**没被任何工程引用**的文件不会进编译'].detail) &&
      /构建 0 错误/.test(byStatement['**没被任何工程引用**的文件不会进编译'].detail),
      '★ fail 的 detail 要说清"与构建 0 错误完全相容"（否则读者会以为编译坏了）')
    ok(byStatement['SDK 风格默认包含'].status === 'pass', '★ SDK 风格默认 glob ⇒ pass')
    ok(byStatement['文件不存在时不许判"不在"'].status === 'unverified',
      '★★ 文件不存在 ⇒ **unverified**（不是 fail、更不是 pass）："没读到" ≠ "没有"；实际=' + JSON.stringify(byStatement['文件不存在时不许判"不在"']))
    ok(byStatement['没给 path'].status === 'unverified', '★ 没给 path ⇒ unverified')
    ok(r.claims.every((c) => c.kind === 'compiled'), '★ 返回体里 kind 原样带出（两面 schema 对齐）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

delete process.env.DSH_BUILD_LOGS_DIR
delete process.env.DSH_API_CAPTURE_STORE

if (failures > 0) {
  console.error(`\nVERIFY-REPORT TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nVERIFY-REPORT TEST PASSED')
