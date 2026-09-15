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
import { captureStart, captureStop, captureStatus, captureStatusSummary, logGrowthWarning } from '../lib/capture-control.mjs'
import { readFileSync } from 'node:fs'

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
  // ⚠ 这条**被改过**（R1-02，2026-09-15 用户裁决）：日志存在时现在会带一条"运行中不自动轮转 + 在 C 盘"的提醒，
  //   所以不能再断言"没有 warning"。要守住的**不是**"一句都不许说"，而是"**不许报'读不到数据'那种假警报**"。
  check('起捕获：日志存在时**不报**"读不到数据"式假警报（不狼来了）',
    !Array.isArray(r.warnings) || !r.warnings.some((w) => /读不到任何数据/.test(w)), JSON.stringify(r.warnings))
  check('★ R1-02：日志存在时**要**带"不会在运行中自动轮转"的提醒（用户选的就是"起的时候说一句"）',
    Array.isArray(r.warnings) && r.warnings.some((w) => /不会在运行中自动轮转/.test(w)), JSON.stringify(r.warnings))
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

// ------------------------------------------------ 1b. R1-02：日志在 C 盘 + **运行中不自动轮转**
//
// 现场（F-056，2026-09-14 真机）：描述里写着"300MB 自动轮转"，实测那件事**只在启动那一刻成立** ——
//   `start()` 里 `if (autoRotate && !wasRunning()) { if (size > 300MB) doRotate() }`，
//   跑起来之后**没有任何**运行时轮转。而日志默认落在 `%TEMP%`（**C 盘**），r61 实测无轮转时长到 431/451 MB。
// 用户 2026-09-15 的裁决是「**改描述 + start 时告警**」两条，**不动**客户端 App.config
//   ⇒ 所以这两句必须**同时**在"导出函数的行为"和"描述文本"上被钉住（只改一头 = 名不副实）。
{
  const w = logGrowthWarning({ logExists: true, logPath: 'C:\\Users\\x\\AppData\\Local\\Temp\\uiprobe-net-trace.log', logSize: 451 * 1048576 })
  check('★ R1-02：明说"运行中不会自动轮转"，并点出**唯一那次**只在 start() 且没在跑时成立',
    /不会在运行中自动轮转/.test(w) && /start\(\)/.test(w), String(w))
  check('★ R1-02：点出默认落 **C 盘** + 给出当前大小', /C 盘/.test(w) && /451 MB/.test(w), String(w))
  check('★ R1-02：给出可执行的下一步（rotate 路由 / 面板按钮）', /capture\/rotate/.test(w) && /轮转日志/.test(w), String(w))
  check('★ R1-02：已超 300MB 时说清"下次 start 会先自动轮转一次"', /下次 start/.test(w), String(w))
  // 三态之一：日志都不在 ⇒ 这条**不报**（那是"读不到任何数据"那条的活，别重复吓人）
  check('★ R1-02：日志不存在时不报这条（与"读不到任何数据"不重复）',
    logGrowthWarning({ logExists: false, logPath: 'C:\\x.log' }) === null, '')
  // ★★ 本仓口径：拿不到就**说拿不到**，不许编一个数
  const w2 = logGrowthWarning({ logExists: true, logPath: 'C:\\x.log', logSize: null })
  check('★★ R1-02：大小拿不到 ⇒ 如实说"未读到"，**不许编一个数**',
    /未读到/.test(w2) && !/现在 \d+ MB/.test(w2), String(w2))
  check('★ R1-02：连路径都没有 ⇒ 不报（没有依据就不说）', logGrowthWarning({ logExists: true }) === null, '')
  // 假警报与假绿灯一样有害：不在 C 盘就不许说"在 C 盘"
  const w3 = logGrowthWarning({ logExists: true, logPath: 'D:\\dsh-agent-toolchain\\uiprobe-net-trace.log', logSize: 1024 })
  check('★ R1-02：不在 C 盘时**不许**说"在 C 盘"', /不在 C 盘/.test(w3), String(w3))
}

