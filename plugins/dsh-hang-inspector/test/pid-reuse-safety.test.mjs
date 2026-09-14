// dsh-hang-inspector 安全回归：**pid 复用**下不许误杀（F-024，2026-09-12 r28 自查）
//
// 病（旧实现）：
//   `pidAlive(pid)` = `process.kill(pid, 0)` —— 只证明"**这个 pid 号**存在"，
//   **不证明它还是我起的那次监测**。而 Windows 会积极复用 pid，所以一份隔了很久的
//   `run.json` 里的 pid 完全可能已被**无关进程**占用（理论上甚至是用户的客户端）。
//   旧 `stopRun()` 会直接 `taskkill /PID <pid> /T /F` —— **杀掉那个无关进程及其整棵进程树**。
//
// 本测试用**真实的另一个进程**当"被复用的 pid 占用者"，然后要求：
//   ① 状态如实报 `exited` + `pidIdentity=reused`，且 note 里说清"不是本次监测"；
//   ② `stopRun()` **拒绝执行 taskkill**（`stopped:false` / `reason:'pid-reused'`）；
//   ③ **那个进程必须还活着** —— 这是本文件最重要的一条断言（不是看返回值，是看现实）。
//   ④ 反向控制：当命令行**确实**含 hang-loop 脚本时，仍然会正常杀掉（防"修过头"）。
import { makeHangInspector } from '../lib/hang.mjs'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

