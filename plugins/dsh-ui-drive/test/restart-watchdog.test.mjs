// dsh-ui-drive 重启/僵死可靠性单测（B-2，离线：不驱动真实客户端）
//
// 背景：昨夜整晚卡在「客户端重启调用」里 2.5 小时，只靠日志时间戳才发现。
// 根因形态是：常驻进程**不会退出、也不会报错**，只是把请求吞掉 —— 只看退出码的
// 看门狗等于没有看门狗。本单测用「故意不回答的假 serve 进程」把这四件事钉死：
//   1. 看门狗按「最近一次成功动作的时间」判僵死、计数并可诊断；
//   2. 只读动作超时后**重试一次**（换新进程 + ready 握手），总时长有上限；
//   3. 副作用动作在常驻进程被看门狗重启时**绝不重放**（只报「结果未知」）；
//   4. 启动/重启类调用有硬上限：status 卡住不会把 launch 拖成无限等待。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-b2-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-b2-evidence-'))
const counterFile = join(scriptsDir, 'step-counter.txt')
const execFile = join(scriptsDir, 'exec.log')

/**
 * 假 serve 脚本：说协议、答 ping，但按模式**故意不回答某些 step 请求**
 * （模拟卡死：进程活着、不报错、只吞请求）。
 *  - mode=odd   ：第 1、3、5… 个 step 请求僵死（跨进程计数），第 2 个正常 → 验「超时后重试成功」
 *  - mode=always：所有 step 请求僵死 → 验「副作用绝不重放」
 * 计数走文件而不是环境变量：环境变量在 spawn 时就固定，重试发生在新进程里，
 * 必须让「第几次请求」跨进程可见（第一版用恢复时刻，重试恰好落在僵死窗口内又挂了一次）。
 * 另外：假体自己也得说真话——first version 用 PowerShell 单引号里的 `""` 当 JSON 转义，
 * 产出的响应是**非法 JSON**，于是 driver 永远等不到响应、被看门狗误判成僵死。
 * 假体重造现场时最容易假的地方就是它自己（这里索性不放引号，避免转义问题）。
 */
function installFakeServe({ mode = 'always' } = {}) {
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve,[string]$ScriptStamp='')
if ($Status) {
  if ($env:FAKE_STATUS_SLEEP_MS) { Start-Sleep -Milliseconds ([int]$env:FAKE_STATUS_SLEEP_MS) }
  Write-Output 'NOT_RUNNING'
  exit 2
}
if (-not $Serve) { Write-Output 'RESULT_JSON={"ok":true,"steps":[]}'; exit 0 }
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $line | ConvertFrom-Json
  if ($req.cmd -eq 'ping') { $writer.WriteLine('RESP_JSON={"id":' + $req.id + ',"ok":true,"pong":true}'); continue }
  $k = 1
  if (Test-Path $env:FAKE_COUNTER_FILE) { $k = [int]((Get-Content $env:FAKE_COUNTER_FILE -Raw).Trim()) + 1 }
  Set-Content -Path $env:FAKE_COUNTER_FILE -Value $k -Encoding ASCII
  if ($env:FAKE_EXEC_FILE) { Add-Content -Path $env:FAKE_EXEC_FILE -Value ([string]$req.action + '|' + [string]$req.name) -Encoding ASCII }
  $stall = $false
  if ($env:FAKE_STALL_MODE -eq 'always') { $stall = $true }
  elseif ($env:FAKE_STALL_MODE -eq 'odd') { $stall = (($k % 2) -eq 1) }
  if ($stall) { continue }
  $writer.WriteLine('RESP_JSON={"id":' + $req.id + ',"ok":true,"action":"' + [string]$req.action + '","count":2,"lines":["#0 [Button] A","#1 [Text] B"],"skipped":0}')
}
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_COUNTER_FILE = counterFile
  process.env.FAKE_EXEC_FILE = execFile
  process.env.FAKE_STALL_MODE = mode
  if (existsSync(counterFile)) rmSync(counterFile, { force: true })
  if (existsSync(execFile)) rmSync(execFile, { force: true })
}

const exePath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
function newDriver() {
  delete process.env.DSH_UI_SERVE
  process.env.DSH_UI_SERVE_IDLE_MS = '60000'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc', clientExe: exePath })
}

