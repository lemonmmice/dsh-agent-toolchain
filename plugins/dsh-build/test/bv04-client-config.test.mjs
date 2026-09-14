// dsh-build BV-04 单测：客户端进程名的**三态**（未配置 / 已配置但没运行 / 正在运行）
//
// 病（2026-09-11，Codex 独立只读复核确认；我随后自己复现）：
//   `clientProcess()` 在进程名未配置时返回 `{running:false, unconfigured:true}`，
//   但 `build()` 只读 `client.running` —— 于是「**没配置**」被压成「**没在跑**」：
//     · `killClient=true` → 静默跳过 killClientProcess() → 继续构建。调用方以为锁已解除，
//       实际锁还在，最后以 MSB3021/3027 爆出来，并被归因成「参数没生效 / 客户端未运行」；
//     · 非 killClient 路径也不提示，诊断把 agent 引向"去启动客户端"这个完全错误的方向。
//
// 本单测锁死三件事：
//   1. 未配置时 clientProcess() 的三态标记（unconfigured:true）不能被压成 running:false；
//   2. killClient=true + 未配置 → **明确失败并说清怎么配**（不是静默继续，也不是"客户端未运行"）；
//   3. 渲染层：说"无法判断"而不是"没在跑"，且给的下一条建议是"配进程名"，
//      **不能**是"再传一次 killClient=true"（那在原地打转，是 BV-04 的渲染版）。
import { makeBuilder } from '../lib/builder.mjs'
import { renderBuild } from '../lib/render.mjs'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const ENV_KEYS = ['DSH_BUILD_CLIENT_PROC', 'DSH_UI_PROC_NAME']
const saved = {}
// 「未配置」用**空串**表达，不用 delete（2026-09-11，随 lib/env-fallback.mjs 一起改）：
//   delete 之后 `process.env[k]` 是 undefined，env 解析会当"进程环境里没有这个变量"而**回退到
//   用户级注册表**（本机真的配了 DSH_UI_PROC_NAME=AcmeClient），于是"未配置"这条路径在本机永远测不到。
//   空串是显式的"调用方主动清空"，解析层不会再回退 —— 这才是测试想要的语义。
for (const k of ENV_KEYS) { saved[k] = process.env[k]; process.env[k] = '' }

const root = mkdtempSync(join(tmpdir(), 'dsh-build-bv04-'))
const logsDir = mkdtempSync(join(tmpdir(), 'dsh-build-bv04-logs-'))

const dotnetOk = (() => { try { execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true }); return true } catch { return false } })()

