// dsh-hang-inspector 端到端：**卡死 → 判定 → 证据包 → 分析**（受控受害者，不碰真客户端）
//
// 为什么要这么测（2026-09-11 实测发现）：
//   卡死监测脚本原先只存在于某台机器的本地工具目录、写死了进程名/客户端 exe/输出目录，
//   而插件默认在 `~/.dsh-agent-toolchain/` 找它 —— `hang_run` 直接失败「未找到监测脚本」，
//   即"用户报卡死"这条主线**开箱即坏**。修复（脚本进仓库 + 候选路径解析）之后，
//   必须证明它**真的能判定卡死并打包可用的证据**，而不是"文件存在"。
//
// 做法：造一个 C# 受害者窗口（自己控制），先正常响应 3 秒、再把 UI 线程堵住 8 秒；
//   监测脚本应当（a）判定卡死（b）落下 frozen-screen.png / process-info.txt / frozen.dmp / summary.txt；
//   然后用插件自己的 analyze() 分析那份 dump，要求拿到**托管线程栈**。
//   受害者进程名用拷贝出来的唯一名字（`dshtesthang.exe`），避免误匹配别的 powershell 进程。
//
// 依赖本机工具（缺失则跳过，不误报）：procdump + DumpStack（走 DSH_HANG_PROCDUMP / DSH_HANG_DUMPSTACK 或默认位置）。
import { makeHangInspector } from '../lib/hang.mjs'
import { resolveDumpTools } from '../../../lib/dump-tools.mjs'
import { homedir } from 'node:os'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, statSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// F-031（2026-09-12，r30）：受害者进程名**每次运行都不同** —— 固定名字会让两个同时跑的测试
// 互相看见对方的进程（实测：复审者直接跑单个测试文件时，本测试的断言冒出别的实例）。
// ⚠ 措辞按 @codex r32 收严：这是**概率隔离，不是唯一性保证**（`crypto.randomUUID()` 取 10 位十六进制
//   = 40 bit ≈ 1.1e12 种；两运行相撞 ≈ 9e-13）。证据目录另由 `mkdtempSync` 隔离，那是**另一层**。
const VICTIM = 'dshtesthang' + randomUUID().replace(/-/g, '').slice(0, 10)
const work = mkdtempSync(join(tmpdir(), 'hang-e2e-'))
const packs = join(work, 'packs')
mkdirSync(packs, { recursive: true })
const victimDir = join(work, 'victim')
mkdirSync(victimDir, { recursive: true })
const victimExe = join(victimDir, VICTIM + '.exe')
// **32 位**的受害者宿主：真实客户端就是 x86，而 DumpStack 也按 x86 DAC 选的
// （用 x64 宿主 + x86 DumpStack 会解析不出托管栈，那是"测试自己配错位数"，不是插件问题）。
// SysWOW64 下有 32 位 powershell.exe；没有就退回 64 位（那组断言会 skip）。
const wow = join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const hostExe = existsSync(wow) ? wow : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
copyFileSync(hostExe, victimExe)

