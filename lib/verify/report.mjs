/**
 * lib/verify/report.mjs — verification report with evidence adjudication.
 *
 * The physical carrier of "evidence over claims": one runId ties a task's
 * claims to the evidence backing them, and the REPORT adjudicates each claim
 * from that evidence — it does not record the agent's self-rating:
 *
 *   kind=build   reads the per-run build record (run-<runId>.json in the
 *                build-logs dir) and derives pass/fail from it
 *   kind=api     queries the shared capture store (filter + expect.min /
 *                expect.all2xx) and derives pass/fail from matching records
 *   kind=file    checks that an evidence artifact exists
 *   kind=git     machine-checks git facts against the authoritative source
 *                (clean working tree / pushed via ls-remote — never the
 *                stale local tracking refs)
 *   kind=gate    runs a verification command; exit 0 = pass
 *   kind=manual  explicit opt-out: agent-supplied status (for what the system
 *                cannot check, e.g. visual judgment / human handoff)
 *
 * Verdict: pass / incomplete / fail. A claim the evidence contradicts
 * (adjudicated fail) is an agent-misjudge and is auto-recorded in the failure
 * corpus — the system observes the mismatch, not the agent.
 *
 * Framework-free; data lives under ~/.dsh-agent-toolchain/verify-reports/
 * (override DSH_VERIFY_DIR).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeFailureCorpus } from '../failure-corpus.mjs'
import { queryRecords, readAll } from '../capture-store.mjs'
import { envOr } from '../env-fallback.mjs'
import { checkCompileMembership } from '../compile-membership.mjs'

export function defaultReportDir() {
  // 用户级配置 → 经 env-fallback：否则"我配了 DSH_VERIFY_DIR，报告还是写到别处去"（工具在说谎）。
  return envOr('DSH_VERIFY_DIR') || join(homedir(), '.dsh-agent-toolchain', 'verify-reports')
}

export function defaultBuildLogsDir() {
  return envOr('DSH_BUILD_LOGS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'build-logs')
}

/** runId is part of the filename — never allow path separators or traversal. */
export function sanitizeRunId(runId) {
  return String(runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80)
}

// ---------------------------------------------------------------- evidence readers

/**
 * Per-run build record (run-<runId>.json).
 *
 * BV-01（2026-09-11，Codex 第二轮独立复现）：过去无 runId 时会退回全局 last.json，
 * 且不校验 repoRoot/at —— 于是"今天在 A 仓库宣布编译通过"可以拿 **B 仓库昨天**的成功日志判 pass
 * （本机实测 last.json 指向另一个仓库）。
 * 现在：**只在显式 allowLast 时才退回 last.json**，并把退回结果标成 source='last'，
 * 由 checkBuild 决定能不能用它下结论。
 *
 * @returns {{rec: object, source: 'run'|'last'} | null}
 */
function readBuildRecord(runId, { allowLast = false } = {}) {
  const dir = defaultBuildLogsDir()
  if (runId) {
    const p = join(dir, 'run-' + sanitizeRunId(runId) + '.json')
    if (existsSync(p)) {
      try {
        return { rec: JSON.parse(readFileSync(p, 'utf8')), source: 'run' }
      } catch {
        return null
      }
    }
  }
  if (!allowLast) return null
  const last = join(dir, 'last.json')
  if (!existsSync(last)) return null
  try {
    return { rec: JSON.parse(readFileSync(last, 'utf8')), source: 'last' }
  } catch {
    return null
  }
}

