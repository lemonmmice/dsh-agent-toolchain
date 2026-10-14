// 6988a0f 复核 C1–C5 回归：perf_trace 的启动/取消/收尾生命周期边界，复刻 698-trace-boundaries 的反例、断言修好后的行为。
//   C1 启动阶段清理**失败**后绝不删租约/标记（删除≠停止证明），改保留可恢复的 running 标记。
//   C2 预检 WPR 会话在主任务取消时仍自清理（独立信号 finally），不泄漏、不漏发 -stop。
//   C3 直接 action=cancel：附加会话没停就不谎报 cancelled，落 unknown/incomplete+保留租约；任务层裁 unknown。
//   C4 最终 running 标记写失败 ⇒ 走统一收尾（内存账本），干净回滚而不是留 starting 挡住恢复。
//   C5 启动命令返回时拥有者已变（被接管）⇒ 绝不发全局内核命令、绝不动别人的租约。
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { makeTrace } from '../lib/trace.mjs'
import { traceSessionFile } from '../lib/trace.mjs'
import { withTaskContext } from '../../../lib/task-context.mjs'
import { runTaskTool, taskControl } from '../../../lib/task-tool-support.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }
const success = () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const marker = (evidenceDir) => traceSessionFile(evidenceDir)

const dir = mkdtempSync(join(tmpdir(), 'trace-lifecycle-'))
process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_TASK_DIR = join(dir, 'tasks')

/** 收尾可注入的采样夹具：记录命令、按名维护"内核/CLR 是否还在跑"的模型。 */
function lifecycleTrace(name, behavior = {}) {
  const evidenceDir = join(dir, name)
  const lease = join(dir, name + '-lease.json')
  const calls = []
  const controller = new AbortController()
  const state = { kernelRunning: false, clrRunning: false }
  const defaultRunExe = async (_exe, args) => {
    calls.push(args)
    if (args.includes('-Command')) return { ...success(), stdout: 'True' }
    if (args.includes('-start')) { state.kernelRunning = true; if (behavior.abortOn === 'start') controller.abort(new Error('fixture cancel after kernel start')) }
    if (args[0] === 'start') { state.clrRunning = true; return success() }                         // logman CLR start
    if (args[0] === 'stop') { if (behavior.clrStopFails) return { ...success(), code: 1, stderr: 'fixture: CLR stop failed' }; state.clrRunning = false; return success() }
    if (args.includes('-cancel') || args.includes('-stop')) { if (behavior.cancelFails) return { ...success(), code: 1, stderr: 'fixture cancel failed' }; state.kernelRunning = false }
    return success()
  }
  const trace = makeTrace({
    evidenceDir, kernelLeaseFile: lease, wpr: process.execPath, xperf: process.execPath, logman: process.execPath,
    runExe: behavior.runExe ? (e, a) => behavior.runExe(e, a, { calls, controller, state, lease, sessionFile: marker(evidenceDir) }) : defaultRunExe,
  })
  return { evidenceDir, lease, calls, controller, state, trace }
}

async function finishJob(jobId) {
  for (let i = 0; i < 400; i++) { const s = await taskControl({ jobId }); if (['done', 'failed', 'cancelled', 'unknown'].includes(s.state)) return s; await wait(5) }
  throw new Error('fixture job timed out')
}