let failures = 0
const ok = (name, cond, detail = '') => {
  if (cond !== true) failures++
  console.log(`  ${cond === true ? 'ok' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** 起一个长命进程当"占用者"；extraArgs 可让命令行里出现任意字符串（用于身份正例）。 */
const spawnHolder = (extraArgs = []) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)', ...extraArgs],
    { stdio: 'ignore', windowsHide: true })
  return child
}

const makeHang = (runDir) => makeHangInspector({ runDir })

// ---------------------------------------------------------------- ① 复用的 pid：不许杀
{
  const runDir = mkdtempSync(join(tmpdir(), 'hang-pidreuse-'))
  const holder = spawnHolder()
  await sleep(600) // 等它起来
  ok('占用者进程已启动', alive(holder.pid), `pid=${holder.pid}`)

  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pid: holder.pid, startedAt: Date.now(), status: 'running', exitCode: null,
    logPath: join(runDir, 'run.log'),
  }))
  const hang = makeHang(runDir)

  const st = hang.runStatus()
  ok('★ 状态不再自称 running', st.status !== 'running', `status=${JSON.stringify(st.status)}`)
  ok('★ 状态为 exited（进程活着，但**不是我们的**）', st.status === 'exited', `status=${JSON.stringify(st.status)}`)
  ok('★ 带出 pidIdentity=reused（可核对）', st.pidIdentity === 'reused', `pidIdentity=${JSON.stringify(st.pidIdentity)}`)
  ok('★ note 明说是 pid 复用、不是本次监测', /不是本次监测/.test(String(st.note)), String(st.note).slice(0, 140))
  // ★ 自查：拒杀的理由必须**说准**。第一版文案一律说"命令行不含 hang-loop.ps1"，
  //   而下面「伪造命令行」那个用例里命令行**恰恰含**它，真正的理由是创建时间 —— 用一句可被当场证伪的
  //   解释去说明自己的行为，比不给理由更糟。
  ok('★ 拒杀理由必须与实际判据一致（此例是命令行不含脚本）', /命令行不含 hang-loop 脚本/.test(String(st.note)),
    String(st.note).slice(0, 200))

  const stop = hang.stopRun()
  ok('★ stopRun 拒绝执行（stopped:false）', stop.stopped === false, JSON.stringify(stop))
  ok('★ reason 说明是 pid 复用', stop.reason === 'pid-reused', `reason=${JSON.stringify(stop.reason)}`)
  await sleep(500)
  // ★★★ 最重要的一条：不是看它"说"没杀，而是看**那个进程还在不在**
  ok('★★ 占用者进程**仍然活着**（没有被 taskkill /T /F 误杀）', alive(holder.pid), `pid=${holder.pid}`)

  try { holder.kill() } catch { /* ignore */ }
  rmSync(runDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- ② 反向控制：身份确实是我们 → 正常杀
{
  const runDir = mkdtempSync(join(tmpdir(), 'hang-pidmatch-'))
  // 让命令行里含 `hang-loop.ps1`：身份判定应当命中
  const holder = spawnHolder(['hang-loop.ps1'])
  await sleep(600)
  ok('正例占用者已启动', alive(holder.pid), `pid=${holder.pid}`)

  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pid: holder.pid, startedAt: Date.now(), status: 'running', exitCode: null,
    logPath: join(runDir, 'run.log'),
  }))
  const hang = makeHang(runDir)
  const st = hang.runStatus()
  ok('命令行含 hang-loop 脚本时身份命中', st.pidIdentity === 'match', `pidIdentity=${JSON.stringify(st.pidIdentity)}`)
  ok('身份命中时状态仍是 running（没有把正常情形也判死）', st.status === 'running', `status=${JSON.stringify(st.status)}`)

  const stop = hang.stopRun()
  ok('身份确认后才执行停止', stop.stopped === true && stop.pidIdentity === 'match', JSON.stringify(stop))
  // ★ Codex r29 抓到的、**我自己造的**形状漂移：上一版把 killVerified 硬编码成 true，
  //   于是"taskkill 回来了但进程还活着"时，机器可读字段说"已确认退出"、而 note 说"仍存活"，同一返回里自相矛盾。
  ok('★ 三个终态字段不许有第二个真值来源（stopped === killed === killVerified）',
    stop.stopped === stop.killed && stop.killed === stop.killVerified,
    `stopped=${stop.stopped} killed=${stop.killed} killVerified=${stop.killVerified}`)
  await sleep(900)
  ok('★ 正例：该进程确实被结束了（防"修过头变成永不杀"）', !alive(holder.pid), `pid=${holder.pid} alive=${alive(holder.pid)}`)
  try { holder.kill() } catch { /* ignore */ }

  // 状态文件里应记下 pidIdentity + 判据（可核对，不只是内存里的判断）
  try {
    const saved = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    ok('状态文件里带上了 pidIdentity（可核对，不只是内存里的判断）', saved.pidIdentity === 'match', JSON.stringify(saved).slice(0, 160))
    ok('状态文件里带上了**判据**（命令行匹配 / 创建时间匹配），事后可解释为什么这么判',
      saved.pidIdentityBasis !== undefined && saved.pidIdentityBasis.commandLineMatch === true,
      JSON.stringify(saved.pidIdentityBasis))
  } catch (e) {
    ok('状态文件可读', false, String(e && e.message))
  }
  rmSync(runDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- ②b Codex r29 证伪：**伪造命令行**
// 它起了一个普通 node 进程、只在参数里带上 `hang-loop.ps1`，旧判据就把它当成监测并 `/T /F` 杀掉了。
// 现在加了第二条**不易伪造**的判据：进程创建时间必须与 run.json 的 startedAt 相符。
// 这里把 startedAt 设成 10 分钟前 —— 伪造者（此刻才启动）必然对不上。
{
  const runDir = mkdtempSync(join(tmpdir(), 'hang-pidforge-'))
  const forger = spawnHolder(['hang-loop.ps1'])
  await sleep(600)
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pid: forger.pid, startedAt: Date.now() - 10 * 60 * 1000, status: 'running', exitCode: null,
    logPath: join(runDir, 'run.log'),
  }))
  const hang = makeHang(runDir)
  const st = hang.runStatus()
  ok('命令行像监测、但创建时间对不上 ⇒ 不认（pidIdentity=reused）', st.pidIdentity === 'reused',
    `pidIdentity=${JSON.stringify(st.pidIdentity)} note=${String(st.note).slice(0, 120)}`)
  ok('★ 拒杀理由说的是**创建时间对不上**（而不是"命令行不含脚本"）',
    /创建时间与本次监测的开始时间对不上/.test(String(st.note)),
    String(st.note).slice(0, 220))
  const stop = hang.stopRun()
  ok('★ 伪造命令行也拒杀（reason=pid-reused）', stop.stopped === false && stop.reason === 'pid-reused', JSON.stringify(stop))
  await sleep(400)
  ok('★★ 伪造者进程**仍然活着**（创建时间这道判据挡住了它）', alive(forger.pid), `pid=${forger.pid}`)
  try { forger.kill() } catch { /* ignore */ }
  rmSync(runDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- ②c ★★ Codex r30 证伪：**无法确认 ≠ 可以杀**
// 它实测：`CreationDate` 解析不出来时 `creationTimeMatch=null`，而我上一版的默认值
// `ours = cmdMatch && startMatch !== false` 会把 **"无法确认"** 当成 **"是我们"** ⇒ **照样杀**。
// 对**破坏性**动作用这种默认值是错的。本用例把"拿不到创建时间"固化下来：
// run.json 不给 startedAt（⇒ ref 不是有限数 ⇒ startMatch=null），命令行则是像监测的样子。
// 期望：**拒杀**，reason=pid-identity-unknown，并且**那个进程必须还活着**。
{
  const runDir = mkdtempSync(join(tmpdir(), 'hang-pidunknown-'))
  const decoy = spawnHolder(['hang-loop.ps1'])
  await sleep(600)
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pid: decoy.pid, status: 'running', exitCode: null, logPath: join(runDir, 'run.log'),   // ★ 故意不给 startedAt
  }))
  const hang = makeHang(runDir)
  const st = hang.runStatus()
  ok('★ 命令行像监测、但**拿不到创建时间** ⇒ 记为 unknown（不是 match）', st.pidIdentity === 'unknown',
    `pidIdentity=${JSON.stringify(st.pidIdentity)}`)
  ok('★ 状态说明里点出"无法正面确认"而不是含糊过去',
    /无法\*\*正面确认\*\*|无法正面确认/.test(String(st.note)), String(st.note).slice(0, 200))
  const stop = hang.stopRun()
  ok('★★ **无法确认时不得杀**（reason=pid-identity-unknown）',
    stop.stopped === false && stop.reason === 'pid-identity-unknown', JSON.stringify(stop))
  await sleep(400)
  ok('★★ 那个进程**仍然活着**（"无法确认"没有被当成"可以杀"）', alive(decoy.pid), `pid=${decoy.pid}`)
  try { decoy.kill() } catch { /* ignore */ }
  rmSync(runDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- ③ 进程已死：沿用旧语义
{
  const runDir = mkdtempSync(join(tmpdir(), 'hang-piddead-'))
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pid: 999999, startedAt: Date.now(), status: 'running', exitCode: null, logPath: join(runDir, 'run.log'),
  }))
  const hang = makeHang(runDir)
  const st = hang.runStatus()
  ok('进程不存在 → exited', st.status === 'exited', `status=${JSON.stringify(st.status)}`)
  ok('原因仍是"进程已不在"', /进程已不在/.test(String(st.note)), String(st.note).slice(0, 120))
  const stop = hang.stopRun()
  ok('已死时 stopRun 如实说 not-running', stop.stopped === false && stop.reason === 'not-running', JSON.stringify(stop))
  rmSync(runDir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nPID-REUSE SAFETY TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nPID-REUSE SAFETY TEST PASSED')
