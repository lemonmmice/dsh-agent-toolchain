// F05 回归：采样期间被取消时，(1) 等待立刻醒来（不干等满 seconds），(2) 收尾用独立信号跑完 —— 真的发出
//   停止/取消命令并释放内核租约，而不是被主任务的取消把收尾也挡掉、留下一直写 etl 的孤儿会话。
//   复刻审查 19b-task-probes 的 traceCancel 反例（启动后约 50ms abort，命令里原先只有权限检查 + -start）。
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { makeTrace } from '../lib/trace.mjs'
import { withTaskContext } from '../../../lib/task-context.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }

const dir = mkdtempSync(join(tmpdir(), 'trace-cancel-'))
try {
  const evidenceDir = join(dir, 'evidence')
  const lease = join(dir, 'kernel-lease.json')
  const calls = []
  const controller = new AbortController()
  const success = () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
  const trace = makeTrace({
    evidenceDir,
    kernelLeaseFile: lease,
    wpr: process.execPath,     // 存在即可（真正命令走注入的 runExe）
    xperf: process.execPath,
    runExe: async (_exe, args) => {
      calls.push(args)
      if (args.includes('-Command')) return { ...success(), stdout: 'True' }   // 提权自检 → 已提权
      if (args.includes('-start')) setTimeout(() => controller.abort(new Error('fixture cancellation')), 50)
      return success()
    },
  })

  const started = Date.now()
  let error = null
  let result = null
  try {
    result = await withTaskContext({ signal: controller.signal }, () => trace.trace({ action: 'run', seconds: 3, skipPreflight: true, engine: 'wpr' }))
  } catch (e) { error = e }
  const elapsed = Date.now() - started

  check('等待响应取消：远早于 seconds(3s) 就返回', elapsed < 2500, elapsed + 'ms')
  check('★ 取消后仍发出收尾命令（-cancel / -stop），不是只有权限检查 + -start', calls.some((a) => a.includes('-cancel') || a.includes('-stop')), JSON.stringify(calls))
  check('★ 内核租约已释放（不残留孤儿会话标记）', !existsSync(lease))
  check('会话标记文件也已清除', !existsSync(join(evidenceDir, 'trace-session.json')))
  check('run 以"已取消"收场（返回 cancelled，而不是把取消吞掉当成功）', (result && result.cancelled === true) || (error && /cancel/i.test(error.message)), result ? JSON.stringify(result).slice(0, 120) : String(error && error.message))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: perf_trace run cancellation (abortable wait + cleanup runs under independent signal + lease released)')