try {
  const b = makeBuilder({ clientRoot: root, repoRoot: root, msbuild: '', engine: 'dotnet', logsDir })

  // ------------------------------------------------- 1. 三态：未配置 ≠ 没在跑
  const cp = b.clientProcess()
  check('未配置 → unconfigured:true', cp.unconfigured === true, JSON.stringify(cp))
  check('未配置 → running:false（但必须靠 unconfigured 区分）', cp.running === false, JSON.stringify(cp))
  check('未配置 → 不冒充"已配置的进程名"', cp.name === undefined, JSON.stringify(cp))

  // ------------------------------------------------- 2. killClient=true + 未配置 → 明确失败
  if (!dotnetOk) {
    console.log('  skip dotnet 不可用 → 跳过 build(killClient=true) 端到端段')
  } else {
    const r = await b.build({ engine: 'dotnet', target: 'Build', killClient: true, repoRoot: root })
    check('BV-04 killClient=true + 未配置 → ok:false（不再静默继续）', r.ok === false, JSON.stringify(r).slice(0, 260))
    check('BV-04 带 clientUnconfigured:true（数据层可判，不只是句子）', r.clientUnconfigured === true, JSON.stringify(r.clientUnconfigured))
    check('BV-04 带 clientKillSkipped:true（说清"这次 kill 没执行"）', r.clientKillSkipped === true, JSON.stringify(r.clientKillSkipped))
    check('BV-04 didNotRun:true（构建压根没开始）', r.didNotRun === true, JSON.stringify(r.didNotRun))
    check('BV-04 错误里点名要配的变量', /DSH_BUILD_CLIENT_PROC/.test(String(r.error)) && /DSH_UI_PROC_NAME/.test(String(r.error)), String(r.error).slice(0, 300))
    check('BV-04 错误明说"不是客户端未运行，是根本没配"', /不是「客户端未运行」/.test(String(r.error)), String(r.error).slice(0, 300))
    check('BV-04 失败也写 per-run 记录（runId 可查）', !!r.runId && existsSync(join(logsDir, 'run-' + r.runId + '.json')), String(r.runId))
    check('BV-04 没有真的执行构建（无 logPath）', r.logPath === null, String(r.logPath))

    // ------------------------------------------------- 3. 渲染层
    const text = renderBuild(r)
    // 注意：错误原文里有一句**否定式**"这不是「客户端未运行」，是「根本没配」"——那是正确的表述，
    // 所以这里不能简单地断言"不出现 客户端未运行 这个词"（第一版就是这么写错的，
    // 把一句好话判成了坏话）。要断言的是**正向结论**：「无法探测/无法判断」在场，
    // 且措辞里"客户端未运行"只以被否定的形式出现。
    check('BV-04 渲染给出正向结论「无法探测客户端是否在运行」', /无法探测客户端是否在运行|无法判断/.test(text), text.slice(0, 300))
    check('BV-04 渲染里"客户端未运行"只出现在被否定的那句里', !/客户端未运行/.test(text) || /不是「客户端未运行」/.test(text), text.slice(0, 300))
    check('BV-04 渲染保留原因与 runId', /进程名未配置/.test(text) && String(text).includes(String(r.runId)), text.slice(0, 420))
    check('BV-04 渲染给的下一步是"配进程名"', /DSH_BUILD_CLIENT_PROC/.test(text), text.slice(0, 400))
    check('BV-04 渲染**不再**劝"传 killClient=true"（原地打转）', !/传 killClient=true 结束客户端/.test(text), text.slice(0, 400))
    check('BV-04 失败路径也印 runId（凭证存在就必须能被找到）', /runId=/.test(text), text.slice(0, 420))
  }

  // ------------------------------------------------- 4. 非 killClient + 未配置 → 按"未知"继续，但必须自曝
  //（渲染层对合成结果的断言：真实跑一次构建太重，且这一段的语义就是"尾巴必须打出来"）
  const okUnconfigured = { ok: true, target: 'Build', durationMs: 1000, errorCount: 0, warningCount: 0, logPath: 'L.log', runId: 'r1', clientUnconfigured: true, clientUnconfiguredNote: '客户端进程名未配置（DSH_BUILD_CLIENT_PROC 与 DSH_UI_PROC_NAME 都没设），无法探测客户端是否在运行，本次构建按「未知」继续；若出现 MSB3021/3027 文件锁，先配好进程名再传 killClient=true。' }
  const t2 = renderBuild(okUnconfigured)
  check('BV-04 构建成功时也要自曝"客户端状态未知"', /无法判断|无法探测/.test(t2), t2.slice(0, 320))
  check('BV-04 自曝里点名变量', /DSH_BUILD_CLIENT_PROC/.test(t2), t2.slice(0, 320))
  // 同理：自曝文案里"客户端没在跑"也是被否定的那句，断言正向结论即可
  check('BV-04 不把"未知"说成"没在跑"（正向结论是"无法判断"）', /无法判断/.test(t2), t2.slice(0, 320))

  // clientRunningWarning（"确实在跑但与目标无关"）过去**从未被渲染**——一并钉死
  const t3 = renderBuild({ ok: true, target: 'Build', durationMs: 1000, errorCount: 0, warningCount: 0, logPath: 'L.log', clientRunningWarning: '客户端正在运行（PID 1234），但构建目标 X 与客户端本体无关，已继续构建。' })
  check('BV-04 clientRunningWarning 现在会被渲染（旧实现算了却不印）', /PID 1234/.test(t3), t3.slice(0, 320))

  // ------------------------------------------------- 5. 渲染层永不抛（BV-03 的第一原则）
  for (const v of [null, undefined, {}, { ok: false }, { ok: false, errors: [] }, { ok: false, error: 'x' }]) {
    let threw = false
    try { renderBuild(v) } catch { threw = true }
    check('renderBuild 对残缺形状不抛：' + JSON.stringify(v), threw === false)
  }
} finally {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  rmSync(root, { recursive: true, force: true })
  rmSync(logsDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: dsh-build BV-04 三态（未配置 / 未运行 / 在运行）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
