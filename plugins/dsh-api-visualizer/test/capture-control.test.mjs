// 捕获控制面（起/停/查状态）的单测 —— **用假引擎**，不碰真捕获、不碰客户端、不写库。
//
// 为什么值得单独测（两个 G1 黑盒 agent 独立点名的缺口）：
//   在补这三个工具之前，工具目录里**没有任何东西**能启动实时捕获，而 `api_capture_query` 的描述
//   却写着"需要当前流量请先 POST /api/dsh-api-visualizer/capture/start" —— 目录又没给 host/port，
//   agent 连 URL 都拼不出来。补上之后，"能不能起"这件事第一次有了可测的入口。
//
// 本文件刻意覆盖**最容易骗人的几条**：
//   · 跟踪日志不存在时**不能**回一个"成功"让人以为在抓（实测踩过：静默变成"读空气"）；
//   · 捕获运行中改路径必须**把可操作的原因传出去**（旧实现漏了 try/catch ⇒ 宿主把它变成空 400）；
//   · 归因旁路日志不在时，要说明"caller 为空 ≠ 没有调用方"；
//   · 状态里"在跑"与"抓得到"是两件事（引擎 running=true 但日志不存在 ⇒ 读不到任何流量）。
import { captureStart, captureStop, captureStatus, captureStatusSummary } from '../lib/capture-control.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 假引擎：记录调用、可切换"日志存在吗/正在跑吗"。 */
function fakeEngine({ logExists = true, callerLogExists = true, running = false, throwOnSetLogPath = null } = {}) {
  const calls = []
  const st = () => ({
    running,
    logPath: 'C:\\tmp\\uiprobe-net-trace.log',
    logExists,
    logSize: logExists ? 123456 : null,
    offset: 100,
    replay: false,
    errors: 0,
    counters: { sees: 1, requestsSeen: 7, emitted: 6, droppedNoStatus: 0 },
    caller: { running: true, logPath: 'C:\\tmp\\uiprobe-caller.log', logExists: callerLogExists, errors: 0 },
  })
  return {
    calls,
    status: () => { calls.push('status'); return st() },
    start: (o) => { calls.push('start:' + JSON.stringify(o ?? {})); running = true },
    stop: () => { calls.push('stop'); running = false },
    setLogPath: (p) => {
      calls.push('setLogPath:' + p)
      if (throwOnSetLogPath) throw new Error(throwOnSetLogPath)
    },
  }
}

// ---------------------------------------------------------------- 1. 起捕获
{
  const eng = fakeEngine()
  const r = captureStart(eng, {})
  check('起捕获：ok=true 且引擎真的被调用', r.ok === true && eng.calls.some((c) => c.startsWith('start:')), JSON.stringify(eng.calls))
  check('起捕获：带回状态（running=true）', r.running === true)
  check('起捕获：日志存在时**不**报 warning（不狼来了）', r.warnings === undefined, JSON.stringify(r.warnings))
}
{
  const eng = fakeEngine({ logExists: false })
  const r = captureStart(eng, {})
  check('★ 日志不存在：仍然 ok=true，但**必须**带 warning', r.ok === true && Array.isArray(r.warnings) && r.warnings.length >= 1, JSON.stringify(r.warnings))
  check('★ warning 明说"读不到任何数据"（而不是让人以为在抓）', /读不到任何数据/.test(r.warnings[0]), r.warnings[0])
  check('★ warning 指出多半是"客户端没重启/注入没生效"', /重启客户端|system\.diagnostics/.test(r.warnings[0]), r.warnings[0])
}
{
  const eng = fakeEngine({ callerLogExists: false })
  const r = captureStart(eng, {})
  check('★ 归因旁路日志不在：带 warning，且写明"caller 为空 ≠ 没有调用方"',
    Array.isArray(r.warnings) && r.warnings.some((w) => /没有调用方/.test(w)), JSON.stringify(r.warnings))
}
{
  const eng = fakeEngine({ throwOnSetLogPath: 'capture running; stop it before changing logPath' })
  const r = captureStart(eng, { logPath: 'C:\\other.log' })
  check('★ 运行中改路径：ok=false 且**原样带出**引擎给的原因', r.ok === false && /capture running/.test(r.error), JSON.stringify(r))
  check('★ 并且给出下一步（先停再改再起）', typeof r.hint === 'string' && /先停止捕获/.test(r.hint), String(r.hint))
  check('★ 失败时**没有**偷偷启动', !eng.calls.some((c) => c.startsWith('start:')), JSON.stringify(eng.calls))
}
{
  const r = captureStart(null, {})
  check('引擎不可用时明确失败（不是静默成功）', r.ok === false && /引擎不可用/.test(r.error), JSON.stringify(r))
}

// ---------------------------------------------------------------- 2. 停 / 查
{
  const eng = fakeEngine({ running: true })
  const r = captureStop(eng)
  check('停捕获：ok=true 且引擎被调用', r.ok === true && eng.calls.includes('stop'), JSON.stringify(eng.calls))
  check('停捕获：返回停止后的状态（running=false）', r.running === false)
}
{
  const eng = fakeEngine({ running: true, logExists: true })
  const r = captureStatus(eng, { storeTotal: 42 })
  check('查状态：带回引擎状态 + 宿主补充的计数', r.ok === true && r.running === true && r.storeTotal === 42, JSON.stringify(r))
  check('查状态：**只读**（没调 start/stop）', !eng.calls.includes('start:{}') && !eng.calls.includes('stop'), JSON.stringify(eng.calls))
}

