// dsh-build killClient 单测（B-3 + 2026-09-11 复核修正）
//
// 背景一（昨夜）：两次构建失败于文件锁（共享依赖 DLL 被运行中的客户端占着），调用方传了
// killClient=true 却没生效，被归因成「参数没生效」。真根因是**门控**：
// touchesClientOutput（目标程序集名 == 客户端进程名）为假时 kill 分支根本不执行。
//
// 背景二（2026-09-11 Codex 复核判的 blocker）：修完门控后，「按镜像名列出全部同名 PID 并全杀」
// 会误杀其他会话/用户的同名进程 —— 触犯「不误杀非目标进程」红线。本测试用**两个不同目录下的
// 同名假客户端**把实例定位规则钉死：
//   1) 配了 DSH_BUILD_CLIENT_EXE → 只杀路径一致的那个；
//   2) 没配路径但只有 1 个实例 → 杀（无歧义）；
//   3) 没配路径且有 ≥2 个实例 → **拒绝强杀**（refused），一个都不杀，并给出可读错误；
//   4) 退出判据只轮询本次真正杀掉的 PID（别的实例还在，也不能误报失败）。
//
// 假客户端 = 复制一份 ping.exe 改名（真实存在、可控、绝不误伤别人的进程）。
import { makeBuilder } from '../lib/builder.mjs'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-build-b3-'))
const dirA = join(root, 'sessionA')
const dirB = join(root, 'sessionB')
mkdirSync(dirA, { recursive: true })
mkdirSync(dirB, { recursive: true })
const exeName = 'dshtestclient'
const exeA = join(dirA, exeName + '.exe')
const exeB = join(dirB, exeName + '.exe')
for (const p of [exeA, exeB]) copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), p)

const b = makeBuilder({ repoRoot: root, logsDir: root })
process.env.DSH_BUILD_CLIENT_PROC = exeName
process.env.DSH_BUILD_KILL_WAIT_MS = '10000'

