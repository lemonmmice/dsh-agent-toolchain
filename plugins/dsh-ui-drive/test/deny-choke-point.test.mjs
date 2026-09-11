// dsh-ui-drive W0 单测：致效汇聚点守卫（离线：不需要客户端）
//
// 背景（2026-09-11 三方联合评审 P0）：
//   坐标/具名致效动作曾绕过全部两道护栏 ——
//     · driver 侧：INPUT_ACTIONS 把 drag/clickat/doubleclick 整体豁免，不需要 allowSideEffects；
//     · PS1 侧：Test-DenyTarget 全脚本只有 click 分支调用过，而 type/key 会先**物理左键
//       点元素中心**、setvalue 能改值、doubleclick 能双击 —— 四条路径都能绕过硬拒。
// 本单测锁死修复后的两件事：
//   1. driver 门：clickat/doubleclick/drag 不带 allowSideEffects 时**必须**被拒，
//      且**执行器调用计数为 0**（用哨兵文件证明，而不是只看错误码）；move/wheel 仍放行。
//   2. PS1 汇聚点：五个低层致效函数入口**都必须**调用 Assert-NotDenied（结构不变量，
//      今后新增分支若忘了调用会被这条测试直接打红）。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-w0-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-w0-evidence-'))
const sentinel = join(scriptsDir, 'executed.log')

