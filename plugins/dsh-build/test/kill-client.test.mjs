// dsh-build killClient 单测（B-3）
//
// 背景：昨夜两次构建失败于文件锁（共享依赖 DLL 被运行中的客户端占着），调用方传了
// killClient=true 却没生效，于是被归因成「参数没生效」。真根因是**门控**：
// `touchesClientOutput`（目标程序集名 == 客户端进程名）为假时，kill 分支根本不执行。
//
// 本单测用「复制一份 ping.exe 并改名」造一个**真实存在、可控、绝不误伤**的假客户端进程：
//   1. 能按进程名列出全部 PID（目标实例定位，不宽匹配）；
//   2. killClientProcess 会**等进程真的退出**才返回（旧实现固定 sleep 1.5s 不算等）；
//   3. build(killClient=true) 在「目标与客户端无关」时**同样**结束客户端（这正是旧 bug）；
//   4. MSB3021/3027 报文里的被锁文件能被解析出来（中文报文的引号路径）。
import { makeBuilder } from '../lib/builder.mjs'
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-build-b3-'))
const exeName = 'dshtestclient'
const exePath = join(dir, exeName + '.exe')
copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), exePath)

/** 起一个假客户端：ping -n 600 会老老实实跑 10 分钟，直到被杀。 */
function startFakeClient() {
  const child = spawn(exePath, ['-n', '600', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child
}

const b = makeBuilder({ repoRoot: dir, logsDir: dir })
process.env.DSH_BUILD_CLIENT_PROC = exeName
process.env.DSH_BUILD_KILL_WAIT_MS = '10000'

// ------------------------------------------- 1. 目标实例定位：列全部 PID
{
  check('未启动时 clientProcess.running=false 且有 pids 字段', (() => { const c = b.clientProcess(); return c.running === false && Array.isArray(c.pids) })(), JSON.stringify(b.clientProcess()))
  startFakeClient()
  await new Promise((r) => setTimeout(r, 1200))
  const c = b.clientProcess()
  check('启动后按进程名定位到进程', c.running === true && c.pids.length >= 1, JSON.stringify(c))
  check('PID 是数字且与 pid 字段一致', Number.isInteger(c.pid) && c.pids.includes(c.pid), JSON.stringify(c))

  // ------------------------------------------- 2. 杀 + 等它真的退出
  const t0 = Date.now()
  const k = await b.killClientProcess(c)
  const elapsed = Date.now() - t0
  check('killClientProcess 报告已结束', k.killed === true && k.remaining.length === 0, JSON.stringify(k))
  check('复检：进程列表已经空', b.listClientPids(exeName).length === 0, JSON.stringify(b.listClientPids(exeName)))
  check('等待时间真实记录（不是写死的 1500）', k.waitedMs > 0 && elapsed >= k.waitedMs, JSON.stringify({ waitedMs: k.waitedMs, elapsed }))
  check('不存在的进程名 → 空列表（不误伤）', b.listClientPids('dsh-definitely-not-real-xyz').length === 0)
}

// ------------------------------------------- 3. build(killClient=true) 在「目标无关」时也必须生效
{
  startFakeClient()
  await new Promise((r) => setTimeout(r, 1200))
  const runningBefore = b.clientProcess().running
  let dotnetOk = true
  try { execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true }) } catch { dotnetOk = false }
  if (!runningBefore) {
    check('（前置）假客户端已启动', false, '未起来，无法验证 build 路径')
  } else if (!dotnetOk) {
    console.log('  skip dotnet 引擎不可用 → 跳过 build(killClient) 端到端这一段（CI 上应可用）')
  } else {
    // 关键：不传 project → 临时目录里没有解决方案 → targetArg 为空 → touchesClientOutput=false，
    // 旧实现据此**跳过 kill**。这里断言它现在照样杀。
    const r = await b.build({ engine: 'dotnet', target: 'Build', killClient: true, repoRoot: dir })
    check('build 返回 clientWasKilled=true（门控已去掉）', r.clientWasKilled === true, JSON.stringify({ clientWasKilled: r.clientWasKilled, error: r.error, warning: r.warning }))
    check('build 带 clientKill 明细且 killed=true', !!(r.clientKill && r.clientKill.killed === true), JSON.stringify(r.clientKill))
    check('构建结束后假客户端确实没了', b.listClientPids(exeName).length === 0, JSON.stringify(b.listClientPids(exeName)))
  }
  // 收尾：无论上面走哪条分支，确保假进程不残留
  for (const pid of b.listClientPids(exeName)) {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
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

rmSync(dir, { recursive: true, force: true })
delete process.env.DSH_BUILD_CLIENT_PROC
delete process.env.DSH_BUILD_KILL_WAIT_MS

console.log(failures === 0 ? '\nPASS: dsh-build killClient unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
