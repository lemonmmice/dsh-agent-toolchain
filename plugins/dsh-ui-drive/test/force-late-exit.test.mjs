// dsh-ui-drive：`ui_launch(force=true)` 在**杀进程核对窗口差一点**时的重启判决（F-039，r35）。
//
// 病（从一次**真机失败**里查出来的，不是构造的）：
//   全量测试并发跑时，`launch-force.test.mjs` 红了 2 项：
//     FAIL B forceKill 如实回报 — {"killed":false,"scope":"exe-path","pids":[6856],
//                                  "retries":1,"remaining":[6856],"waitedMs":21145,...}
//     ok   B 旧进程确实没了        ← **紧接着这一条就证明进程已经没了**
//     FAIL B 新进程起来了 — {"now":[],"before":[6856]}   ← 什么都没起来
//
//   链条：杀进程核对窗口（默认 15s）内没观察到退出 ⇒ `killed:false` ⇒
//   `driver.mjs` 的 `if (!forceKill.killed) { return ...alreadyRunning:true... }` **直接放弃、不重启**。
//   而进程其实在窗口之后**已经退出**了。
//
//   两个后果都很实：
//     ① 功能：`ui_launch(force=true)` 是**卡死重启通道**（driver 里 398-400 行写明了这是本工具链存在的意义），
//        它在这里**静默地什么都没做**；
//     ② 诚实：返回 `alreadyRunning:true` + `pid:<刚死掉的 pid>` —— **声称"还在运行"，而它已经没了**。
//        与 F-038 同一个病：**判决与它自己掌握的证据不一致**。
//   而且**负载越高越容易触发**，而负载高恰恰是客户端最容易卡死的场景。
//
// 判据（本文件要守住的）：**只有在"复核确认它还在"时才允许放弃重启**；
//   "窗口内没观察到退出" **不等于** "现在还在"。
import { forceRestartDecision } from '../lib/driver.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ── 自检：断言器不能恒真 ──
{
  let sawFail = false
  const probe = (c) => { if (!c) sawFail = true }
  probe(false)
  console.log((sawFail ? '  ok   ' : '  FAIL ') + '（自检）断言器有效')
  if (!sawFail) failures++
}

// ---------------------------------------------------------------------------
// 1. ★★ 核心：窗口内没看到退出、但复核时已没了 ⇒ **必须继续重启**
// ---------------------------------------------------------------------------
{
  const d = forceRestartDecision({ killed: false, stillHere: false })
  check('★★ killed=false 但复核后已不存在 ⇒ **proceed=true**（旧行为在这里放弃重启，什么都不做）',
    d.proceed === true, JSON.stringify(d))
  check('★ 且标注 lateExit（"晚了一步"，不是"没杀掉"）', d.lateExit === true, JSON.stringify(d))
  check('★ reason 可解释', d.reason === 'late-exit', JSON.stringify(d))
}

// ---------------------------------------------------------------------------
// 2. ★★ 反向红线：复核后**确实还在** ⇒ 绝不重启（宁可不动，也不起第二个实例）
// ---------------------------------------------------------------------------
{
  const d = forceRestartDecision({ killed: false, stillHere: true })
  check('★★ 复核后确实还在 ⇒ **proceed=false**（红线的方向不能反）', d.proceed === false, JSON.stringify(d))
  check('★ 且不标注 lateExit（它确实没退出）', d.lateExit === false, JSON.stringify(d))
  check('★ reason=still-running', d.reason === 'still-running', JSON.stringify(d))
}

// ---------------------------------------------------------------------------
// 3. 正常路径不受影响
// ---------------------------------------------------------------------------
{
  const d = forceRestartDecision({ killed: true, stillHere: false })
  check('killed=true ⇒ 正常重启、不标 lateExit', d.proceed === true && d.lateExit === false, JSON.stringify(d))
  const d2 = forceRestartDecision({ killed: true, stillHere: true })
  check('killed=true 时忽略复核结果（不会因为多看到一个同名实例就不重启 —— 那是另一条路径的事）',
    d2.proceed === true && d2.lateExit === false, JSON.stringify(d2))
}

// ---------------------------------------------------------------------------
// 4. ★★ 不变量：**stillHere === true 永远不 proceed**（这条把红线钉死）
// ---------------------------------------------------------------------------
{
  let violated = []
  for (const killed of [true, false]) {
    for (const stillHere of [true, false]) {
      const d = forceRestartDecision({ killed, stillHere })
      if (stillHere === true && d.proceed === true && killed === false) {
        violated.push({ killed, stillHere, d })
      }
    }
  }
  check('★★ 不变量：killed=false 且 stillHere=true 时**永远不** proceed（四种组合全过一遍）',
    violated.length === 0, JSON.stringify(violated))
}

// ---------------------------------------------------------------------------
// 5. 源码守卫：改动必须落在 driver 里，且旧的一票否决分支不许回来
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'driver.mjs'), 'utf8')
  check('★ 抽出了可单测的纯函数 forceRestartDecision 并导出',
    /export function forceRestartDecision\(/.test(src), '')
  check('★ launch 里走的是这个判决，而不是"看到 !killed 就直接 return"',
    /const decision = forceRestartDecision\(\{ killed: forceKill\.killed, stillHere:/.test(src), '')
  check('★ 保留"确实还在就放弃"的那条分支（红线没被顺手删掉）',
    /if \(!decision\.proceed\) \{/.test(src), '')
  check('★★ 复核按**同一套目标规则**（`targetInstancesNow()`），**不是**按进程名的粗枚举',
    /const stillHere = targetInstancesNow\(\)/.test(src), '')
  check('★★ 而且没有退回粗枚举 —— 粗枚举会把**别的会话的同名实例**也算成"还在"，于是"只杀 exe 路径匹配的那个"会被误判成没杀掉',
    !/let stillHere = listPidsByName\(c\.procName\)/.test(src), '粗枚举回来了')
  check('★ targetInstancesNow 与 killClientInstances 同源（配了 exe 路径 ⇒ 只认路径一致的）',
    /if \(want\) return insts\.filter\(\(i\) => String\(i\.path \|\| ''\)\.toLowerCase\(\) === want\)/.test(src), '')
  check('★ 复核是**有界**的（不会无限等下去）', /for \(let i = 0; i < 10 && stillHere\.length > 0; i\+\+\)/.test(src), '')
  check('★ lateExit 如实带出（调用方知道"是晚了一步，不是没杀掉"）', /lateExit: true/.test(src), '')
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : '\nPASS: force 重启判决（F-039：窗口内没看到退出 ≠ 现在还在）')
process.exit(failures ? 1 : 0)
