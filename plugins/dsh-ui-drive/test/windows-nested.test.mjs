// dsh-ui-drive 单测：`ui_windows` 必须报出**嵌套窗口元素**（2026-09-11 真机自查）。
//
// 真机事实：客户端停在「用户许可协议」对话框时，`ui_windows` 只报 1 个顶层窗口 ——
// 而那个对话框是**主窗口视觉树里的 Window 元素**（UIA 只把进程的顶层窗口报为桌面元素）。
// agent 据此以为"界面上只有一个窗口"，然后在被对话框遮住的主界面上找控件（找不到 / 点到错的东西）。
// 修法：windows 动作额外枚举嵌套 Window 元素（含"内含=第一个有名字的后代"，因为嵌套窗口自己常常没名字）。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-win-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-win-ev-'))

function installFakeBatch(stepExtra) {
  const payload = JSON.stringify({ ok: true, elapsedMs: 2, steps: [Object.assign({ step: 1, action: 'windows', ok: true }, stepExtra)] })
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_BATCH_PAYLOAD = payload
}

function newDriver() {
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

// ------------------------------------------------- 1. 有嵌套窗口 → 必须报出来（数量/明细/提示/完整性）
{
  installFakeBatch({
    count: 1,
    lines: ['[Window] "主窗口" handle=1 pid=99 @0,0 2560x1380 offscreen=False'],
    nestedWindows: [
      'Window "" aid="" offscreen=False @830,243 900x893 内含="用户许可协议"',
      'Window "登录" aid="LoginWin" offscreen=False @100,100 400x300',
    ],
    nestedWindowsTotal: 2,
    skipped: 0,
  })
  const d = newDriver()
  const r = await d.drive({ action: 'windows' })
  check('嵌套窗口：明细透传（数组）', Array.isArray(r.nestedWindows) && r.nestedWindows.length === 2, JSON.stringify(r.nestedWindows))
  check('嵌套窗口：总数透传（可与明细数不同=被截断）', r.nestedWindowsTotal === 2, JSON.stringify({ t: r.nestedWindowsTotal }))
  check('嵌套窗口：note 说清"会遮住下面的控件"并给出下一步', /遮住/.test(String(r.note)) && /ui_observe\(state\)/.test(String(r.note)), String(r.note).slice(0, 220))
  check('嵌套窗口：顶层窗口清单不受影响', r.count === 1 && /主窗口/.test(r.lines[0]), JSON.stringify(r.lines))
  check('嵌套窗口：skipped 一并回报（沿用同一套完整性）', r.skipped === 0, JSON.stringify({ s: r.skipped }))
  check('嵌套窗口：没截断时 truncated 不误报', r.truncated !== true, JSON.stringify({ t: r.truncated }))
  d.warmShutdown()
}

// ------------------------------------------------- 2. 嵌套窗口超过上限 → 截断必须自报
{
  installFakeBatch({
    count: 1,
    lines: ['[Window] "主窗口" handle=1 pid=99 @0,0 2560x1380 offscreen=False'],
    nestedWindows: ['Window "a" aid="" offscreen=False @1,1 10x10'],
    nestedWindowsTotal: 25,
    truncated: true,
    maxApplied: 20,
    skipped: 2,
  })
  const d = newDriver()
  const r = await d.drive({ action: 'windows' })
  check('嵌套窗口被截断 → truncated=true 且带 maxApplied', r.truncated === true && r.maxApplied === 20, JSON.stringify({ t: r.truncated, m: r.maxApplied }))
  check('嵌套窗口被截断 → 总数仍如实（25 而非 1）', r.nestedWindowsTotal === 25, JSON.stringify({ t: r.nestedWindowsTotal }))
  check('嵌套窗口：skipped=2 透传', r.skipped === 2, JSON.stringify({ s: r.skipped }))
  d.warmShutdown()
}

// ------------------------------------------------- 3. 没有嵌套窗口 → 不许凭空造出字段（不刷噪音）
{
  installFakeBatch({ count: 2, lines: ['[Window] "A" handle=1 pid=9 @0,0 100x100 offscreen=False', '[Window] "B" handle=2 pid=9 @0,0 50x50 offscreen=False'], skipped: 0 })
  const d = newDriver()
  const r = await d.drive({ action: 'windows' })
  check('无嵌套窗口：不下发 nestedWindows/note', r.nestedWindows === undefined && r.note === undefined, JSON.stringify({ n: r.nestedWindows, note: r.note }))
  check('无嵌套窗口：仍是正常结果', r.ok === true && r.count === 2, JSON.stringify({ ok: r.ok, c: r.count }))
  d.warmShutdown()
}

// ------------------------------------------------- 4. 源码守卫：PS 侧真的枚举嵌套窗口并按"内含"补名字
{
  const batch = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  check('PS：windows 分支枚举嵌套 Window 元素', /nestedWindowsTotal/.test(batch) && /ControlType\]::Window/.test(batch))
  check('PS：嵌套窗口无名时用"内含="补第一个有名字的后代', /内含="/.test(batch) && /if \(-not \$nm\)/.test(batch))
  check('PS：嵌套窗口枚举有上限且截断自报', /nested\.Count -lt 20/.test(batch) && /if \(\$nestedTotal -gt \$nested\.Count\)/.test(batch))
  // 渲染层（index.js 不可 import：它依赖宿主 API）→ 用源码守卫钉住它印出嵌套窗口
  // 注意匹配的是**实际写法**（渲染里把 v.nestedWindows 取成局部变量 nested 再 map），
  // 别写成 `nestedWindows.map` —— 那是"我以为是这么写的"，第一次就是这么误报的。
  const idx = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')
  check('外壳面渲染印出嵌套窗口与提示', /嵌套窗口元素/.test(idx) && /Array\.isArray\(v\.nestedWindows\)/.test(idx) && /nested\.map\(/.test(idx))
  check('外壳面渲染的截断/skipped 与其它读路径同一套说法', /嵌套窗口清单已截断/.test(idx) && /skipped=/.test(idx))
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD

console.log(failures === 0 ? '\nPASS: ui-drive ui_windows 嵌套窗口' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