// 工具路径**全部来自解析器**（不写死本机路径 —— 仓库文件里不允许出现私有路径，check.mjs 会拦）：
// 只要 DSH_HANG_PROCDUMP / DSH_PERF_PROCDUMP 之一配了，DumpStack 与 dac 会从同级目录推导出来。
const TOOLS = resolveDumpTools({
  procdumpEnv: ['DSH_HANG_PROCDUMP', 'DSH_PERF_PROCDUMP'],
  dumpstackEnv: ['DSH_HANG_DUMPSTACK', 'DSH_PERF_DUMPSTACK'],
  dacEnv: ['DSH_HANG_DAC_DIR', 'DSH_PERF_DAC_DIR'],
  toolsRoot: join(homedir(), '.dsh-agent-toolchain', 'tools'),
})
const procdump = TOOLS.procdump
const dumpStack = TOOLS.dumpstack
const dacDir = TOOLS.dacDir
const toolsOk = TOOLS.procdumpExists && TOOLS.dumpstackExists

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 60000, interval = 500) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(interval)
  }
}
function victimPids() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + VICTIM + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return [...out.matchAll(new RegExp('"' + VICTIM + '\\.exe","(\\d+)"', 'g'))].map((m) => Number(m[1]))
  } catch { return [] }
}
function killVictim() { for (const p of victimPids()) { try { spawn('taskkill', ['/PID', String(p), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ } } }
process.on('exit', () => { killVictim(); try { rmSync(work, { recursive: true, force: true }) } catch { /* ignore */ } })

// 受害者：Shown 后先响应 3s，再把 UI 线程堵 8s
const victimScript = join(victimDir, 'victim.ps1')
const BOM = '\uFEFF'
const victimBody = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms','System.Drawing') -TypeDefinition @"
using System;
using System.Threading;
using System.Windows.Forms;
public class HangVictim {
  [STAThread]
  public static void Run(int blockMs) {
    Application.EnableVisualStyles();
    var f = new Form();
    f.Text = "HangVictimWindow";
    f.Width = 320; f.Height = 140;
    f.Shown += (s, e) => {
      // **周期性**堵：每 12s 堵 6s，而不是"只堵一次"。
      // 教训（第一版）：只堵一次时，如果那 8 秒正好被监测脚本的"等窗口就绪"阶段吃掉，
      // 监测循环开始后窗口已经恢复 → 永远检测不到 → 表现为"监测没工作"，其实是**受害者设计错**。
      var t = new System.Windows.Forms.Timer(); t.Interval = 12000;
      t.Tick += (a, b) => { Thread.Sleep(blockMs); };   // C# 事件处理器在 UI 线程上 → 真的堵住消息泵
      t.Start();
    };
    Application.Run(f);
  }
}
"@
Write-Output ("VICTIM_PID=" + $PID)
[HangVictim]::Run(6000)
`
const { writeFileSync } = await import('node:fs')
writeFileSync(victimScript, BOM + victimBody, 'utf8')

let victim = null
try {
  victim = spawn(victimExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', victimScript], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
  victim.stdout.on('data', () => {})
  const started = await waitFor(() => victimPids().length > 0, 20000, 300)
  check('受控受害者进程已启动（唯一名字，避免误匹配别的 powershell）', !!started, JSON.stringify(victimPids()))

  const insp = makeHangInspector({
    procName: VICTIM,
    packs,
    uiDrive: work,
    runDir: join(work, 'run'),
    pwsh: 'powershell.exe',
    procdump,
    dumpStack,
    dacDir,
    srcRoot: '',
    probeTimeoutMs: 1500,
    intervalMs: 1000,
    consecutive: 1,
  })

  const st = insp.runStatus()
  check('监测脚本解析到了**仓库自带副本**（不再是"未找到监测脚本"）', st.monitor.scriptExists === true && /plugins[\\/]dsh-hang-inspector[\\/]scripts/.test(st.monitor.scriptPath), JSON.stringify(st.monitor).slice(0, 300))

  const run = insp.startRun({ maxSeconds: 90 })
  check('监测启动成功（ok:true）', run.ok === true, JSON.stringify(run).slice(0, 240))

  // 等一个证据包出现（受害者每 12s 堵 6s；监测每 1s 探一次、1.5s 超时判定）
  const pack = await waitFor(() => {
    const entry = readdirSync(packs, { withFileTypes: true }).filter((e) => e.isDirectory())[0]
    if (!entry) return null
    const dir = join(packs, entry.name)
    return existsSync(join(dir, 'summary.txt')) ? dir : null
  }, 75000, 500)
  check('★监测量到了卡死并落下证据包', !!pack, 'packs=' + JSON.stringify(readdirSync(packs)))
  if (!pack) {
    // 失败时必须把**监测脚本自己的日志**打出来：否则只能靠猜（"没检测到"有太多种原因）
    const lp = join(work, 'run', 'run.log')
    console.log('  --- 监测日志尾部 ---')
    console.log(existsSync(lp) ? readFileSync(lp, 'utf8').split('\n').slice(-25).join('\n') : '(无 run.log)')
    console.log('  受害者进程：' + JSON.stringify(victimPids()))
  }

  if (pack) {
    const files = readdirSync(pack)
    console.log('  证据包内容：' + files.join(', '))
    const summary = readFileSync(join(pack, 'summary.txt'), 'utf8')
    check('★summary 明确写出"判定卡死"与原因', /卡死/.test(summary) && /未响应/.test(summary), summary.split('\n').slice(0, 3).join(' / ').slice(0, 200))
    check('★冻结截图存在且非空', files.includes('frozen-screen.png') && statSync(join(pack, 'frozen-screen.png')).size > 1000, JSON.stringify(files.filter((f) => f.endsWith('.png'))))
    const pinfo = join(pack, 'process-info.txt')
    check('进程信息存在且含关键字段（CPU/Threads/Responding）', existsSync(pinfo) && /Responding=/.test(readFileSync(pinfo, 'utf8')), existsSync(pinfo) ? readFileSync(pinfo, 'utf8').split('\n').slice(0, 3).join(' / ') : 'missing')
    if (toolsOk) {
      check('★完整 dump 已生成（面板/分析器靠这个名字找它）', files.includes('frozen.dmp') && statSync(join(pack, 'frozen.dmp')).size > 1024 * 1024, JSON.stringify(files.filter((f) => f.endsWith('.dmp'))))
    } else {
      console.log('  skip 未找到 procdump/DumpStack → 跳过 dump 相关断言')
    }

    // 分析：dump → 托管线程栈（插件自己的 analyze 路径）
    if (toolsOk && files.includes('frozen.dmp')) {
      const id = pack.split(/[\\/]/).pop()
      const a = await insp.analyze(id)
      check('★analyze 跑通并产出分析结果', a && (a.ok === true || a.uiThread || a.threadCount), JSON.stringify(a).slice(0, 240))
      const detail = insp.packDetail(id)
      check('packDetail 能看到分析文件', !!detail && Array.isArray(detail.files) && detail.files.some((f) => /analysis/i.test(f.name)), JSON.stringify(detail && detail.files).slice(0, 240))
    }
  }
} finally {
  try { killVictim() } catch { /* ignore */ }
  try { if (victim) victim.kill() } catch { /* ignore */ }
  await sleep(500)
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* best effort */ }
}

console.log(failures === 0 ? '\nPASS: 卡死端到端（受控受害者 → 判定 → 证据包 → dump 分析）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
