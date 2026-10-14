// F05 回归：采样取消的三条路径都要正确收尾，不留孤儿 ETW 会话，也不谎报取消成功。
//   S1 wait-success（R1-14/F05）：等待中取消 → 立刻醒来、独立信号下 -cancel、释放租约、cancelled=true。
//   S2 between-starts（R2）：内核已起、CLR start 阶段取消抛出 → teardown 停内核 + 释放租约（不留 starting 标记）。
//   S3 cleanup-failure（R3）：-cancel 命令返回非零 → 不谎报 cancelled，落 unknown+incomplete、保留租约。
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeTrace } from '../lib/trace.mjs'
import { withTaskContext } from '../../../lib/task-context.mjs'
import { runTaskTool, taskControl } from '../../../lib/task-tool-support.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }
const success = () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(join(tmpdir(), 'trace-cancel-'))
process.env.DSH_NO_ENV_FALLBACK = '1'
process.env.DSH_TASK_DIR = join(dir, 'tasks')

function scenarioTrace(name, { abortOn, cancelFails, clr }) {
  const evidenceDir = join(dir, name)
  const lease = join(dir, name + '-lease.json')
  const calls = []
  const controller = new AbortController()
  const trace = makeTrace({
    evidenceDir, kernelLeaseFile: lease, wpr: process.execPath, xperf: process.execPath, logman: process.execPath,
    runExe: async (_exe, args) => {
      calls.push(args)
      if (args.includes('-Command')) return { ...success(), stdout: 'True' }       // 提权自检 → 已提权
      if (args.includes('-start')) {                                               // 内核 start
        if (abortOn === 'start') controller.abort(new Error('fixture cancel at kernel start'))
        else if (abortOn === 'wait') setTimeout(() => controller.abort(new Error('fixture cancel during wait')), 30)
      }
      if (cancelFails && args.includes('-cancel')) return { ...success(), code: 1, stderr: 'fixture cancel failed' }
      return success()
    },
  })
  return { evidenceDir, lease, calls, controller, run: () => withTaskContext({ signal: controller.signal }, () => trace.trace({ action: 'run', seconds: 3, skipPreflight: true, engine: 'wpr', ...(clr ? { clr: true } : {}) })) }
}

try {
  // ---- S1 wait-success ----
  {
    const s = scenarioTrace('wait-success', { abortOn: 'wait' })
    const t = Date.now()
    let result = null, error = null
    try { result = await s.run() } catch (e) { error = e }
    check('S1 等待响应取消：远早于 seconds(3s) 返回', Date.now() - t < 2500, (Date.now() - t) + 'ms')
    check('S1 发出收尾命令 -cancel/-stop', s.calls.some((a) => a.includes('-cancel') || a.includes('-stop')), JSON.stringify(s.calls))
    check('S1 内核租约已释放', !existsSync(s.lease))
    check('S1 会话标记已清除', !existsSync(join(s.evidenceDir, 'trace-session.json')))
    check('S1 以已取消收场（cancelled=true）', (result && result.cancelled === true) || (error && /cancel/i.test(error.message)), result ? JSON.stringify(result).slice(0, 120) : String(error && error.message))
  }

  // ---- S2 between-starts（R2：内核已起、CLR start 阶段取消抛出）----
  {
    const s = scenarioTrace('between-starts', { abortOn: 'start', clr: true })
    let result = null, error = null
    try { result = await s.run() } catch (e) { error = e }
    check('S2 启动阶段取消：trace 抛出（未静默吞掉）', Boolean(error), result ? JSON.stringify(result).slice(0, 120) : 'threw')
    check('★ S2 teardown 停掉已起的内核会话（calls 含 -cancel/-stop）', s.calls.some((a) => a.includes('-cancel') || a.includes('-stop')), JSON.stringify(s.calls))
    check('★ S2 内核租约已释放（不留孤儿）', !existsSync(s.lease))
    check('★ S2 "starting" 会话标记已清除', !existsSync(join(s.evidenceDir, 'trace-session.json')))
  }

  // ---- S3 cleanup-failure（R3：-cancel 失败不得谎报 cancelled）----
  {
    const s = scenarioTrace('cleanup-failure', { abortOn: 'wait', cancelFails: true })
    let result = null, error = null
    try { result = await s.run() } catch (e) { error = e }
    check('S3 返回结果（非抛出）', Boolean(result) && !error, error ? String(error.message) : 'ok')
    check('★ S3 不谎报 cancelled=true（收尾命令失败）', result && result.cancelled !== true, JSON.stringify(result).slice(0, 160))
    check('★ S3 落 unknown=true + incomplete=true', result && result.unknown === true && result.incomplete === true, JSON.stringify(result).slice(0, 160))
    check('★ S3 保留内核租约（收尾未确认 ⇒ 不丢会话）', existsSync(s.lease))
    // 送入真实任务层：状态应为 unknown（不是 cancelled/complete）
    const job = await runTaskTool('perf_trace', { asyncJob: true }, async () => result)
    let st
    for (let i = 0; i < 400; i++) { st = await taskControl({ jobId: job.jobId }); if (['done', 'failed', 'cancelled', 'unknown'].includes(st.state)) break; await wait(5) }
    check('★ S3 任务层裁为 unknown/incomplete（不是 cancelled）', st && st.state === 'unknown' && st.completeness === 'incomplete', st ? (st.state + '/' + st.completeness) : 'no-state')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: perf_trace cancellation (wait-success + startup-phase teardown + honest cleanup-failure)')
