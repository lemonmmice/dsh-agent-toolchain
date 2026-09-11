// dsh-ui-drive P2：MCP 面 snapshotId 透传 + W1 新鲜度门（离线）
//
// 背景（P2 复核发现的缺口）：MCP 的 ui_drive / ui_act schema 原先**没有 snapshotId 字段**，
// 于是 W1 的新鲜度门在 MCP 面根本传不进去 —— validateSnapshot 永远收到 no-snapshot、恒放行，
// 陈旧/失效快照在 MCP 面完全不设防。本测试证明修复后两件事：
//
//   A)【MCP 面，真 spawn server.mjs 走 stdio】ui_drive / ui_act 传入 snapshotId 会**真的到达**写侧门：
//      传一个无法解析的 snapshotId → 返回 unknownSnapshot 拒绝。字段被丢弃的老版本给不出这个码
//      （会放行并落到"找不到客户端"之类的别的错误），所以这条能干净区分"透传进门" vs "被丢弃"。
//
//   B)【驱动层，drv().drive —— 正是 MCP handler 调用的同一入口】用假脚本造出**真陈旧**：
//      read→read 抬升权威 seq，再拿**旧** snapshotId 点击 → staleSnapshot 拒绝 + 执行器 0 次；
//      并配一个 fresh 对照证明门不是无脑拒（fresh snapshotId 照常放行、执行器被调用）。
//
// A 证明"字段透传进门"，B 证明"门对真陈旧确实拦"；合起来 = "MCP 传 snapshotId 时陈旧会被拒"。
// 为什么 B 放在驱动层而不是 stdio：离线没有真客户端，真实 .ps1 的 read 起不来 → server.mjs 无法把
// snap.latest 抬起来，也就造不出"真陈旧"。用假脚本在驱动层抬 seq，走的是**同一个**
// checkSideEffectGate / validateSnapshot 代码路径（MCP handler 只是 drv().drive 的薄包装），等价且可离线复现。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'ui-drive-snap-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-snap-ev-'))
const sentinel = join(dir, 'executed.log')

/**
 * 假脚本：
 *  · ui-drive.ps1（一次性）：read → 回两行控件（驱动据此抬升权威 seq、签发 snapshotId）；
 *    click/setvalue/key → 追加一行到哨兵（证明"执行器被调用"）并回 CLICKED。
 *  · ui-drive-batch.ps1：仅为 scriptsDir 合法而存在（本测试 SERVE=0、无策略，不会真的用到它）。
 */
function installFakeScripts() {
  const oneShot = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='',[string]$Value='',[int]$WaitMs=250,[switch]$Ascii,[string]$Match='',[string]$Out='')
if ($Action -eq 'read') {
  Write-Output '[Button] name="A" enabled=True'
  Write-Output '[Edit] name="B" enabled=True'
  Write-Output 'SCANNED 2'
  Write-Output 'SKIPPED 0'
  exit 0
}
if ($Action -eq 'click' -or $Action -eq 'setvalue' -or $Action -eq 'key') {
  if ($env:FAKE_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_SENTINEL, 'oneshot-' + $Action + [Environment]::NewLine) }
  Write-Output 'CLICKED "x"'
  exit 0
}
Write-Output 'NOT_FOUND'
`
  const batch = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Status) { Write-Output 'RUNNING pid=4242 window=FakeWin'; Write-Output 'HANDLE 777'; exit 0 }
Write-Output 'RESULT_JSON={"ok":true,"steps":[]}'
`
  writeFileSync(join(dir, 'ui-drive.ps1'), oneShot, 'utf8')
  writeFileSync(join(dir, 'ui-drive-batch.ps1'), batch, 'utf8')
  writeFileSync(join(dir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_SENTINEL = sentinel
}

function resetSentinel() { if (existsSync(sentinel)) rmSync(sentinel) }
function execCount() {
  if (!existsSync(sentinel)) return 0
  return readFileSync(sentinel, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length
}

// ============================================================ Part B：驱动层真陈旧
{
  delete process.env.DSH_UI_APP_POLICY
  delete process.env.DSH_UI_ESTOP_FILE
  process.env.DSH_UI_SERVE = '0'
  installFakeScripts()
  resetSentinel()
  const d = makeDriver({ scriptsDir: dir, evidenceDir, procName: 'FakeProc' })

  const r1 = await d.drive({ action: 'read' })
  const r2 = await d.drive({ action: 'read' })
  check('read 签发 snapshotId（权威读）', typeof r1.snapshotId === 'string' && typeof r2.snapshotId === 'string', JSON.stringify({ s1: r1.snapshotId, s2: r2.snapshotId }))
  check('两次读的 snapshotId 单调递增（seq 抬升）', r1.snapshotId !== r2.snapshotId, r1.snapshotId + ' -> ' + r2.snapshotId)

  // 拿**旧** snapshotId（r1，seq 已被 r2 超过）做副作用动作 → 必须判陈旧、且执行器一次都不能被调用
  resetSentinel()
  const stale = await d.drive({ action: 'click', name: 'x', allowSideEffects: true, snapshotId: r1.snapshotId })
  check('陈旧 snapshotId → 拒绝', stale.ok === false, JSON.stringify(stale).slice(0, 160))
  check('陈旧 snapshotId → 带 staleSnapshot 标记', Boolean(stale.staleSnapshot), JSON.stringify(stale).slice(0, 160))
  check('陈旧 snapshotId → **执行器调用计数 = 0**', execCount() === 0, 'sentinel=' + execCount())

  // 对照：拿**最新** snapshotId（r2）→ 门必须放行、执行器被调用（证明门不是无脑拒）
  resetSentinel()
  const fresh = await d.drive({ action: 'click', name: 'x', allowSideEffects: true, snapshotId: r2.snapshotId })
  check('【对照】最新 snapshotId → 放行', fresh.ok === true, JSON.stringify(fresh).slice(0, 160))
  check('【对照】最新 snapshotId → 执行器被调用（哨兵>0）', execCount() > 0, 'sentinel=' + execCount())

  d.warmShutdown()
}

// ============================================================ Part A：MCP 面 stdio 透传
// 需要 mcp 的 SDK 依赖（cd mcp && npm install，CI 里 smoke 之前会装）。没装则跳过并说明，绝不假通过。
const serverPath = join(repoRoot, 'mcp', 'server.mjs')
const sdkPath = join(repoRoot, 'mcp', 'node_modules', '@modelcontextprotocol')

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
const note = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'

/** 起一个 server.mjs，走 stdio 调一个工具，返回 {payload, isError}，随后杀掉进程。 */
function callTool(name, args, id = 2) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        DSH_UI_SERVE: '0',
        DSH_UI_PROC_NAME: '', DSH_UI_WINDOW_NAME: '', DSH_UI_CLIENT_EXE: '',
        DSH_UI_APP_POLICY: '', DSH_UI_ESTOP_FILE: '', DSH_UI_LOCK: '',
      },
    })
    const chunks = []
    let done = false
    const finish = (fn, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* ignore */ }
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
      fn(val)
    }
    const timer = setTimeout(() => finish(reject, new Error('timeout waiting for ' + name + ' response')), 30000)
    child.stdout.on('data', (d) => {
      chunks.push(d)
      const buf = Buffer.concat(chunks).toString('utf8')
      for (const line of buf.split('\n')) {
        if (!line.includes('"id":' + id)) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== id || !msg.result) continue
        const rawText = (msg.result.content && msg.result.content[0] && msg.result.content[0].text) || ''
        let payload = null
        try { payload = JSON.parse(rawText) } catch { payload = null } // 非 JSON（如 pre-check 的 "Blocked:" 文本）→ payload=null
        finish(resolve, { payload, rawText, isError: msg.result.isError === true })
      }
    })
    child.stderr.on('data', () => { /* server 诊断输出，忽略 */ })
    child.on('error', (e) => finish(reject, e))
    child.stdin.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'snap-test', version: '0.0.1' } }))
    child.stdin.write(note('notifications/initialized'))
    child.stdin.write(rpc(id, 'tools/call', { name, arguments: args }))
  })
}

