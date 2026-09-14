// dsh-ui-drive ui_tree 完整性测试（2026-09-11 自查，与 UD-01/Q1 同一类）。
//
// 自查发现的三处「看起来完整」：
//   1. 探针侧两个**隐性上限**（depth > maxDepth 静默返回 / count >= 4000 静默停），
//      而 driver 的 `truncated` 只反映"正文超过 14000 字符" → 一份被 maxDepth 剪过的树被标成"完整"；
//   2. `NO_APPLICATION`（注入成功但目标进程没有 WPF Application）与 `DUMP_ERR …`（遍历抛异常）
//      被当成正常正文 → 返回 `ok:true, text:'NO_APPLICATION'`，失败伪装成成功的树；
//   3. 探针无 META（旧版）时既不报深度也不报节点上限，调用方无从判断完整性 → 必须标"完整性未知"。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-tree-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-tree-evidence-'))

const TREE_LINES = ['Window|name=W|aid=|enabled=True|offscreen=False|@0,0 100x50',
  '  Button|name=ok|aid=btnOk|enabled=True|offscreen=False|@1,1 10x10']

/** 假探针：把给定正文当成 dump-tree 的结果吐出来（含 CSC_EXIT=0 与 --- RESULT --- 分隔线） */
function installFakeProbe(body) {
  const payload = 'CSC_EXIT=0\nINJECT_EXIT=0\n--- RESULT ---\n' + body
  const ps = 'param([string]$Action,[int]$MaxDepth=8,[int]$ProcId=0)\n' +
    '[System.IO.File]::WriteAllText($env:FAKE_TREE_OUT, [string]$env:FAKE_TREE_PAYLOAD, (New-Object System.Text.UTF8Encoding($false)))\n' +
    'Write-Output ([System.IO.File]::ReadAllText($env:FAKE_TREE_OUT))\n'
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), ps, 'utf8')
  const out = join(scriptsDir, 'fake-tree.txt')
  writeFileSync(out, payload, 'utf8')
  process.env.FAKE_TREE_OUT = out
  process.env.FAKE_TREE_PAYLOAD = payload
}

/** 假探针（注入器缺失的形态）：只往 stderr 报错、stdout 里连结果区都没有 */
function installFailingProbe(stderrText) {
  const ps = 'param([string]$Action,[int]$MaxDepth=8,[int]$ProcId=0)\n' +
    '[Console]::Error.WriteLine([string]$env:FAKE_PROBE_STDERR)\n'
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), ps, 'utf8')
  process.env.FAKE_PROBE_STDERR = stderrText
}

/** 假批量脚本：让 tree 动作（UIA 降级路径）返回给定结果 */
function installFakeBatch(treeStep) {
  const payload = JSON.stringify({ ok: true, elapsedMs: 3, steps: [Object.assign({ step: 1, action: 'tree', ok: true }, treeStep)] })
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), '# stub\n', 'utf8')
  process.env.FAKE_BATCH_PAYLOAD = payload
}

function newDriver() {
  process.env.DSH_UI_SERVE = '0'
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc' })
}

const LINES = ['System.Windows.Controls.Button|name=ok|aid=btnOk|dc=System.Object', '  TextBlock|name=x|aid=|dc=']

