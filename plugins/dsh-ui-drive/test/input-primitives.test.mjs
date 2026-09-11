// dsh-ui-drive W5b 单测：输入原语补齐（pattern / 语义滚动 / 精确选区）
//
// 背景（工具面对照发现）：我们原先只用 6 个 UIA pattern，于是"展开一行 / 自增一次 /
// 选中范围 / 最大化窗口"只能靠盲点击；滚动靠裸 mouse_event 滚轮（坐标脆弱）。
// 对标 Codex CUA 的 performSecondaryAction / scroll(index,…) / selectText。
//
// 本测试为**结构契约测试**（这些动词需要真实客户端才能功能验证，见 live harness）：
// 它锁死的是"能力存在性"与"安全默认"，防止后续被改回盲点击或绕过守卫。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ps1 = readFileSync(join(root, 'scripts', 'ui-drive-batch.ps1'), 'utf8')
const driver = readFileSync(join(root, 'lib', 'driver.mjs'), 'utf8')

function extractFunction(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*[({]')
  const m = re.exec(src)
  if (!m) return null
  let depth = 0
  let started = false
  for (let j = m.index; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) return src.slice(m.index, j + 1) }
  }
  return null
}

// ------------------------------------------------- 1. pattern 原语（performSecondaryAction 等价物）
{
  const fn = extractFunction(ps1, 'Invoke-ElementPattern')
  check('Invoke-ElementPattern 存在', fn !== null)
  check('按元素暴露的 pattern 分派（不是盲点击）',
    /GetCurrentPattern/.test(fn || '') && /ExpandCollapsePattern/.test(fn || '') && !/mouse_event/.test(fn || ''))
  // 必须覆盖对照表里点名的高价值 pattern
  for (const p of ['ExpandCollapsePattern', 'RangeValuePattern', 'SelectionItemPattern', 'WindowPattern', 'TogglePattern']) {
    check('支持 ' + p.replace('Pattern', ''), (fn || '').includes(p))
  }
  check('未知动作名会 throw（绝不静默回退）',
    /不支持的 pattern 动作[\s\S]{0,80}throw/.test(ps1) || /throw \('不支持的 pattern 动作/.test(ps1))
  check('有 allowlist 白名单（不接受的动词名进不来）', /\$PATTERN_ACTIONS\s*=\s*@\(/.test(ps1))
  check('入口过致效汇聚点守卫（W0）', /function Invoke-ElementPattern[\s\S]{0,120}Assert-NotDenied/.test(ps1))
}

// ------------------------------------------------- 2. 语义滚动
{
  const fn = extractFunction(ps1, 'Invoke-ElementScroll')
  check('Invoke-ElementScroll 存在', fn !== null)
  check('用 ScrollPattern（语义滚动，非坐标滚轮）',
    /ScrollPattern/.test(fn || '') && !/mouse_event/.test(fn || ''))
  check('会往上找可滚动祖先（元素本身不可滚时）',
    /ControlViewWalker|GetParent/.test(fn || ''))
  check('方向非法时报错（不猜方向）', /不支持的滚动方向/.test(fn || ''))
  check('入口过致效汇聚点守卫', /function Invoke-ElementScroll[\s\S]{0,120}Assert-NotDenied/.test(ps1))
}

// ------------------------------------------------- 3. 精确选区
{
  const fn = extractFunction(ps1, 'Invoke-SelectText')
  check('Invoke-SelectText 存在', fn !== null)
  check('基于 TextPattern 查找并 Select',
    /TextPattern/.test(fn || '') && /FindText/.test(fn || '') && /\.Select\(\)/.test(fn || ''))
  check('支持 prefix 消歧', /prefix/.test(fn || '') && /MoveEndpointByUnit/.test(fn || ''))
  check('支持 suffix 消歧', /suffix/.test(fn || ''))
  check('支持 selectionType（cursor_before/cursor_after）',
    /cursor_before/.test(fn || '') && /cursor_after/.test(fn || ''))
  check('找不到文本时报错（不静默成功）', /找不到文本/.test(fn || ''))
  check('入口过致效汇聚点守卫', /function Invoke-SelectText[\s\S]{0,120}Assert-NotDenied/.test(ps1))
}

// ------------------------------------------------- 4. switch 分支已接线
{
  for (const act of ['pattern', 'scroll', 'selecttext']) {
    check(`主 switch 有 '${act}' 分支`, new RegExp("^\\s+'" + act + "'\\s*\\{", 'm').test(ps1))
  }
}

// ------------------------------------------------- 5. 安全默认：未知动作仍按副作用处理（deny-first）
{
  check('driver 的只读集合不含新动词（避免被当成只读放行）',
    !/READ_ONLY_ACTIONS\s*=\s*new Set\(\[[^\]]*'pattern'/.test(driver) &&
    !/READ_ONLY_ACTIONS\s*=\s*new Set\(\[[^\]]*'selecttext'/.test(driver))
  check('driver 的输入豁免集合不含新动词',
    !/INPUT_ACTIONS\s*=\s*new Set\(\[[^\]]*'pattern'/.test(driver) &&
    !/INPUT_ACTIONS\s*=\s*new Set\(\[[^\]]*'scroll'/.test(driver))
  check('未知动作默认需要 allowSideEffects（候选集合判定）',
    /!READ_ONLY_ACTIONS\.has\(action\) && !INPUT_ACTIONS\.has\(action\)/.test(driver))
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-ui-drive W5b input-primitives contract test')