try {
  // ---- C1：内核已起、CLR start 阶段取消；teardown 的 -cancel 返回非零 ⇒ 不得删租约/标记，改留可恢复 running 标记 ----
  {
    const f = lifecycleTrace('c1-stop-fails', { abortOn: 'start', cancelFails: true })
    let error = null
    try { await withTaskContext({ signal: f.controller.signal }, () => f.trace.trace({ action: 'run', seconds: 3, skipPreflight: true, engine: 'wpr', clr: true })) } catch (e) { error = e }
    check('C1 启动阶段取消：trace 抛出', Boolean(error))
    check('C1 teardown 尝试过收尾（calls 含 -cancel）', f.calls.some((a) => a.includes('-cancel')), JSON.stringify(f.calls))
    check('★ C1 收尾失败 ⇒ 内核租约**保留**（不把"可能仍在跑"抹掉）', existsSync(f.lease))
    check('★ C1 收尾失败 ⇒ 会话标记**保留**', existsSync(marker(f.evidenceDir)))
    let m = null; try { m = JSON.parse(readFileSync(marker(f.evidenceDir), 'utf8')) } catch { /* ignore */ }
    check('★ C1 保留的是可恢复标记（state=running + engine）', Boolean(m) && m.state === 'running' && m.engine === 'wpr', JSON.stringify(m))
    check('C1 异常带 unknown（任务层据此落 unknown 而非 failed）', error && error.unknown === true)
  }

  // ---- C2：预检 -start 后主任务取消；预检会话仍自清理（发出 -stop），不泄漏、内核从未正式起 ⇒ 租约/标记清掉 ----
  {
    const f = lifecycleTrace('c2-preflight-cancel', { abortOn: 'start' })
    let error = null
    try { await withTaskContext({ signal: f.controller.signal }, () => f.trace.trace({ action: 'run', seconds: 3, skipPreflight: false, engine: 'auto', clr: true })) } catch (e) { error = e }
    check('C2 预检取消：trace 抛出', Boolean(error))
    check('C2 预检发出了 -start CPU -filemode', f.calls.some((a) => a.includes('-start') && a.includes('CPU') && a.includes('-filemode')), JSON.stringify(f.calls))
    check('★ C2 预检在取消后仍自清理（calls 含 -stop）', f.calls.some((a) => a[0] === '-stop'), JSON.stringify(f.calls))
    check('★ C2 预检会话未泄漏（fixture kernelRunning=false）', f.state.kernelRunning === false)
    check('★ C2 内核从未正式起 ⇒ 租约已释放', !existsSync(f.lease))
    check('★ C2 会话标记已清除', !existsSync(marker(f.evidenceDir)))
  }

  // ---- C3：直接 action=cancel，内核 -cancel 成功但 CLR stop 失败 ⇒ 不谎报 cancelled；任务层裁 unknown/incomplete ----
  {
    const f = lifecycleTrace('c3-direct-cancel', { clrStopFails: true })
    const start = await f.trace.trace({ action: 'start', skipPreflight: true, engine: 'wpr', clr: true })
    check('C3 起采成功（内核+CLR）', start.ok === true && f.state.clrRunning === true, JSON.stringify(start).slice(0, 120))
    let businessResult = null
    const job = await runTaskTool('perf_trace', { asyncJob: true, action: 'cancel' }, async () => { businessResult = await f.trace.trace({ action: 'cancel' }); return businessResult })
    const st = await finishJob(job.jobId)
    check('★ C3 CLR 没停就不谎报 cancelled', businessResult && businessResult.cancelled !== true, JSON.stringify(businessResult).slice(0, 160))
    check('★ C3 落 unknown=true + incomplete=true + 恢复入口', businessResult && businessResult.unknown === true && businessResult.incomplete === true && typeof businessResult.recovery === 'string', JSON.stringify(businessResult).slice(0, 160))
    check('★ C3 保留内核租约（附加会话未确认停 ⇒ 不释放）', existsSync(f.lease))
    check('★ C3 任务层裁 unknown/incomplete（不是 cancelled/complete）', st && st.state === 'unknown' && st.completeness === 'incomplete', st ? (st.state + '/' + st.completeness) : 'no-state')
  }

  // ---- C4：最终 running 标记写入 ENOSPC ⇒ 走统一收尾把已起会话停掉，而不是留 starting 标记永久挡恢复 ----
  {
    const evidenceDir = join(dir, 'c4-marker-write')
    const lease = join(dir, 'c4-lease.json')
    const sessionFile = marker(evidenceDir)
    const calls = []
    const state = { kernelRunning: false }
    const originalWrite = fs.writeFileSync
    fs.writeFileSync = function (file, data, ...rest) {
      if (String(file) === sessionFile && typeof data === 'string' && data.includes('"state":"running"')) throw Object.assign(new Error('fixture no space saving running marker'), { code: 'ENOSPC' })
      return originalWrite.call(fs, file, data, ...rest)
    }
    syncBuiltinESMExports()
    let result = null
    try {
      const trace = makeTrace({
        evidenceDir, kernelLeaseFile: lease, wpr: process.execPath, xperf: process.execPath,
        runExe: async (_exe, args) => { calls.push(args); if (args.includes('-Command')) return { ...success(), stdout: 'True' }; if (args.includes('-start')) state.kernelRunning = true; if (args.includes('-stop') || args.includes('-cancel')) state.kernelRunning = false; return success() },
      })
      result = await trace.trace({ action: 'run', seconds: 3, skipPreflight: true, engine: 'wpr' })
    } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
    check('C4 标记写失败：ok=false + captureStarted=true', result && result.ok === false && result.captureStarted === true, JSON.stringify(result).slice(0, 160))
    check('★ C4 走了统一收尾并干净回滚（cleanedUp=true）', result && result.cleanedUp === true, JSON.stringify(result).slice(0, 160))
    check('★ C4 收尾把内核会话停掉（fixture kernelRunning=false）', state.kernelRunning === false)
    check('★ C4 收尾发出 -cancel（不是静默早返回）', calls.some((a) => a.includes('-cancel')), JSON.stringify(calls))
    check('★ C4 回滚后租约/标记已清（不留 starting 永久挡恢复）', !existsSync(lease) && !existsSync(sessionFile))
  }

  // ---- C5：内核 -start 返回时租约/标记已被另一个 attempt 替换 ⇒ 绝不发全局 -cancel、绝不动别人的租约 ----
  {
    const evidenceDir = join(dir, 'c5-ownership')
    const lease = join(dir, 'c5-lease.json')
    const sessionFile = marker(evidenceDir)
    const calls = []
    const controller = new AbortController()
    const foreign = { attemptId: 'fixture-foreign-attempt', state: 'running', engine: 'wpr', etlPath: join(evidenceDir, 'foreign.etl') }
    const trace = makeTrace({
      evidenceDir, kernelLeaseFile: lease, wpr: process.execPath, xperf: process.execPath, logman: process.execPath,
      runExe: async (_exe, args) => {
        calls.push(args)
        if (args.includes('-Command')) return { ...success(), stdout: 'True' }
        if (args.includes('-start')) { fs.writeFileSync(lease, JSON.stringify(foreign)); fs.writeFileSync(sessionFile, JSON.stringify(foreign)); controller.abort(new Error('fixture changed ownership')); return success() }
        return success()
      },
    })
    let error = null
    try { await withTaskContext({ signal: controller.signal }, () => trace.trace({ action: 'run', seconds: 3, skipPreflight: true, engine: 'wpr', clr: true })) } catch (e) { error = e }
    check('C5 取消抛出', Boolean(error))
    check('★ C5 拥有者已变 ⇒ 绝不发全局内核 -cancel/-stop', !calls.some((a) => a.includes('-cancel') || a[0] === '-stop'), JSON.stringify(calls))
    let keptLease = null; try { keptLease = JSON.parse(readFileSync(lease, 'utf8')) } catch { /* ignore */ }
    check('★ C5 别人的租约原样保留（没被本 attempt 删/改）', keptLease && keptLease.attemptId === foreign.attemptId, JSON.stringify(keptLease))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: perf_trace lifecycle boundaries (C1 retain-on-failed-cleanup, C2 preflight self-clean, C3 honest direct-cancel, C4 marker-write unified teardown, C5 ownership-before-global-stop)')