// ------------------------------------------------- 1. 深度被切断 → 必须报出来（旧实现报 truncated:false）
{
  installFakeProbe('TREE_META nodes=120 cap=4000 capHit=false depthHit=true maxDepth=4 windows=1\n' + LINES.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 4 })
  check('深度截断：ok=true 且 text 不含 META 行', r.ok === true && !/TREE_META/.test(r.text), String(r.text).slice(0, 120))
  check('深度截断：truncated=true（旧实现这里是 false）', r.truncated === true, JSON.stringify({ t: r.truncated }))
  check('深度截断：显式 depthLimited + maxDepthApplied', r.depthLimited === true && r.maxDepthApplied === 4, JSON.stringify({ d: r.depthLimited, m: r.maxDepthApplied }))
  check('深度截断：nodes/windows 如实回报', r.nodes === 120 && r.windows === 1, JSON.stringify({ n: r.nodes, w: r.windows }))
  check('深度截断：note 说明怎么拿到更多', /maxDepth/.test(String(r.note)) && /调大/.test(String(r.note)), String(r.note).slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 2. 节点数上限命中 → 也要报
{
  installFakeProbe('TREE_META nodes=4000 cap=4000 capHit=true depthHit=false maxDepth=20 windows=3\n' + LINES.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 20 })
  check('节点上限：truncated=true + nodeCapHit', r.truncated === true && r.nodeCapHit === true, JSON.stringify({ t: r.truncated, c: r.nodeCapHit }))
  check('节点上限：note 建议缩小范围/逐层下钻', /范围|下钻/.test(String(r.note)), String(r.note).slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 3. 两个上限都没命中 → 不许误报（这才是"完整"）
{
  installFakeProbe('TREE_META nodes=88 cap=4000 capHit=false depthHit=false maxDepth=12 windows=1\n' + LINES.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 12 })
  check('完整树：truncated=false 且不带 depthLimited/nodeCapHit', r.truncated === false && r.depthLimited === undefined && r.nodeCapHit === undefined, JSON.stringify(r).slice(0, 200))
  check('完整树：仍回报 nodes/maxDepthApplied', r.nodes === 88 && r.maxDepthApplied === 12, JSON.stringify({ n: r.nodes, m: r.maxDepthApplied }))
  check('完整树：不刷 note', r.note === undefined, String(r.note))
  d.warmShutdown()
}

// ------------------------------------------------- 4. 探针失败标记 → 绝不伪装成成功的树
{
  installFakeProbe('NO_APPLICATION')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 8 })
  check('NO_APPLICATION → ok:false（旧实现是 ok:true + text=NO_APPLICATION）', r.ok === false, JSON.stringify(r).slice(0, 200))
  check('NO_APPLICATION → 错误说清是什么 + 给下一步', /WPF Application/.test(String(r.error)) && /ui_status|ui_observe/.test(String(r.hint)), String(r.error).slice(0, 160))
  d.warmShutdown()

  installFakeProbe('TREE_META nodes=3 cap=4000 capHit=false depthHit=false maxDepth=8 windows=1\nButton|name=a|aid=|dc=\nDUMP_ERR InvalidOperationException: 集合已修改\n')
  const d2 = newDriver()
  const r2 = await d2.tree({ maxDepth: 8 })
  check('DUMP_ERR → 失败原因（异常原文）出现在返回里', r2.ok === false ? /InvalidOperationException/.test(String(r2.error)) : /InvalidOperationException/.test(String(r2.injectorUnavailable && r2.injectorUnavailable.error)),
    JSON.stringify({ ok: r2.ok, e: String(r2.error).slice(0, 120), i: String(r2.injectorUnavailable && r2.injectorUnavailable.error).slice(0, 120) }))
  check('DUMP_ERR → 给可执行下一步（小 maxDepth 重试 / 换 ui_observe）',
    /maxDepth/i.test(String(r2.hint) + String(r2.error)) || /maxDepth/i.test(String(r2.injectorUnavailable && r2.injectorUnavailable.hint)),
    String(r2.hint || (r2.injectorUnavailable && r2.injectorUnavailable.hint)).slice(0, 200))
  d2.warmShutdown()
}

// ------------------------------------------------- 5. 旧探针（无 META）→ 完整性未知，不许冒充完整
{
  installFakeProbe(LINES.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 8 })
  check('无 META：ok=true 但带 observationWarning', r.ok === true && /TREE_META/.test(String(r.observationWarning)), String(r.observationWarning).slice(0, 180))
  check('无 META：warning 明说"不等于完整视觉树"', /不等于/.test(String(r.observationWarning)), String(r.observationWarning).slice(0, 200))
  d.warmShutdown()
}