function startFake(exePath) {
  const child = spawn(exePath, ['-n', '600', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child
}
function killAll() {
  for (const pid of b.listClientPids(exeName)) {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 开跑前先清掉**上一次崩掉留下的**同名假客户端：否则「枚举到 2 个实例」这类断言会被
// 残留进程污染（实测踩过：上一轮 rmSync 失败后残留一个，导致本轮 5 条无谓红灯）。
for (const pid of b.listClientPids(exeName)) {
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
}
await sleep(600)

// ------------------------------------------- 1. 单实例：定位 + 杀 + 等真退出
{
  check('未启动时 clientProcess.running=false', b.clientProcess().running === false, JSON.stringify(b.clientProcess()))
  startFake(exeA)
  await sleep(1200)
  const c = b.clientProcess()
  check('启动后按进程名定位到进程', c.running === true && c.pids.length === 1, JSON.stringify(c))
  check('isPidAlive 对活进程返回 true', b.isPidAlive(c.pid) === true, String(c.pid))

  const t0 = Date.now()
  const k = await b.killClientProcess(c)
  const elapsed = Date.now() - t0
  check('单实例：scope=single-instance 且已结束', k.killed === true && k.scope === 'single-instance', JSON.stringify(k).slice(0, 200))
  check('单实例：进程确实没了（按 PID 判定）', b.isPidAlive(k.pids[0]) === false, JSON.stringify(k.pids))
  check('等待时间真实记录（不是写死的 1500）', k.waitedMs > 0 && elapsed >= k.waitedMs, JSON.stringify({ waitedMs: k.waitedMs, elapsed }))
  check('不存在的进程名 → 空列表（不误伤）', b.listClientPids('dsh-definitely-not-real-xyz').length === 0)
}

// ------------------------------------------- 2. 多实例：拒绝误杀 / 按 exe 路径精确命中
{
  killAll()
  await sleep(600)
  startFake(exeA)
  startFake(exeB)
  await sleep(1600)
  const insts = b.clientInstances(exeName)
  check('枚举到 2 个同名实例（路径可区分）', insts.length === 2 && insts.filter((i) => i.path).length === 2, JSON.stringify(insts))
  check('两个实例路径不同', insts.length === 2 && String(insts[0].path).toLowerCase() !== String(insts[1].path).toLowerCase(), JSON.stringify(insts.map((i) => i.path)))

  // 2a) 没配 DSH_BUILD_CLIENT_EXE → 拒绝强杀，一个都不能死
  delete process.env.DSH_BUILD_CLIENT_EXE
  const refuse = await b.killClientProcess(b.clientProcess())
  check('多实例无路径 → refused 且 scope=ambiguous', refuse.refused === true && refuse.scope === 'ambiguous', JSON.stringify(refuse).slice(0, 220))
  check('拒绝时**一个都没杀**', refuse.pids.length === 0 && b.clientProcess().pids.length === 2, JSON.stringify({ killedPids: refuse.pids, alive: b.clientProcess().pids }))
  check('拒绝时给出可执行指引（提示配 DSH_BUILD_CLIENT_EXE）', /DSH_BUILD_CLIENT_EXE/.test(refuse.error || ''), String(refuse.error).slice(0, 160))

  // 2b) 配了指向 B 的路径 → 只杀 B，A 必须活着
  process.env.DSH_BUILD_CLIENT_EXE = exeB
  const hit = await b.killClientProcess(b.clientProcess())
  const aliveAfter = b.clientProcess().pids
  check('配了 exe 路径 → scope=exe-path 且 killed', hit.killed === true && hit.scope === 'exe-path', JSON.stringify(hit).slice(0, 220))
  check('只杀了 1 个（精确命中）', hit.pids.length === 1, JSON.stringify(hit.pids))
  check('另一个会话的同名实例还活着（没误杀）', aliveAfter.length === 1 && aliveAfter[0] !== hit.pids[0], JSON.stringify({ aliveAfter, killed: hit.pids }))

  // 2c) 配了不存在的路径 → 拒绝
  process.env.DSH_BUILD_CLIENT_EXE = join(dirB, 'nope.exe')
  const nomatch = await b.killClientProcess(b.clientProcess())
  check('路径不匹配 → refused（不猜、不错杀）', nomatch.refused === true && nomatch.scope === 'exe-path', JSON.stringify(nomatch).slice(0, 200))
  check('路径不匹配时剩余实例仍在运行', b.clientProcess().pids.length === 1, JSON.stringify(b.clientProcess().pids))
  killAll()
  await sleep(600)
}

// ------------------------------------------- 3. build(killClient=true)：门控已去掉 + 歧义 fail closed
{
  const dotnetOk = (() => { try { execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true }); return true } catch { return false } })()
  if (!dotnetOk) {
    console.log('  skip dotnet 引擎不可用 → 跳过 build(killClient) 端到端两段')
  } else {
    // 3a) 单实例 + 目标与客户端无关 → 照样杀（旧实现会因 touchesClientOutput=false 跳过）
    delete process.env.DSH_BUILD_CLIENT_EXE
    startFake(exeA)
    await sleep(1400)
    const r1 = await b.build({ engine: 'dotnet', target: 'Build', killClient: true, repoRoot: root })
    check('build：目标无关时也执行 kill（门控已去掉）', r1.clientWasKilled === true, JSON.stringify({ killed: r1.clientWasKilled, err: r1.error, warning: r1.warning }))
    check('build：带 clientKill 明细且 killed=true', !!(r1.clientKill && r1.clientKill.killed === true), JSON.stringify(r1.clientKill))
    check('build：假客户端确实没了', b.listClientPids(exeName).length === 0, JSON.stringify(b.listClientPids(exeName)))

    // 3b) 多实例歧义 → fail closed（宁可构建失败，也不误杀）
    startFake(exeA)
    startFake(exeB)
    await sleep(1600)
    const r2 = await b.build({ engine: 'dotnet', target: 'Build', killClient: true, repoRoot: root })
    check('build：多实例歧义 → refused + ok=false（fail closed）', r2.ok === false && r2.refused === true, JSON.stringify({ ok: r2.ok, refused: r2.refused, err: String(r2.error || '').slice(0, 140) }))
    check('build：拒绝时两个实例都还在', b.listClientPids(exeName).length === 2, JSON.stringify(b.listClientPids(exeName)))
    killAll()
    await sleep(500)
  }
}

// ------------------------------------------- 4. MSB3021/3027 报文里的被锁文件解析
{
  const errs = [
    { code: 'MSB3021', message: '无法将文件"obj\\Debug\\Chart.Core.dll"复制到"..\\Bin\\Chart.Core.dll"。文件正由另一进程使用，因此该进程无法访问此文件。' },
    { code: 'MSB3027', message: '无法复制"a\\b\\Shared.Core.dll"…' },
    { code: 'CS1002', message: '应输入 ;' },
  ]
  const files = b.lockedFilesOf(errs)
  check('解析出被锁文件（中文报文引号路径）', files.includes('obj\\Debug\\Chart.Core.dll') && files.includes('..\\Bin\\Chart.Core.dll'), JSON.stringify(files))
  check('去重且带第二个文件', files.filter((f) => f.endsWith('Shared.Core.dll')).length === 1, JSON.stringify(files))
  check('无引号报文不炸', Array.isArray(b.lockedFilesOf([{ code: 'MSB3021', message: '空' }])), '')
}

/** 等所有假客户端真的退出（taskkill 是异步的：没退出时 exe 仍被锁，rmSync 会 EPERM —— 这正是 B-3 的现场）。 */
async function waitForNoClients(maxMs = 8000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (b.listClientPids(exeName).length === 0) return true
    await sleep(200)
  }
  return b.listClientPids(exeName).length === 0
}

killAll()
const gone = await waitForNoClients()
if (!gone) console.log('  提示：仍有假客户端残留（' + JSON.stringify(b.listClientPids(exeName)) + '），仅影响临时目录清理')
try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch (e) { console.log('  提示：临时目录清理失败（' + String(e.message).slice(0, 80) + '），不影响上面的结论') }
delete process.env.DSH_BUILD_CLIENT_PROC
delete process.env.DSH_BUILD_KILL_WAIT_MS
delete process.env.DSH_BUILD_CLIENT_EXE

console.log(failures === 0 ? '\nPASS: dsh-build killClient unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