// ------------------------------------------------ 1c. R1-02 的"改描述"那半边（agent 读的就是这些字）
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check('★★ 描述里不再有**无条件的**"300MB 自动轮转"（F-056：那句话只在启动那一刻成立）',
    !/清理过期 \.bak，300MB 自动轮转/.test(src), '老话还在 ⇒ 描述仍在骗人')
  check('★★ 描述里明说"运行中不会自动轮转" + 落在 %TEMP%（C 盘）',
    /不会在运行中自动轮转/.test(src) && /%TEMP%（C 盘）/.test(src), '')
  check('★ 插件导语与 api_capture_start 的描述**都**带上这条（agent 两个地方都会读）',
    (src.match(/不会在运行中自动轮转/g) || []).length >= 2, '只有一处 ⇒ 另一半没改')
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

// ---------------------------------------------------------------- 5. R1-07：「本次已解析」必须是**本次**的增量
//
// 现场（2026-09-14 夜，真机，三个数互相印证）：
//   18:42:21 `start` 的摘要说「本次已解析 **70** 条」；
//   18:47   摘要说「本次已解析 **175** 条（见到 175 个请求）」，而**库里只有 105 条**；
//   原始 JSON：`counters.emitted = 175` 而 `integrity.emitted = 105`、`storeTotal = 105` ⇒ 175 − 70 = 105 ✔
// ⇒ `counters.emitted` 是**引擎对象创建以来**的累计值（跨越 stop/start、也跨越用户中途清库），
//   而摘要与工具描述都写"**本次**" —— 数字没错，**标签**错了；读的人会把 175 当成本次证据量。
// ⚠ 同时要说清：`integrity` 判据本身**是对的**（比值 1 ⇒ 没有重复写入）—— 坏的只是措辞。
{
  const live = {
    ok: true, running: true, logExists: true, logSize: 9093966, offset: 9093966,
    counters: { emitted: 175, requestsSeen: 175 },
    integrity: { ok: true, ratio: 1, emitted: 105, realtimeSinceStart: 105 },
  }
  const s = captureStatusSummary(live)
  check('★★ "本次已解析"用的是与自检同口径的**增量**（105），不是累计值（175）', /本次已解析 105 条/.test(s), s)
  check('★★ 累计值必须**如实标注**（否则读的人会把 175 当成本次证据量）',
    /累计 175 条/.test(s) && /含清库\/停启之前/.test(s), s)
  check('★ 不许出现"本次已解析 175"这种把累计冒充本次的写法', !/本次已解析 175/.test(s), s)
  // 拿不到增量时：退回累计值，但必须标明"累计 / 不是本次"（宁可啰嗦，不许冒充）
  const s2 = captureStatusSummary({ ok: true, running: true, logExists: true, counters: { emitted: 175, requestsSeen: 175 } })
  check('★★ 没有增量可依据时，不许把累计说成本次',
    /累计/.test(s2) && /不是["“]?本次/.test(s2) && !/本次已解析 175/.test(s2), s2)

  // ---- R1-08（同一夜、由黑盒验收 agent 独立撞出来）：自检**跑过且正常**时也必须印出来 ----
  // 原实现只在 `integrity.ok === false` 时印一句警告 ⇒ "自检正常"与"没做自检"在渲染文本里一模一样。
  // 黑盒验收原话：「描述承诺返回的 integrity 自检字段实际不存在」—— 承诺了却看不见，就是撒谎。
  check('★★ 自检正常时也要印（否则"正常"与"没做"不可区分）',
    /重复写入自检：正常/.test(s), s)
  check('★ 正常时带上可比对的量（比值 + 两侧条数），而不是一句"没问题"',
    /比值 1/.test(s) && /引擎 105 条/.test(s) && /库内 realtime 105 条/.test(s), s)
  const s3 = captureStatusSummary({
    ok: true, running: true, logExists: true, counters: { emitted: 175, requestsSeen: 175 },
    integrity: { ok: null, note: '样本太小（<10 条），暂不判定' },
  })
  check('★★ 三态齐全：暂不判定也说清"不等于没问题"',
    /暂不判定/.test(s3) && /不等于/.test(s3), s3)
  const s4 = captureStatusSummary({ ok: true, running: true, logExists: true, counters: { emitted: 5, requestsSeen: 5 } })
  check('★★ 拿不到自检结果时明说"没做"（不许静默——静默会被读成"没问题"）',
    /本次没有做/.test(s4) && /没做.*不等于.*没问题|不等于["“]?没问题/.test(s4), s4)
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 捕获控制面（起/停/查状态）—— 用假引擎，覆盖"最容易骗人的四条"')