// ------------------------------------------------- 5b. 范围限定（inAid/inName）必须真的转发给执行器
// 起因：我在严格比对脚本里写了 d.tree({ maxDepth: 20, inAid: 'webView' }) —— **它静默忽略了 inAid**
// （tree() 的签名里根本没有这个参数，JS 不会报错），于是"限定后的树"其实还是整窗，比对结论也就没意义。
// 修完后这里钉死：范围必须出现在**发给执行器的步骤文件**里。
{
  const captured = join(scriptsDir, 'captured-tree-steps.json')
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($StepsFile -and (Test-Path $StepsFile)) { Copy-Item $StepsFile $env:FAKE_CAPTURE_STEPS -Force }
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  process.env.FAKE_CAPTURE_STEPS = captured
  process.env.FAKE_BATCH_PAYLOAD = JSON.stringify({ ok: true, elapsedMs: 2, steps: [{ step: 1, action: 'tree', ok: true, count: 2, lines: TREE_LINES, maxDepthApplied: 20, nodeCap: 4000, nodeCapHit: false, depthLimited: false, narrowed: true, scope: 'inAid=webView inName=', skipped: 0 }] })
  installFakeProbe('') // 注入侧给空树 → 保证走 UIA 降级路径（那条才支持范围）
  // ⚠ 顺序要紧：installFakeBatch/installFakeProbe 会**覆盖**脚本文件，所以"抓步骤文件"的那份必须最后写。
  //   第一版顺序反了 → 抓到的永远是空 → 断言假红（不是产品问题）。
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 20, inAid: 'webView', inName: 'X', max: 500 })
  const steps = existsSync(captured) ? JSON.parse(readFileSync(captured, 'utf8')) : []
  check('范围参数：步骤文件里带 inAid/inName', steps[0] && steps[0].inAid === 'webView' && steps[0].inName === 'X', JSON.stringify(steps[0]))
  check('范围参数：节点上限 max 也转发', steps[0] && steps[0].max === 500, JSON.stringify(steps[0] && steps[0].max))
  check('范围参数：结果回报 narrowed/scope（调用方看得见自己被限定了）', r.narrowed === true && /inAid=webView/.test(String(r.scope)), JSON.stringify({ n: r.narrowed, s: r.scope }))
  d.warmShutdown()
}

// ------------------------------------------------- 6. 正文超 14000 字符 → textCapped 与 depthLimited 分开
{
  const many = Array.from({ length: 900 }, (_, i) => 'System.Windows.Controls.TextBlock|name=t' + i + '|aid=|dc=System.Object')
  installFakeProbe('TREE_META nodes=900 cap=4000 capHit=false depthHit=false maxDepth=20 windows=1\n' + many.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 20 })
  check('超长正文：textCapped=true 且 truncated=true', r.textCapped === true && r.truncated === true, JSON.stringify({ c: r.textCapped, t: r.truncated }))
  check('超长正文：不误报 depthLimited/nodeCapHit', r.depthLimited === undefined && r.nodeCapHit === undefined, JSON.stringify({ d: r.depthLimited, c: r.nodeCapHit }))
  check('超长正文：text 被截到上限内（不整段塞回）', String(r.text).length <= 14000, String(String(r.text).length))
  d.warmShutdown()

  // 未限定范围 + 被截断 → 必须给出"先缩范围再深挖"的可执行下一步
  installFakeProbe('TREE_META nodes=900 cap=4000 capHit=false depthHit=false maxDepth=20 windows=1\n' + many.join('\n') + '\n')
  const d2b = newDriver()
  const r2b = await d2b.tree({ maxDepth: 20 })
  check('超长正文且未限定范围 → hint 教用 inAid 缩范围', /inAid/.test(String(r2b.hint)) && /完整/.test(String(r2b.hint)), String(r2b.hint).slice(0, 200))
  d2b.warmShutdown()
}