if (existsSync(sdkPath) && existsSync(serverPath)) {
  // 无法解析的 snapshotId：走到 validateSnapshot 一定判 unknownSnapshot；若字段被丢弃则会放行→别的错误。
  const bogus = 'not-a-real-token'
  try {
    const a = await callTool('ui_drive', { action: 'click', name: 'x', allowSideEffects: true, snapshotId: bogus })
    check('ui_drive：snapshotId 透传到写侧门（unknownSnapshot）', a.payload && a.payload.unknownSnapshot === true, JSON.stringify(a.payload).slice(0, 200))
    check('ui_drive：陈旧/未知快照结果带 isError', a.isError === true, 'isError=' + a.isError)

    const b = await callTool('ui_act', { action: 'click', name: 'x', allowSideEffects: true, snapshotId: bogus })
    check('ui_act：snapshotId 透传到写侧门（unknownSnapshot）', b.payload && b.payload.unknownSnapshot === true, JSON.stringify(b.payload).slice(0, 200))
    check('ui_act：陈旧/未知快照结果带 isError', b.isError === true, 'isError=' + b.isError)

    // Task 1a：ui_drive 的 pre-check 必须覆盖 type/drag（老版本只列 click/setvalue/key，漏了这两个）。
    // pre-check 命中会返回明文 "Blocked: action ..."（非 JSON）；老版本会放行到驱动层（返回 JSON payload），
    // 所以匹配这条明文能干净区分"pre-check 拦住了" vs "漏过 pre-check"。
    for (const act of ['type', 'drag']) {
      const p = await callTool('ui_drive', { action: act, name: 'x' }) // 不带 allowSideEffects
      check(`ui_drive pre-check 拦截 ${act}（无 allowSideEffects）`, /^Blocked: action/.test(p.rawText), (p.rawText || JSON.stringify(p.payload)).slice(0, 160))
    }
    // 对照：只读动作不得被 pre-check 拦（find 应放过 pre-check，落到驱动层）
    const f = await callTool('ui_drive', { action: 'find', name: 'x' })
    check('ui_drive pre-check 不拦只读 find（对照）', !/^Blocked: action/.test(f.rawText), (f.rawText || '').slice(0, 120))
  } catch (e) {
    check('MCP stdio 透传用例执行完成', false, String(e).slice(0, 200))
  }
} else {
  console.log('  skip Part A（MCP SDK 未安装：cd mcp && npm install 后可跑 stdio 透传证明）')
}

try { rmSync(dir, { recursive: true, force: true }); rmSync(evidenceDir, { recursive: true, force: true }) } catch { /* ignore */ }
delete process.env.FAKE_SENTINEL

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive MCP snapshotId 透传 + 新鲜度门')