/** 路径比较（大小写/分隔符不敏感）；任一为空时返回 null = 无从比较。 */
function sameRepo(a, b) {
  if (!a || !b) return null
  const norm = (s) => String(s).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

// ---------------------------------------------------------------- adjudicators

function checkBuild(claim, ctx = {}) {
  // BV-01：claim 级 runId 优先，缺省用**报告级** runId（报告级必填，所以这里基本总有值）。
  const effectiveRunId = claim.runId || ctx.reportRunId || ''
  const hit = readBuildRecord(effectiveRunId)
  if (!hit) {
    // 关键改动：**不再**静默退回 last.json 去判 pass。
    // 没有本次 run 的构建记录，就没有"本次编译通过"的证据 —— 与 expect.min<1 的反绿洗纪律同源。
    return {
      status: 'unverified',
      detail: 'no per-run build record' + (effectiveRunId ? ' for runId ' + sanitizeRunId(effectiveRunId) : '') +
        ' — 不退回全局 last.json（否则别的仓库/别的日期的构建会替本次背书）。' +
        '修法：build_run 时带 runId=' + (effectiveRunId ? sanitizeRunId(effectiveRunId) : '<本次 runId>') + '。',
      evidence: null,
    }
  }
  const rec = hit.rec
  if (!rec || rec.hasRun === false) {
    return { status: 'unverified', detail: 'build record is empty for runId ' + sanitizeRunId(effectiveRunId), evidence: null }
  }
  // 跨仓证据：两边都能取到仓库时，必须一致
  const want = (claim.repo || (ctx.context && ctx.context.repo) || '')
  const match = sameRepo(want, rec.repoRoot)
  if (match === false) {
    return {
      status: 'unverified',
      detail: 'build record belongs to another repo: ' + rec.repoRoot + ' ≠ ' + want + ' — 跨仓证据不能为本次背书。',
      evidence: rec.logPath ?? null,
    }
  }
  const srcTag = hit.source === 'last' ? ' [source=last.json]' : ''
  const detail = `${rec.target ?? 'build'} ${rec.ok ? 'passed' : 'failed'} — ${rec.logPath ?? 'no log'}${srcTag}`
  if (rec.ok) return { status: 'pass', detail, evidence: rec.logPath ?? null }
  return { status: 'fail', detail, evidence: rec.logPath ?? null }
}

function checkApi(claim, ctx = {}) {
  // BV-01 同类：api claim 也绑定 runId（claim 级优先，缺省报告级），
  // 否则会在跨 run/跨天共享的捕获库里检索到与本次无关的记录。
  const effectiveRunId = claim.runId || (ctx && ctx.reportRunId) || ''
  const filter = { ...(claim.filter ?? {}), ...(effectiveRunId ? { runId: effectiveRunId } : {}) }
  const matches = queryRecords(filter)
  const expect = claim.expect ?? {}
  const min = Number(expect.min ?? 1)
  // Anti-green-wash: a claim needs at least one evidence record. min < 1
  // would certify pass with zero evidence (matches.length >= 0 always
  // holds) — the same discipline as the vacuous-gate guard, fail closed.
  if (!Number.isFinite(min) || min < 1) {
    return { status: 'unverified', detail: 'expect.min must be >= 1 (a claim needs at least one evidence record)', evidence: 'capture-store' }
  }
  const all2xx = expect.all2xx === true
  if (matches.length >= min && (!all2xx || matches.every((r) => Number.isInteger(r.status) && r.status >= 200 && r.status < 300))) {
    return { status: 'pass', detail: `${matches.length} matching capture record(s)`, evidence: 'capture-store' }
  }
  if (matches.length === 0) {
    // No match is a contradiction only when capture was actually active
    // (the store has records but none match the claim).
    const storeTotal = readAll().length
    return storeTotal > 0
      ? { status: 'fail', detail: `no matching capture record(s) while the store holds ${storeTotal}`, evidence: 'capture-store' }
      : { status: 'unverified', detail: 'capture store empty — capture was not active', evidence: 'capture-store' }
  }
  return { status: 'fail', detail: `${matches.length} record(s) but not meeting expect ${JSON.stringify(expect)}`, evidence: 'capture-store' }
}

/**
 * kind=file: 声明"证据文件存在"。
 *
 * F-023（2026-09-12，r28 我**用这个工具时自己踩到**）：
 * 旧实现是裸 `existsSync(claim.path)` —— 相对路径按 **process.cwd()** 解析，而这个 cwd 是
 * **DSH 宿主/MCP 进程的启动目录**，通常**不是仓库根**。实测：
 *   claims: [{ kind:'file', path:'bench-runs/dbg-20260911/给用户的说明.md' }]
 *   → `fail: missing: bench-runs/dbg-20260911/给用户的说明.md`（文件其实就在仓库里）
 * 两个后果，都比"判错"更糟：
 *   ① detail 只说 `missing: <相对路径>`，**不写基准** —— 分不清"文件真没有"与"基准搞错了"，
 *      正中本仓反复修的「没读到 ≠ 没有」；
 *   ② 被反驳的 claim 会**自动记入失败样本库 class=agent-misjudge** —— 于是工具把一个**真话**
 *      记成了"agent 自说自话"。对一个**专门用来防 agent 自说自话**的工具，这是最不能有的反向错误。
 * 现在：按 [claim.repo → DSH_VERIFY_REPO_ROOT → cwd] 依次解析，命中即 pass 并把**基准**印出来；
 * 全不命中才 fail，且把**试过的每个基准**都列出来。
 */
function checkFile(claim) {
  const raw = claim.path
  if (!raw) return { status: 'unverified', detail: 'no path given', evidence: null }
  const bases = []
  if (claim.repo) bases.push(String(claim.repo))
  const envRoot = envOr('DSH_VERIFY_REPO_ROOT')
  if (envRoot) bases.push(envRoot)
  bases.push(process.cwd())
  const unique = [...new Set(bases)]
  const tried = []
  // ⚠ 注意：落盘报告里 `detail` 会被 **截断到 200 字符**（report.mjs 的 claimsSummary）。
  // 所以**要紧的话必须写在前面** —— 我第一版把这条提醒**追加在末尾**，结果它被整段截掉，
  // 是回归测试当场抓到的（"写进去了" ≠ "读得到"）。长清单只留首个基准 + 计数，完整清单放 evidence。
  const repoRelativeNote = claim.repo && !isAbsolute(String(claim.repo))
    ? '⚠ claim.repo 是相对路径（请给绝对仓库根）：'
    : ''
  for (const base of unique) {
    const p = isAbsolute(raw) ? raw : join(base, raw)
    tried.push(p)
    if (!existsSync(p)) continue
    // ★ Codex r29 证伪：`existsSync` **对目录也为真** ⇒ 传一个目录当"证据文件"照样 pass。
    //   名字叫 kind=file，承诺的是"**文件**存在"，那就必须真的是一般文件。
    //   （同类：设备/管道/FIFO 也不是"文件证据"。）
    let isRegular = false
    let kind = 'unknown'
    try {
      const st = statSync(p)
      isRegular = st.isFile()
      kind = st.isDirectory() ? 'directory' : (st.isFile() ? 'file' : 'other')
    } catch (e) {
      return { status: 'fail', detail: `无法 stat: ${p}（${e && e.message ? e.message : String(e)}）`, evidence: p }
    }
    if (!isRegular) {
      return {
        status: 'fail',
        detail: `路径存在但**不是普通文件**（实际类型=${kind}）：${p}${repoRelativeNote}`
          + ' —— kind=file 承诺的是"证据**文件**存在"，目录/设备等不算。',
        evidence: p,
      }
    }
    return {
      status: 'pass',
      detail: 'exists: ' + p + (isAbsolute(raw) ? '' : `（相对基准 ${base} 解析）`) + repoRelativeNote,
      evidence: p,
    }
  }
  // 未命中要区分「确实不存在」(fail) 与「基准没给对/没给」(unverified)——
  // 后者绝不能记 agent-misjudge 污染失败样本库（ROADMAP 称之为 the moat）。DSH R2 §3.5：
  //   · 绝对路径未命中 ⇒ fail：路径是调用方自己给全的，没有基准歧义，就是不存在。
  //   · 相对路径 + **给了**显式基准（claim.repo / DSH_VERIFY_REPO_ROOT）仍未命中 ⇒ fail：给了仓库根还找不到。
  //   · 相对路径 + **没给**任何显式基准（只回落进程 cwd，而这个 cwd 通常是 DSH 宿主/MCP 启动目录，
  //     不是仓库根）⇒ **unverified**：这是「没读到」不是「没有」。旧实现在这里一律判 fail，
  //     把一句可能为真的话按宿主 cwd 误判并自动记 agent-misjudge —— 一个防 agent 自说自话的工具反过来自说自话。
  const triedNote = tried.length <= 2 ? tried.join(' | ') : `${tried[0]}（共试过 ${tried.length} 个基准）`
  const hasExplicitBase = Boolean(claim.repo) || Boolean(envRoot)
  if (!isAbsolute(raw) && !hasExplicitBase) {
    return {
      status: 'unverified',
      detail: `${repoRelativeNote}无法核对相对路径 ${raw}：未给仓库根基准（claim.repo / DSH_VERIFY_REPO_ROOT），`
        + `只按进程 cwd 找过（${triedNote}）未命中。"没读到" ≠ "文件不存在" —— `
        + '给绝对路径、或用 claim.repo / DSH_VERIFY_REPO_ROOT 指定仓库根后重判。',
      evidence: tried.join(' | ').slice(0, 400),
    }
  }
  return {
    status: 'fail',
    detail: `${repoRelativeNote}missing: ${raw} —— 已按这些基准找过都不存在：` + triedNote
      + '。若文件其实在别处：给绝对路径，或用 claim.repo / DSH_VERIFY_REPO_ROOT 指定仓库根。',
    evidence: tried.join(' | ').slice(0, 400),
  }
}

/** Explicit opt-out: agent-supplied status for what the system cannot check. */
function checkManual(claim) {
  const status = claim.status === 'pass' || claim.status === 'fail' ? claim.status : 'unverified'
  if (status === 'unverified') {
    // 不给 status 时**必须说清为什么**：否则一句 "agent-supplied" 会让调用方以为工具查过了却没结论。
    return {
      status,
      detail: 'manual claim 没有给 status —— 人工判断类**必须**显式声明 status: "pass"|"fail"，'
        + '否则一律记为"未验证"（不等于通过，也不等于失败）。evidence: ' + String(claim.evidence ?? '(未给)'),
      evidence: claim.evidence ?? null,
    }
  }
  return { status, detail: claim.evidence ?? 'agent-supplied', evidence: claim.evidence ?? null }
}

/**
 * kind=git: machine-check git facts against the AUTHORITATIVE source, not the
 * local tracking refs (URL-token pushes do not update origin/*, so git status
 * can show a phantom "ahead"). check=clean -> working tree via status
 * --porcelain; check=pushed -> local ref vs `git ls-remote` (the remote itself).
 */
function runGit(repo, args, gitConfig) {
  try {
    return execFileSync('git', [...gitConfig, '-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

function checkGit(claim) {
  const repo = claim.repo || process.cwd()
  const check = claim.check ?? 'clean'
  const gitConfig = Array.isArray(claim.gitConfig) ? claim.gitConfig : []
  if (check === 'clean') {
    const out = runGit(repo, ['status', '--porcelain'], gitConfig)
    if (out === null) return { status: 'unverified', detail: 'git status failed', evidence: null }
    return out.trim() === ''
      ? { status: 'pass', detail: 'working tree clean', evidence: 'git status' }
      : { status: 'fail', detail: 'working tree dirty: ' + out.trim().split('\n').slice(0, 3).join(' | '), evidence: 'git status' }
  }
  if (check === 'pushed') {
    const ref = claim.ref ?? 'HEAD'
    const head = runGit(repo, ['rev-parse', ref], gitConfig)
    if (head === null || !head.trim()) return { status: 'unverified', detail: 'cannot resolve local ' + ref, evidence: null }
    const remote = runGit(repo, ['ls-remote', 'origin', ref], gitConfig)
    if (remote === null || !remote.trim()) return { status: 'unverified', detail: 'cannot reach the remote (no network / no upstream)', evidence: null }
    const localSha = head.trim()
    const remoteSha = remote.trim().split(/\s+/)[0]
    return localSha === remoteSha
      ? { status: 'pass', detail: localSha.slice(0, 10) + ' is on the remote', evidence: 'git ls-remote' }
      : { status: 'fail', detail: 'local ' + localSha.slice(0, 10) + ' != remote ' + remoteSha.slice(0, 10) + ' (unpushed commits)', evidence: 'git ls-remote' }
  }
  return { status: 'unverified', detail: 'unknown git check: ' + check, evidence: null }
}

/** kind=gate: run a verification command; exit 0 = pass, anything else = fail. */
function checkGate(claim) {
  const cmd = claim.cmd
  if (!cmd) return { status: 'unverified', detail: 'no cmd given', evidence: null }
  try {
    const r = spawnSync(cmd, { shell: true, cwd: claim.cwd || process.cwd(), encoding: 'utf8', windowsHide: true })
    const full = String((r.stdout || '') + '\n' + (r.stderr || ''))
    // Keep enough of the tail to debug a real failure: 6 lines on failure
    // (test frameworks print the failing assertion last), 2 lines on success.
    const tailLines = full.trim().split(/\r?\n/).filter(Boolean)
    const tail = tailLines.slice(r.status === 0 ? -2 : -6).join(' | ').slice(0, 400)
    const failTail = tailLines.slice(-6).join(' | ').slice(0, 400)
    if (r.status === 0) {
      // Exit 0 alone can be vacuous: a test filter matching nothing exits 0.
      // A gate that certified "0 tests ran" as pass would be green-washing.
      const vac = VACUOUS_TEST_PATTERNS.find((p) => p.re.test(full))
      if (vac) {
        // Name WHICH pattern matched and keep the full failure tail (6 lines
        // / 400 chars) — the old 120-char/2-line detail was too thin to see
        // which filter or test didn't fire.
        return { status: 'fail', detail: `exit 0 but no tests executed (${vac.label})` + (failTail ? ' — ' + failTail : ''), evidence: cmd }
      }
      return { status: 'pass', detail: 'exit 0' + (tail ? ' — ' + tail.slice(0, 120) : ''), evidence: cmd }
    }
    return { status: 'fail', detail: 'exit ' + (r.status ?? '?') + (failTail ? ' — ' + failTail : ''), evidence: cmd }
  } catch (e) {
    return { status: 'unverified', detail: 'gate could not run: ' + String(e.message ?? e).slice(0, 120), evidence: cmd }
  }
}

/** Output patterns of test runners that ran zero tests (exit code 0). */
export const VACUOUS_TEST_PATTERNS = [
  { label: 'no-test-matches (CN)', re: /没有测试匹配|没有测试与筛选器/ },
  { label: 'no-test-matches (EN)', re: /no test (matches|matched|were selected|to run|was selected)/i },
  { label: 'no-tests-in-containers', re: /no test is available in the specified test containers/i },
  { label: 'tests-run-0', re: /tests run:\s*0|测试运行:\s*0/i },
  { label: 'OK-0-tests', re: /OK \(0 tests\)/ },
  { label: '0-of-0-tests', re: /0 of 0 tests/i },
  { label: '0/0 summary (CN)', re: /已通过! - 失败:\s*0，通过:\s*0/ },
  { label: '0/0 summary (EN)', re: /passed:\s*0\s*[\s\S]{0,160}total:\s*0/i },
]

const CHECKS = { build: checkBuild, api: checkApi, file: checkFile, manual: checkManual, git: checkGit, gate: checkGate, compiled: checkCompiled }

/**
 * `kind: "compiled"` —— "**这个文件真的会进编译吗**"。
 *
 * 为什么要有它（r41，两个 G1 黑盒 agent 里的场景 B 直接点名）：
 *   agent 的原话是「把"0 errors"或 `kind:"file"` 的 pass 当成"新加的文件进了编译" ——
 *   `kind:"file"` 只验文件**存在**，一个根本没被任何工程引用的 `.cs` 也会判 pass ⇒ **裁决器给了一份假安全感**」。
 *   而 legacy .csproj 不会自动包含 .cs：漏写 `<Compile Include>` 时**构建通过、文件根本没编**。
 *
 * 三态映射（**与 file 的语义差异必须写清**）：
 *   · `included: true`  ⇒ pass（依据：显式编译项 / SDK 默认 glob）
 *   · `included: false` ⇒ **fail**（这正是要拦住的那种"假通过"）
 *   · 读不到（文件/工程不存在、同层多工程、解析不了）⇒ **unverified** ——
 *     **绝不**因为"没读到"就判 fail，也绝不判 pass（"没读到" ≠ "没有"）。
 */
function checkCompiled(claim) {
  const raw = claim.path
  if (!raw) return { status: 'unverified', detail: 'no path given（kind=compiled 需要源码文件路径）', evidence: null }
  const bases = []
  if (claim.repo) bases.push(String(claim.repo))
  const envRoot = envOr('DSH_VERIFY_REPO_ROOT')
  if (envRoot) bases.push(envRoot)
  bases.push(process.cwd())
  const tried = []
  for (const base of [...new Set(bases)]) {
    const p = isAbsolute(raw) ? raw : join(base, raw)
    tried.push(p)
    if (!existsSync(p)) continue
    const projAbs = claim.project ? (isAbsolute(String(claim.project)) ? String(claim.project) : join(base, String(claim.project))) : undefined
    const v = checkCompileMembership(p, { projectPath: projAbs, repoRoot: claim.repoRoot ? String(claim.repoRoot) : undefined })
    const evidence = { ...v, tried }
    if (v.ok !== true) {
      // 读不到 ⇒ unverified + **原因与下一步写在最前面**（落盘 detail 会被截断到 200 字符）
      return { status: 'unverified', detail: '无法判定（不是"不在"）：' + (v.error || v.reason || '未知原因') + (v.hint ? '｜下一步：' + v.hint : ''), evidence }
    }
    if (v.included === true) {
      // r43：条目可能来自**别的文件**（Directory.Build.props / <Import>）—— 说清楚是谁列的，
      //   否则调用方会以为"我明明没在 .csproj 里写它，怎么会 pass"。
      const from = v.matchedIn && v.project && v.matchedIn !== v.project ? '（条目声明在 ' + basename(String(v.matchedIn)) + '）' : ''
      return { status: 'pass', detail: '会进编译 —— ' + (v.basis === 'sdk-default-glob' ? 'SDK 风格默认 glob 包含' : '命中显式编译项 ' + (v.matchedItem || '')) + from + '｜工程 ' + v.project, evidence }
    }
    const why = v.basis === 'removed' ? '被 <Compile Remove> 排除'
      : v.basis === 'sdk-default-disabled' ? 'SDK 默认项被关掉且未显式列出'
        : v.basis === 'not-referenced-by-any-project' ? '扫描了 ' + (v.scannedProjects ?? '?') + ' 个工程，**没有任何一个**把它列进编译'
          : 'legacy 工程未列出该文件'
    return {
      status: 'fail',
      detail: '**不会进编译** —— ' + why +
        (v.project ? '｜工程 ' + v.project : '｜（在给定的 repoRoot 范围内）') +
        '｜注意：这与"构建 0 错误"完全相容',
      evidence,
    }
  }
  return { status: 'unverified', detail: '文件找不到（试过 ' + tried.length + ' 个基准路径）—— "没读到"不是"不在"', evidence: { tried } }
}

/** Adjudicate one claim from its evidence reference. Never throws. */
export function adjudicateClaim(claim = {}, ctx = {}) {
  const kind = claim.kind ?? 'manual'
  const fn = CHECKS[kind]
  if (!fn) return { status: 'unverified', detail: 'unknown check kind: ' + kind, evidence: null }
  try {
    return fn(claim, ctx)
  } catch (e) {
    return { status: 'unverified', detail: 'adjudication error: ' + String(e.message ?? e).slice(0, 120), evidence: null }
  }
}

// ---------------------------------------------------------------- report

/**
 * @param {object} opts
 * @param {string} opts.runId  unique run id, e.g. "task-2-toolchain-1"
 * @param {string} opts.task   one-line task name
 * @param {Array<object>} opts.claims  each claim: {statement, kind?, runId?, path?, filter?, expect?, status?, evidence?}
 * @param {object} [opts.context]  runtime context (repo / model / mode)
 * @param {boolean} [opts.recordFailures]  default true — auto-record adjudicated-fail claims as agent-misjudge
 */
export function makeVerificationReport({ runId, task, claims = [], context = {}, recordFailures = true } = {}) {
  if (!runId || !task) throw new Error('runId and task are required')
  if (!Array.isArray(claims)) throw new Error('claims must be an array')
  const safeRunId = sanitizeRunId(runId)
  const adjudicated = claims.map((c) => {
    // BV-01：把报告级 runId 与 context 透传给每条 claim —— 没有它，claim 只能靠全局兜底去找证据。
    const r = adjudicateClaim(c, { reportRunId: safeRunId, context })
    return {
      statement: String(c.statement ?? '').slice(0, 400),
      check: c.kind ?? 'manual',
      status: r.status,
      detail: r.detail,
      ...(r.evidence ? { evidence: r.evidence } : {}),
    }
  })
  const mismatches = adjudicated.filter((c) => c.status === 'fail')
  const unverified = adjudicated.filter((c) => c.status === 'unverified')
  // ⚠ **"没有声明"不等于"验证通过"**（2026-09-12「用户可见结论的最坏情况」主题实测）：
  //   原先 `claims: []` 会得到 `verdict: "pass"`（counts 全 0），而且照样**落盘**一份
  //   `verify-reports/<runId>.json` 写着 pass —— 等于"什么都不声明"就能拿到一份"验证通过"的凭证。
  //   这正是本仓反复出现的"没读到 → 没问题"，只是这次落在**裁决本身**上；
  //   而用户的交接纪律恰恰依赖"总结 = claims 清单 + verdict"。
  const noClaims = adjudicated.length === 0
  const verdict = mismatches.length > 0 ? 'fail' : (unverified.length > 0 || noClaims) ? 'incomplete' : 'pass'
  const counts = {
    pass: adjudicated.filter((c) => c.status === 'pass').length,
    fail: mismatches.length,
    unverified: unverified.length,
  }
  const report = {
    runId: safeRunId,
    task,
    verdict,
    generatedAt: new Date().toISOString(),
    context,
    claims: adjudicated,
    counts,
    // 空声明时把话写死在报告里（这份 JSON 会被留存与引用）：不是"通过"，是"什么都没验"。
    ...(noClaims
      ? { note: '本次**没有任何 claim** —— 没有可验证的声明**不等于验证通过**（verdict 记为 incomplete）。请把要做的事写成 claims 再调用。' }
      : {}),
  }
  const dir = defaultReportDir()
  mkdirSync(dir, { recursive: true })
  const reportPath = join(dir, safeRunId + '.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

  let recorded = 0
  if (recordFailures && mismatches.length > 0) {
    const corpus = makeFailureCorpus({})
    for (const m of mismatches) {
      corpus.record({
        task: task + ' [' + safeRunId + ']',
        failureClass: 'agent-misjudge',
        description:
          'claim contradicted by evidence: ' + String(m.statement ?? '?').slice(0, 200) +
          ' — adjudicated ' + m.check + ': ' + String(m.detail ?? '').slice(0, 120),
        tags: ['auto', 'verify'],
        context: { runtime: 'verify', runId: safeRunId },
      })
      recorded++
    }
  }
  // Compact per-claim summary in the RETURN value (the full array is on disk):
  // callers that only surface the return value used to report "0 claims" for a
  // report that adjudicated five (external-review finding).
  //
  // F-026（2026-09-12，r29 我自己读返回体时踩到）：`adjudicated` 里的字段叫 **`check`**，
  // 而这里写的是 `kind: c.kind` —— **`c.kind` 恒为 undefined**，于是调用方拿到的每条 claim
  // **都没有检查类型**，而落盘报告里有。同一个对象两个面两个字段名，正是本仓第 1 类缺陷
  // （"渲染层假设的形状 ≠ 生产层的形状"）落在**裁决工具自己**身上。
  // 现在两个名字都给（`kind` 与 schema 对齐、`check` 与落盘对齐），谁读都不会拿到 undefined。
  const claimsSummary = adjudicated.map((c) => ({
    statement: String(c.statement ?? '').slice(0, 160),
    kind: c.check ?? null,
    check: c.check ?? null,
    status: c.status,
    detail: String(c.detail ?? '').slice(0, 200),
  }))
  return { runId: safeRunId, verdict, reportPath, mismatchCount: mismatches.length, recorded, counts, claims: claimsSummary }
}