// ------------------------------------------- 1. 看门狗按「最近一次成功动作」判僵死 + 只读重试
{
  installFakeServe({ mode: 'odd' }) // 第 1 次请求僵死，第 2 次（重试）正常
  process.env.DSH_UI_STALL_MS = '1000'       // 1s 无成功响应即判僵死（默认 90s）
  const d = newDriver()
  const t0 = Date.now()
  const r = await d.drive({ action: 'read', timeoutMs: 6000 })
  const elapsed = Date.now() - t0
  const ws = d.warmStatus()
  const counter = existsSync(counterFile) ? readFileSync(counterFile, 'utf8').trim() : ''
  check('僵死请求确实被下发过 2 次（1 次僵死 + 1 次重试）', counter === '2', counter)
  check('read 超时后重试成功（换新进程）', r.ok === true && r.count === 2, JSON.stringify(r).slice(0, 200))
  check('看门狗记到一次僵死（stalls=1）', ws.stalls === 1, JSON.stringify(ws))
  check('僵死原因可诊断（lastStallReason）', /僵死/.test(ws.lastStallReason || ''), String(ws.lastStallReason))
  check('总耗时远小于请求超时上限 6s（没干等）', elapsed < 5000, elapsed + 'ms')
  check('重试后常驻进程恢复可用', ws.alive === true, JSON.stringify(ws))
  d.warmShutdown()
  delete process.env.DSH_UI_STALL_MS
}

// ------------------------------------------- 2. 副作用动作在看门狗重启时绝不重放
{
  installFakeServe({ mode: 'always' }) // 永远僵死
  process.env.DSH_UI_STALL_MS = '800'
  const d = newDriver()
  const r = await d.drive({ action: 'click', name: '保存', allowSideEffects: true, timeoutMs: 6000 })
  const execs = existsSync(execFile) ? readFileSync(execFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []
  check('副作用动作被判僵死重启 → 明确「结果未知」', r.ok === false && r.unknown === true, JSON.stringify(r))
  check('副作用动作只被下发一次（无重放）', execs.length === 1, JSON.stringify(execs))
  check('错误文案提示先复核再决定', /复核/.test(r.error || ''), String(r.error))
  d.warmShutdown()
  delete process.env.DSH_UI_STALL_MS
}

// ------------------------------------------- 3. status 超时 = 未知，不是「未运行」
{
  installFakeServe({ mode: 'never' })
  process.env.FAKE_STATUS_SLEEP_MS = '4000'
  const d = newDriver()
  const t0 = Date.now()
  const st = await d.status({ timeoutMs: 800 })
  const elapsed = Date.now() - t0
  check('status 受调用方上限约束', elapsed < 3000, elapsed + 'ms')
  check('status 超时 → unknown=true（不谎报未运行）', st.running === false && st.unknown === true, JSON.stringify(st))
  d.warmShutdown()
  delete process.env.FAKE_STATUS_SLEEP_MS
}

// ------------------------------------------- 4. launch（客户端启动/重启）有硬上限
{
  installFakeServe({ mode: 'never' })
  process.env.FAKE_STATUS_SLEEP_MS = '600' // 每次 status 都慢，逼出「剩余预算」封顶逻辑
  const d = newDriver()
  const t0 = Date.now()
  const r = await d.launch({ waitMs: 3000 })
  const elapsed = Date.now() - t0
  check('launch 在 waitMs 上限内返回（不会挂死）', elapsed < 8000, elapsed + 'ms')
  check('launch 如实报「没起来」+ 轮询心跳', r.started === false && r.polls >= 1, JSON.stringify(r))
  check('launch 的 waitedMs 与真实耗时一致（不写死 waitMs）', Math.abs(r.waitedMs - elapsed) < 1500, JSON.stringify({ waitedMs: r.waitedMs, elapsed }))
  d.warmShutdown()
  delete process.env.FAKE_STATUS_SLEEP_MS
}

// ------------------------------------------- 5. exe 不存在时立即失败，不做无意义轮询
{
  installFakeServe({ mode: 'never' })
  const d = makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc', clientExe: join(scriptsDir, 'nope.exe') })
  const t0 = Date.now()
  const r = await d.launch({ waitMs: 30000 })
  check('exe 不存在 → 立刻返回错误（不轮询 30s）', r.started === false && /不存在/.test(r.error || '') && Date.now() - t0 < 5000, JSON.stringify(r))
  d.warmShutdown()
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_COUNTER_FILE
delete process.env.FAKE_EXEC_FILE
delete process.env.FAKE_STALL_MODE

console.log(failures === 0 ? '\nPASS: ui-drive restart/watchdog unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