/** 假 batch：**每次被执行**就往哨兵文件追加一行 —— 用它证明"执行器调用计数"。 */
function installCountingBatch(payload) {
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($env:FAKE_SENTINEL) { [System.IO.File]::AppendAllText($env:FAKE_SENTINEL, ([string]$env:FAKE_BATCH_PAYLOAD + [Environment]::NewLine)) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_BATCH_PAYLOAD = JSON.stringify(payload)
  process.env.FAKE_SENTINEL = sentinel
  if (existsSync(sentinel)) rmSync(sentinel)
}

function invocations() {
  if (!existsSync(sentinel)) return 0
  return readFileSync(sentinel, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length
}

function newDriver() {
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

const OK_PAYLOAD = { ok: true, elapsedMs: 4, steps: [{ step: 1, action: 'clickat', ok: true, output: 'CLICKED@10,20' }] }

// ------------------------------------------------- 1. 致效动作：无 allowSideEffects → 拒 + 执行器 0 次
{
  installCountingBatch(OK_PAYLOAD)
  const d = newDriver()
  for (const act of ['clickat', 'doubleclick', 'drag']) {
    if (existsSync(sentinel)) rmSync(sentinel)
    const args = act === 'drag'
      ? { action: act, fromX: 1, fromY: 2, toX: 3, toY: 4 }
      : { action: act, name: '某按钮' }
    const r = await d.drive(args)
    check(`${act} 无 allowSideEffects 被拒`, r.ok === false, JSON.stringify(r).slice(0, 160))
    check(`${act} 拒绝信息可读`, /allowSideEffects/.test(String(r.error || '')), String(r.error).slice(0, 160))
    check(`${act} 执行器调用计数 = 0`, invocations() === 0, 'sentinel=' + invocations())
  }
  d.warmShutdown()
}

// ------------------------------------------------- 2. 反事实：显式 allowSideEffects → 真的执行（没被误杀）
{
  installCountingBatch(OK_PAYLOAD)
  const d = newDriver()
  const r = await d.drive({ action: 'clickat', name: '某按钮', allowSideEffects: true, x: 10, y: 20 })
  check('clickat + allowSideEffects 放行', r.ok === true, JSON.stringify(r).slice(0, 160))
  check('clickat + allowSideEffects 执行器被调用', invocations() >= 1, 'sentinel=' + invocations())
  d.warmShutdown()
}

// ------------------------------------------------- 3. 纯输入动作 move/wheel 仍豁免（不能一刀切）
{
  installCountingBatch({ ok: true, elapsedMs: 3, steps: [{ step: 1, action: 'move', ok: true, output: 'moved' }] })
  const d = newDriver()
  const r = await d.drive({ action: 'move', x: 5, y: 6 })
  check('move 仍不需要 allowSideEffects', r.ok === true, JSON.stringify(r).slice(0, 160))
  check('move 未被误拦（执行器被调用）', invocations() >= 1, 'sentinel=' + invocations())
  d.warmShutdown()
}

// ------------------------------------------------- 4. PS1 结构不变量：五个致效函数入口都要有守卫
{
  const ps1 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  // 逐个函数截取函数体（从 function NAME( 到下一个顶层 function / 文件末尾）
  function bodyOf(name) {
    const i = ps1.indexOf('function ' + name + '(')
    if (i < 0) return null
    const rest = ps1.slice(i)
    const next = rest.slice(1).search(/\nfunction /)
    return next < 0 ? rest : rest.slice(0, next + 1)
  }
  const mustGuard = ['Invoke-Click', 'Invoke-DoubleClickElement', 'Set-ElementValue', 'Send-TypeTo', 'Send-KeyTo']
  for (const fn of mustGuard) {
    const body = bodyOf(fn)
    check(`${fn} 定义了`, body !== null)
    check(`${fn} 入口调用 Assert-NotDenied`, body !== null && /Assert-NotDenied/.test(body), '缺守卫 = 该路径可绕过硬拒')
  }
  check('Assert-NotDenied 会抛（不是静默 return）', /function Assert-NotDenied[\s\S]{0,200}?throw/.test(ps1))
  // 「按名硬拒」是**通用机制**（目标客户端没有交易模块），默认名单只是保守默认值，可由环境变量覆盖
  check('「按名硬拒」名单可由 DSH_UI_DENY_RE 覆盖', /\$DENY_RE = if \(\$env:DSH_UI_DENY_RE\)/.test(ps1))
  check('未设置环境变量时回落到默认名单', /else \{ '[^']*买入[^']*' \}/.test(ps1))
  check('拒绝信息如实说明机制与可覆盖性（不再是"交易类"措辞）', /按名硬拒绝（不可解锁）/.test(ps1) && /DSH_UI_DENY_RE 覆盖/.test(ps1))
  check('源码中不再用"误点会真下单"这类不实论证', !/误点会真下单/.test(ps1))
}

// ------------------------------------------------- 4b. 「按名硬拒」真机验证：默认名单 + 环境变量覆盖
{
  const { execFileSync } = await import('node:child_process')
  const ps1 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // 从源码原文抽出 $DENY_RE 赋值与 Test-DenyTarget 函数体（不是重写一份，源码改了这里就跟着变）
  const denyLine = (/^\$DENY_RE = .*$/m.exec(ps1) || [''])[0]
  const fnIdx = ps1.indexOf('function Test-DenyTarget')
  let depth = 0, started = false, fn = ''
  for (let j = fnIdx; j < ps1.length; j++) {
    const ch = ps1[j]
    if (ch === '{') { depth++; started = true } else if (ch === '}') { depth--; if (started && depth === 0) { fn = ps1.slice(fnIdx, j + 1); break } }
  }
  const probe = `$DENY_ENV_SEEN = [string]$env:DSH_UI_DENY_RE
${denyLine}
${fn}
function T([string]$n) { $el = New-Object PSObject -Property @{ Current = (New-Object PSObject -Property @{ Name = $n; AutomationId = '' }) }; if (Test-DenyTarget $el) { 'DENY' } else { 'ALLOW' } }
'a=' + (T '买入按钮')
'b=' + (T '普通按钮')
'c=' + (T '危险操作')
`
  const run = (denyEnv) => {
    const env = Object.assign({}, process.env)
    if (denyEnv) env.DSH_UI_DENY_RE = denyEnv
    else delete env.DSH_UI_DENY_RE
    const out = execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', probe], { encoding: 'utf8', timeout: 60000, env })
    const kv = {}
    for (const line of out.split(/\r?\n/)) { const m = /^([abc])=(.*)$/.exec(line.trim()); if (m) kv[m[1]] = m[2] }
    return kv
  }
  const d1 = run('')
  check('默认名单：命中"买入"的控件被拒', d1.a === 'DENY', JSON.stringify(d1))
  check('默认名单：普通控件放行', d1.b === 'ALLOW', JSON.stringify(d1))
  const d2 = run('危险')
  check('覆盖生效：自定义名单命中即拒', d2.c === 'DENY', JSON.stringify(d2))
  check('覆盖生效：默认名单被替换（"买入"不再被拒）', d2.a === 'ALLOW', JSON.stringify(d2))
}

// ------------------------------------------------- 5. 文档与代码一致（原先 drag 的承诺没兑现）
{
  const idx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js'), 'utf8')
  check('工具说明把 drag 列入必须授权的动作', /click\/setvalue\/key\/type\/drag\/clickat\/doubleclick 必须传 allowSideEffects/.test(idx))
  check('工具说明不再声称 doubleclick 是"坐标双击"', !/doubleclick=坐标双击/.test(idx))
}

try { rmSync(scriptsDir, { recursive: true, force: true }); rmSync(evidenceDir, { recursive: true, force: true }) } catch { }

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive W0 actuation choke-point test')