// ------------------------------------------------- 7. 降级路径：注入器不可用时用 UIA 层级树（并如实标注来源）
// 真机事实（2026-09-11）：本机 DSH_SNOOP_DIR 未配置、Snoop 注入器不存在 → ui_tree 原本**完全不可用**，
// 而且报的是"探针执行成功但一个节点都没拿到"（把配置缺失怪到客户端）。降级后至少还有层级+类型。
{
  installFailingProbe("Test-Path : Cannot bind argument to parameter 'Path' because it is null.\r\nAt C:\\x\\ui-probe.ps1:28 char:21\r\n+ if (-not (Test-Path $snoop)) { throw '未找到 Snoop 目录: ' + $snoop }")
  installFakeBatch({ count: 2, lines: TREE_LINES, maxDepthApplied: 4, nodeCap: 4000, nodeCapHit: false, depthLimited: true, skipped: 0 })
  const d = newDriver()
  const r = await d.tree({ maxDepth: 4 })
  check('降级：ok=true 且 source=uia', r.ok === true && r.source === 'uia', JSON.stringify({ ok: r.ok, s: r.source }))
  check('降级：标注了"注入探针不可用"（probeNotRun）', !!(r.injectorUnavailable && r.injectorUnavailable.probeNotRun === true), JSON.stringify(r.injectorUnavailable))
  check('降级：sourceNote 说清 UIA 拿不到 DataContext', /DataContext/.test(String(r.sourceNote)) && /不可用/.test(String(r.sourceNote)), String(r.sourceNote).slice(0, 240))
  check('降级：nodes/文本都带回来（不是空手）', r.nodes === 2 && /Button\|name=ok/.test(String(r.text)), JSON.stringify({ n: r.nodes }).slice(0, 120))
  check('降级：深度切断照样报（truncated + depthLimited + note）', r.truncated === true && r.depthLimited === true && /maxDepth=4/.test(String(r.note)), JSON.stringify({ t: r.truncated, d: r.depthLimited, n: String(r.note).slice(0, 120) }))
  check('降级：skipped 一并回报（清单完整性沿用同一套）', r.skipped === 0, JSON.stringify({ s: r.skipped }))
  d.warmShutdown()

  // 注入探针脚本本身不存在（未部署）→ 同样降级
  rmSync(join(scriptsDir, 'ui-probe.ps1'), { force: true })
  installFakeBatch({ count: 1, lines: [TREE_LINES[0]], maxDepthApplied: 8, nodeCap: 4000, nodeCapHit: false, depthLimited: false })
  const d2 = newDriver()
  const r2 = await d2.tree({ maxDepth: 8 })
  check('探针脚本不存在 → 也降级（不再直接失败）', r2.ok === true && r2.source === 'uia' && r2.injectorUnavailable.probeUnavailable === true, JSON.stringify({ ok: r2.ok, s: r2.source, u: r2.injectorUnavailable }))
  check('探针脚本不存在 → 完整时不误报截断', r2.truncated === false && r2.depthLimited === undefined, JSON.stringify({ t: r2.truncated, d: r2.depthLimited }))
  d2.warmShutdown()

  // 注入侧"成功但空树"也降级（UIA 至少能给层级）
  installFakeProbe('')
  installFakeBatch({ count: 1, lines: [TREE_LINES[0]], maxDepthApplied: 8, nodeCap: 4000, nodeCapHit: false, depthLimited: false })
  const d3 = newDriver()
  const r3 = await d3.tree({ maxDepth: 8 })
  check('注入空树 → 降级到 UIA（不再是死路）', r3.ok === true && r3.source === 'uia', JSON.stringify({ ok: r3.ok, s: r3.source }))
  d3.warmShutdown()

  // 两条路都不行 → 明确失败，且把两边的原因都写出来
  // 这一段还顺手锁死一个**被它抓出来的真缺陷**：批量结果文件按秒级目录存放，
  // 若"文件存在就解析"，同一秒内上一轮的结果会被当成这一轮的结果 —— 失败伪装成成功。
  installFakeProbe('')
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), '# 坏掉的批量脚本（无输出）\n', 'utf8')
  const d4 = newDriver()
  const r4 = await d4.tree({ maxDepth: 8 })
  check('两条路都失败 → ok:false 且两边的失败原因都在错误里', r4.ok === false && /注入探针不可行/.test(String(r4.error)) && /UIA 降级也失败/.test(String(r4.error)), String(r4.error).slice(0, 240))
  check('上一轮的结果文件不得被当成这一轮的结果（失败不得伪装成成功）', r4.ok === false, JSON.stringify({ ok: r4.ok, source: r4.source }))
  check('两条路都失败 → hint 给出下一步与配置方法', /ui_status/.test(String(r4.hint)) && /DSH_SNOOP_DIR/.test(String(r4.hint)), String(r4.hint).slice(0, 240))
  d4.warmShutdown()
}