// ---------------------------------------------------------------- 3. 人话总结（"能不能抓到东西"必须一眼看出）
{
  const s1 = captureStatusSummary({ ok: true, running: true, logExists: true, logSize: 2048, offset: 100, counters: { emitted: 6, requestsSeen: 7 } })
  check('总结：正在捕获 + 日志大小 + 已解析条数', /正在捕获/.test(s1) && /2KB/.test(s1) && /6 条/.test(s1), s1)
  const s2 = captureStatusSummary({ ok: true, running: true, logExists: false })
  check('★ 总结：running=true 但日志不存在 ⇒ 必须写"抓不到任何流量"（两件事不是一回事）', /抓不到任何流量/.test(s2), s2)
  const s3 = captureStatusSummary({ ok: true, running: false, storeTotal: 999 })
  check('★ 总结：没在跑时明说"下面看到的是历史数据"', /未在捕获/.test(s3) && /历史数据/.test(s3), s3)
  const s4 = captureStatusSummary({ ok: false, error: '宿主没加载' })
  check('总结：失败时把原因写出来', /宿主没加载/.test(s4), s4)
  const s5 = captureStatusSummary({ ok: true, running: true, logExists: true, caller: { logExists: false } })
  check('★ 总结：归因不可用时点名（caller 为空的原因在别处）', /调用方归因不可用/.test(s5), s5)
}

// ---------------------------------------------------------------- 4. 重复写入判定（r39 真机 2× 的检出器）
{
  const { doubleWriteVerdict } = await import('../lib/capture-control.mjs')

  const bad = doubleWriteVerdict({ emitted: 3381, realtimeSinceStart: 6762 })
  check('★ 比值 2.00 必须判为"疑似重复写入"', bad && bad.ok === false && bad.ratio === 2, JSON.stringify(bad))
  check('★ 文案说清后果（面板里的调用次数被放大）', bad && /调用次数被放大/.test(bad.note), bad && bad.note)
  check('★ 文案给出可执行的下一步（重启宿主）', bad && /重启 DSH 宿主/.test(bad.note))
  check('比值 1.00 判为正常', (() => { const v = doubleWriteVerdict({ emitted: 100, realtimeSinceStart: 100 }); return v && v.ok === true && v.ratio === 1 })())
  check('比值 1.2 不算重复（留出抖动余量）', doubleWriteVerdict({ emitted: 100, realtimeSinceStart: 120 }).ok === true)
  check('比值 1.5 起判为异常（门限就是 1.5）', doubleWriteVerdict({ emitted: 100, realtimeSinceStart: 150 }).ok === false)
  // ⚠ 这一条的**判断被改过**：原来"样本太小"返回 null；而 null 与"没问题"在调用方看来容易混。
  //   现在返回 `{ok:null, note:'…暂不判定…'}` —— 显式三态（true/false/null），而 null 自带一句"这是还不知道"。
  // ⚠ 门槛从 20 改成 10（被自己的测试逼出来的）：这个客户端 **~4 条/分钟**，
  //   若门槛 20，采 90 秒只采到 ~6 条 ⇒ 检测器**永远不下结论**（等于没用）。
  //   比值型判据在**单边**上安全：库里的条目不可能合理地多于引擎 emit 的数。
  check('★ 样本太小（<10 条）**不下结论**，且是显式三态 ok:null', (() => { const v = doubleWriteVerdict({ emitted: 5, realtimeSinceStart: 10 }); return v && v.ok === null && /暂不判定/.test(v.note) })())
  check('★ 缺字段返回 null（"没有数据"与"样本太小"必须分开）', doubleWriteVerdict({ emitted: null, realtimeSinceStart: 10 }) === null)
  check('★ emitted=0（窗口里没请求）返回 ok:null 而不是"正常"', (() => { const v = doubleWriteVerdict({ emitted: 0, realtimeSinceStart: 0 }); return v && v.ok === null && /无法判定/.test(v.note) })())
  // 采样式判定：两个量取自同一窗口的**增量**
  const { sampleDeltaVerdict } = await import('../lib/capture-control.mjs')
  const vSample = sampleDeltaVerdict({ emitted: 100, realtimeCount: 500 }, { emitted: 112, realtimeCount: 524 })
  check('★ 采样增量比值 2.0 判为重复写入', vSample.ok === false && vSample.emittedDelta === 12 && vSample.storeDelta === 24, JSON.stringify(vSample))
  const vSampleOk = sampleDeltaVerdict({ emitted: 100, realtimeCount: 500 }, { emitted: 112, realtimeCount: 512 })
  check('采样增量比值 1.0 判为正常', vSampleOk.ok === true, JSON.stringify(vSampleOk))
  const vZero = sampleDeltaVerdict({ emitted: 100, realtimeCount: 500 }, { emitted: 100, realtimeCount: 500 })
  check('★ 窗口里引擎没产出 ⇒ 说"无法判定"（而不是当成 1.00 的正常）', vZero.ok === null && /无法判定/.test(vZero.note), JSON.stringify(vZero))
  const s6 = captureStatusSummary({ ok: true, running: true, logExists: true, counters: { emitted: 3381, requestsSeen: 3381 }, integrity: bad })
  check('★ 判定进入"人话总结"（不能只藏在字段里）', /疑似重复写入/.test(s6) && /重启 DSH 宿主/.test(s6), s6)
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 捕获控制面（起/停/查状态）—— 用假引擎，覆盖"最容易骗人的四条"')
