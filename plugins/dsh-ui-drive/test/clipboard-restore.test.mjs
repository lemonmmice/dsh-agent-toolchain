// dsh-ui-drive W5b 单测：中文输入不再破坏用户剪贴板（真机验证，非字符串比对）
//
// 背景：Send-KeyTo 的中文路径走 `Set-Clipboard` 后粘贴，**用完不还原** ——
// 驱动交易客户端时，用户刚复制的账号/金额会被静默清掉（对标 Codex 原生 paste
// 的"用完还原用户原剪贴板"行为）。
// 本测试从 ui-drive-batch.ps1 **原文抽取**这两个函数来跑（不是重写一份），
// 因此函数被改动/绕过都会直接反映在测试结果里。
//
// 安全（重要）：会临时改动剪贴板。
//   · 只在当前剪贴板是「文本或空」时才跑改动用例（这两种我们能原样还原）；
//     若是图片/文件等非文本内容 → 跳过改动用例，只跑结构断言。
//   · 用户原内容由 PowerShell 自己在**同一个进程内**保存并在 finally 里还原，
//     不经过 Node 转义（否则换行/引号会把内容搞坏）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let skipped = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function skip(name, why) { skipped++; console.log('  skip ' + name + ' — ' + why) }

const ps1Path = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ui-drive-batch.ps1')
const ps1 = readFileSync(ps1Path, 'utf8')

/** 从脚本原文里抽出函数定义体。兼容 `function F(` 与 `function F {` 两种签名形式。 */
function extractFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*[({]')
  const m = re.exec(ps1)
  if (!m) return null
  const i = m.index
  let depth = 0
  let started = false
  for (let j = i; j < ps1.length; j++) {
    const ch = ps1[j]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) return ps1.slice(i, j + 1) }
  }
  return null
}

const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function runPs(code) {
  return execFileSync(PS, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', code], {
    encoding: 'utf8', timeout: 60000,
  }).trim()
}

// ------------------------------------------------- 1. 结构断言（不动剪贴板）
{
  const f1 = extractFunction('Get-ClipboardSnapshot')
  const f2 = extractFunction('Restore-ClipboardSnapshot')
  check('Get-ClipboardSnapshot 可抽取', f1 !== null)
  check('Restore-ClipboardSnapshot 可抽取', f2 !== null)
  check('unknown 状态不碰剪贴板（宁可保留我们的内容，也不误清非文本数据）',
    /\$snap\.kind -eq 'unknown'\)\s*\{\s*return/.test(f2 || ''), '缺 unknown 分支 = 可能清掉用户的图片/文件剪贴板')

  const keyTo = extractFunction('Send-KeyTo') || ''
  check('Send-KeyTo 中文路径先快照', /Get-ClipboardSnapshot/.test(keyTo))
  check('Send-KeyTo 在 finally 里还原（异常也不破坏用户剪贴板）',
    /finally\s*\{[\s\S]*Restore-ClipboardSnapshot/.test(keyTo))
}

// ------------------------------------------------- 2. 真机剪贴板往返
const probe = runPs(`
Add-Type -AssemblyName System.Windows.Forms
try {
  if ([System.Windows.Forms.Clipboard]::ContainsText()) { 'TEXT' }
  elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList() -or [System.Windows.Forms.Clipboard]::ContainsImage()) { 'NONTEXT' }
  else { 'EMPTY' }
} catch { 'PROBE_FAIL' }
`)

if (probe === 'PROBE_FAIL') {
  skip('真机剪贴板用例', '当前会话读不到剪贴板（非交互/无桌面会话）')
} else if (probe === 'NONTEXT') {
  skip('真机剪贴板用例', '当前剪贴板是图片/文件等非文本内容，无法保证原样还原 —— 不冒险覆盖')
} else {
  const f1 = extractFunction('Get-ClipboardSnapshot')
  const f2 = extractFunction('Restore-ClipboardSnapshot')

  const script = `
Add-Type -AssemblyName System.Windows.Forms
${f1}
${f2}
$hadText = $false
$saved = ''
try {
  $hadText = [System.Windows.Forms.Clipboard]::ContainsText()
  if ($hadText) { $saved = [System.Windows.Forms.Clipboard]::GetText() }
} catch { }

$out = @()
try {
  # --- 用例 A：快照能读到文本，且值正确
  Set-Clipboard -Value 'USER-DATA-12345'
  $snap = Get-ClipboardSnapshot
  $out += ('A.kind=' + $snap.kind)
  $out += ('A.value=' + $snap.value)

  # --- 用例 B：模拟中文输入（覆盖剪贴板）后还原
  Set-Clipboard -Value '\\u6211\\u4eec\\u8f93\\u5165\\u7684\\u4e2d\\u6587' -ErrorAction SilentlyContinue
  if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { Set-Clipboard -Value 'zhongwen-payload' }
  Restore-ClipboardSnapshot $snap
  $out += ('B.after=' + [System.Windows.Forms.Clipboard]::GetText())

  # --- 用例 C：unknown 状态绝不改动剪贴板
  Set-Clipboard -Value 'KEEP-ME'
  Restore-ClipboardSnapshot @{ kind = 'unknown'; value = '' }
  $out += ('C.after=' + [System.Windows.Forms.Clipboard]::GetText())

  # --- 用例 D：空快照 → 还原为空
  [System.Windows.Forms.Clipboard]::SetText('X')
  Restore-ClipboardSnapshot @{ kind = 'none'; value = '' }
  $out += ('D.empty=' + [System.Windows.Forms.Clipboard]::ContainsText())
} finally {
  # 无条件还原用户原本的剪贴板（内容不出这个进程）
  try {
    if ($hadText) { Set-Clipboard -Value $saved } else { [System.Windows.Forms.Clipboard]::Clear() }
  } catch { }
}
$out | ForEach-Object { $_ }
`
  let out = ''
  let err = ''
  try { out = runPs(script) } catch (e) { err = String(e.stderr || e.message).slice(0, 400); out = '' }
  const kv = {}
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-D]\.\w+)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]] = m[2]
  }
  check('A 快照读到文本内容', kv['A.kind'] === 'text' && kv['A.value'] === 'USER-DATA-12345', JSON.stringify(kv) + ' ' + err)
  check('B 覆盖剪贴板后能还原用户原内容', kv['B.after'] === 'USER-DATA-12345', JSON.stringify(kv['B.after']) + ' ' + err)
  check('C unknown 状态不碰剪贴板', kv['C.after'] === 'KEEP-ME', JSON.stringify(kv['C.after']) + ' ' + err)
  check('D 空快照还原为空', kv['D.empty'] === 'False', JSON.stringify(kv['D.empty']) + ' ' + err)
}

if (failures) { console.log(`\nFAILED: ${failures} 项（跳过 ${skipped}）`); process.exit(1) }
console.log(`\nPASS: dsh-ui-drive clipboard restore test（跳过 ${skipped}）`)