// ------------------------------------------------- 7b. UIA 看不见内容的区域 + 被跳过的子树（Claude 第十轮真机反例）
// 真机事实：许可协议/广告页是 CEF 渲染的，在 UIA 树里表现为 **一个大矩形 + 零子节点**（`Chrome Legacy Window`），
// 而截图里是满屏内容。旧输出只有 ok:true 的空叶子 —— 调用方会得出"这里什么都没有"。
// 另一半：整棵子树因异常被跳过时，count 与 truncated **都不会变**，所以 skipped 必须单独说出来。
{
  installFakeProbe('TREE_META nodes=3 cap=4000 capHit=false depthHit=false maxDepth=20 windows=1 opaque=1\n' +
    'TREE_OPAQUE System.Windows.Controls.WebBrowser|name=webView|aid=webView|801x609\n' +
    'Pane|name=Chrome Legacy Window|aid=285581312|dc=\n' + LINES.join('\n') + '\n')
  const d = newDriver()
  const r = await d.tree({ maxDepth: 20 })
  check('盲区（注入路径）：opaqueRegions 透传 + 总数', Array.isArray(r.opaqueRegions) && r.opaqueRegions.length === 1 && r.opaqueRegionsTotal === 1, JSON.stringify(r.opaqueRegions))
  check('盲区（注入路径）：TREE_OPAQUE 行已从正文剥掉', !/TREE_OPAQUE/.test(String(r.text)), String(r.text).slice(0, 80))
  check('盲区：opaqueNote 明说"要看内容必须用 shot，别据此判定没有控件"', /shot/.test(String(r.opaqueNote)) && /不要据此判定/.test(String(r.opaqueNote)), String(r.opaqueNote).slice(0, 240))
  check('盲区：note 不把这类盲区混进"截断"（truncated 不因此变真）', r.truncated === false, JSON.stringify({ t: r.truncated }))
  d.warmShutdown()

  installFakeBatch({
    count: 3, lines: TREE_LINES, maxDepthApplied: 20, nodeCap: 4000, nodeCapHit: false, depthLimited: false,
    skipped: 4, skippedReasons: ['tree: 子节点枚举失败: 元素已失效'],
  })
  installFakeProbe('') // 空树 → 走 UIA 降级路径（skipped/opaque 由 PS 侧统计）
  const d2 = newDriver()
  const r2 = await d2.tree({ maxDepth: 20 })
  check('跳过的子树：skipped 透传', r2.skipped === 4, JSON.stringify({ s: r2.skipped }))
  check('跳过的子树：skippedNote 明说"truncated 不反映这种丢失"', /truncated 只反映/.test(String(r2.skippedNote)), String(r2.skippedNote).slice(0, 200))
  d2.warmShutdown()
}

// ------------------------------------------------- 7c. 源码守卫：探针必须发 META，且两个上限都要记
{
  const { readFileSync } = await import('node:fs')
  const cs = readFileSync(join(import.meta.dirname, '..', 'probe', 'UiProbe.cs'), 'utf8')
  check('探针发 TREE_META（第一行）', /TREE_META nodes=/.test(cs) && /sb\.Insert\(0,/.test(cs))
  check('探针记录 capHit', /capHit = true/.test(cs) && /capHit=/.test(cs))
  check('探针记录 depthHit（且只在真的有子节点时才算命中）', /depthHit = true/.test(cs) && /kidsAtLimit > 0/.test(cs))
  const driver = readFileSync(join(import.meta.dirname, '..', 'lib', 'driver.mjs'), 'utf8')
  check('driver 解析 META 并剥离该行', /TREE_META/.test(driver) && /body\.slice\(body\.indexOf\('\\n'\) \+ 1\)/.test(driver))
  check('driver 把两个上限算进 truncated', /truncated: textCapped \|\| depthLimited \|\| nodeCapHit/.test(driver))
  check('driver 有 UIA 降级路径（source: uia）', /source: 'uia'/.test(driver))
  check('driver 透传 opaqueRegions（UIA 看不见内容的区域）', /out\.opaqueRegions = opaque/.test(driver) && /opaqueNote/.test(driver))
  check('driver 把 skipped>0 单独说出来（truncated 不反映子树丢失）', /skippedNote/.test(driver))
  const batchSrc2 = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  check('PS：tree 分支识别"大矩形 + 无子节点"的区域', /opaque\.Add/.test(batchSrc2) && /children\.Count -eq 0/.test(batchSrc2))
  check('PS：opaqueRegions 有上限（避免刷噪音）', /opaque\.Count -lt 10/.test(batchSrc2))
  const batch = readFileSync(join(import.meta.dirname, '..', 'scripts', 'ui-drive-batch.ps1'), 'utf8')
  check('批量脚本实现了 tree 动作（UIA 递归）', /'tree' \{/.test(batch) && /function Walk-Uia/.test(batch))
  check('批量脚本的 tree 也报两个上限', /res\.nodeCapHit = \[bool\]\$script:TreeCapHit/.test(batch) && /res\.depthLimited = \[bool\]\$script:TreeDepthHit/.test(batch))
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_TREE_OUT
delete process.env.FAKE_TREE_PAYLOAD
delete process.env.FAKE_BATCH_PAYLOAD
delete process.env.FAKE_PROBE_STDERR

console.log(failures === 0 ? '\nPASS: ui-drive ui_tree 完整性测试' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
