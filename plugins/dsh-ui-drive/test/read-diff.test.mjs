// dsh-ui-drive W1 单测：新鲜度门（snapshotId）+ 动作分类契约 + read(diff=true)
// （离线：不需要客户端；批量/一次性脚本用 fake ps1，DSH_UI_SERVE=0 关掉常驻进程）
//
// 只增本文件、不改 read-skips.test.mjs（既有 35 断言逐条不变通过是硬门）。
// 覆盖 round2 §6 的 C1–C13：
//   C1  六个读产出点全戳 snapshotId（seq∧gen）；seq 单调、gen==当前
//   C2  state-live 不发权威 id（snapshotAuthoritative:false）、不抬升权威 seq
//   C3  写门是唯一单点、动作分类 key 在这张表上（含坐标动作、未知动作按副作用）
//   C4  带匹配最新（seq∧gen）→ 放行且真执行
//   C5  带陈旧 seq → 硬拒、未执行、allowSideEffects:true 也拒
//   C6  陈旧原因可区分（newer-read-same-window / newer-read-other-window）
//   C7  带未知 id → unknownSnapshot、未执行
//   C8  warmRestart()/gen++ 后旧 id → expiredSnapshot、未执行
//   C9  不带 snapshotId → 放行（零回归）且真执行
//   C10 首读 diff=true → diffBaseline、完整 lines、无幻影 diff
//   C11 次读（+1 −1）→ added/removed/unchanged 精确
//   C12 skipped>0 或空枚举 → 抑制 diff、diffSuppressed、保留 warn、回落完整 lines、不污染基线
//   C13 渲染层出 diff 摘要且可测（首读/抑制时不出摘要）
import { makeDriver } from '../lib/driver.mjs'
import { renderDrive } from '../lib/render.mjs'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const scriptsDir = mkdtempSync(join(tmpdir(), 'ui-drive-diff-'))
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-drive-diff-ev-'))

// 执行器调用哨兵：假脚本每被 spawn 一次就往哨兵文件追加一行；被写门拒掉的动作绝不触达脚本，
// 于是「拒绝前后哨兵不变」= 执行器调用计数 0（对齐冻结方案「执行器调用计数=0」的机器裁决）。
const batchSentinel = join(scriptsDir, 'batch-calls.log')
const oneShotSentinel = join(scriptsDir, 'oneshot-calls.log')
process.env.FAKE_BATCH_SENTINEL = batchSentinel
process.env.FAKE_ONESHOT_SENTINEL = oneShotSentinel
const sentinelLen = (p) => (existsSync(p) ? readFileSync(p, 'utf8').length : 0)

/** 假批量脚本：追加哨兵 + 把 FAKE_BATCH_PAYLOAD 写到 -Out 并打印 RESULT_JSON=（与 read-skips 同套路）。 */
function writeFakeBatch() {
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$StepsFile='',[string]$Out='',[int]$DefaultWaitMs=250,[switch]$Status,[switch]$Serve)
if ($env:FAKE_BATCH_SENTINEL) { Add-Content -LiteralPath $env:FAKE_BATCH_SENTINEL -Value 'x' }
if ($Out) { [System.IO.File]::WriteAllText($Out, [string]$env:FAKE_BATCH_PAYLOAD, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ('RESULT_JSON=' + [string]$env:FAKE_BATCH_PAYLOAD)
`
  writeFileSync(join(scriptsDir, 'ui-drive-batch.ps1'), body, 'utf8')
  writeFileSync(join(scriptsDir, 'ui-probe.ps1'), '# stub\n', 'utf8')
}

/** 假一次性脚本：read → 输出一行控件 + SKIPPED 0（走一次性 read 产出点）；click → CLICKED。 */
function writeFakeOneShot() {
  const body = `param([string]$ProcName='',[string]$WindowName='',[int]$ProcId=0,[string]$Action='',[string]$Name='',[string]$Aid='',[string]$Value='',[switch]$Ascii,[string]$Match='',[int]$WaitMs=0,[string]$Out='')
if ($env:FAKE_ONESHOT_SENTINEL) { Add-Content -LiteralPath $env:FAKE_ONESHOT_SENTINEL -Value 'x' }
if ($Action -eq 'read') { Write-Output '[Button] "A" enabled=True @1,1 10x10'; Write-Output 'SKIPPED 0' }
elseif ($Action -eq 'click') { Write-Output 'CLICKED btn' }
else { Write-Output 'OK' }
`
  writeFileSync(join(scriptsDir, 'ui-drive.ps1'), body, 'utf8')
}

writeFakeBatch()
writeFakeOneShot()

function setBatchPayload(obj) { process.env.FAKE_BATCH_PAYLOAD = JSON.stringify(obj) }
function newDriver() {
  process.env.DSH_UI_SERVE = '0' // 只验批量/一次性/纯逻辑路径，常驻进程另有专项
  // windowName 显式置空：否则环境里注入的 DSH_UI_WINDOW_NAME 会成为默认目标窗口，
  // 令「不声明窗口」的点击触发跨窗口校验（本测试要验的是 seq/gen，不掺窗口维度）。
  return makeDriver({ scriptsDir, evidenceDir, procName: 'FakeProc', windowName: '' })
}
// 读产出：一个 state 步（带窗口），供快照戳记
const stateStep = (window = '主窗口') => ({ ok: true, elapsedMs: 1, window, steps: [
  { step: 1, action: 'state', ok: true, window, focused: null, count: 1, lines: ['#0 [Button] "A"'] },
] })
const readStep = (lines, extra = {}) => ({ ok: true, elapsedMs: 1, steps: [
  { step: 1, action: 'read', ok: true, count: lines.length, lines, ...extra },
] })
const clickStep = () => ({ ok: true, elapsedMs: 1, steps: [{ step: 1, action: 'click', ok: true, output: 'CLICKED btn' }] })

// =======================================================================================
// Block A — C3：动作分类契约（纯函数，未知动作按副作用；写门 key 在这张表上）
// =======================================================================================
console.log('\n[A] classifyAction 表（C3 / W5a）')
{
  const d = newDriver()
  const T = {
    clickat: 'coord-effect', drag: 'coord-effect',
    doubleclick: 'effect', click: 'effect', setvalue: 'effect', key: 'effect', type: 'effect',
    move: 'input', wheel: 'input',
    read: 'read', state: 'read', 'state-live': 'read', find: 'read', shot: 'read', windows: 'read', waitfor: 'read',
  }
  for (const [a, want] of Object.entries(T)) check('classify ' + a + ' = ' + want, d.classifyAction(a) === want, d.classifyAction(a))
  check('未知动作按副作用（frobnicate→effect）', d.classifyAction('frobnicate') === 'effect', d.classifyAction('frobnicate'))
  check('大小写归一（CLICK→effect）', d.classifyAction('CLICK') === 'effect', d.classifyAction('CLICK'))
  d.warmShutdown()
}

// =======================================================================================
// Block B — C4–C9：validateSnapshot 判定矩阵（纯函数，状态从 ctx 显式传入）
// =======================================================================================
console.log('\n[B] validateSnapshot 矩阵（C4–C9 逻辑）')
{
  const d = newDriver()
  const id = (seq, gen, wh) => d.encodeSnapshotId({ seq, gen, windowHandle: wh })

  // C9：不传 → 放行（零回归）
  check('C9 无 snapshotId → allow(no-snapshot)', d.validateSnapshot({}, { currentGen: 0, latest: null }).code === 'no-snapshot')
  check('C9 空串 → allow', d.validateSnapshot({ snapshotId: '' }, { currentGen: 0, latest: null }).allow === true)

  // C4：seq∧gen 匹配最新 → 放行
  const fresh = d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 0, latest: { seq: 1, gen: 0, windowHandle: 'W' } })
  check('C4 匹配最新 → allow(fresh)', fresh.allow === true && fresh.code === 'fresh', JSON.stringify(fresh))

  // C5+C6：陈旧 seq → 拒，且原因可区分
  const sameWin = d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 0, latest: { seq: 2, gen: 0, windowHandle: 'W' } })
  check('C5 陈旧 seq → staleSnapshot', sameWin.allow === false && sameWin.code === 'staleSnapshot', JSON.stringify(sameWin))
  check('C6 同窗口更新 → newer-read-same-window', sameWin.reason === 'newer-read-same-window', sameWin.reason)
  const otherWin = d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 0, latest: { seq: 2, gen: 0, windowHandle: 'X' } })
  check('C6 别的窗口更新 → newer-read-other-window', otherWin.reason === 'newer-read-other-window', otherWin.reason)

  // C8：gen 不符 → 世代失效（重启失效维度）
  const exp = d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 1, latest: { seq: 1, gen: 1, windowHandle: 'W' } })
  check('C8 gen 不符 → expiredSnapshot', exp.allow === false && exp.code === 'expiredSnapshot', JSON.stringify(exp))

  // C7：未知 id（无法解析 / 从未签发 / 尚无权威读）→ unknownSnapshot，绝不放行
  check('C7 无法解析 → unknownSnapshot', d.validateSnapshot({ snapshotId: 'garbage' }, { currentGen: 0, latest: { seq: 1, gen: 0, windowHandle: 'W' } }).code === 'unknownSnapshot')
  check('C7 seq 超过最新（从未签发）→ unknownSnapshot', d.validateSnapshot({ snapshotId: id(9, 0, 'W') }, { currentGen: 0, latest: { seq: 2, gen: 0, windowHandle: 'W' } }).code === 'unknownSnapshot')
  check('C7 尚无权威读 → unknownSnapshot', d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 0, latest: null }).code === 'unknownSnapshot')

  // 跨窗口复用（读一个窗口、显式点另一个窗口）→ 落安全侧拒（v1 不覆盖，多拒→重读）
  const cross = d.validateSnapshot({ snapshotId: id(1, 0, 'W'), winTitle: 'X' }, { currentGen: 0, latest: { seq: 1, gen: 0, windowHandle: 'W' }, targetWindow: 'X' })
  check('跨窗口复用 → 拒（safe-side）', cross.allow === false && cross.code === 'staleSnapshot', JSON.stringify(cross))
  const sameTarget = d.validateSnapshot({ snapshotId: id(1, 0, 'W') }, { currentGen: 0, latest: { seq: 1, gen: 0, windowHandle: 'W' }, targetWindow: 'W' })
  check('目标窗口一致 → allow', sameTarget.allow === true, JSON.stringify(sameTarget))
  d.warmShutdown()
}

// =======================================================================================
// Block C — C1/C2：六个读产出点全戳 snapshotId；state-live 非权威、不抬升 seq
// =======================================================================================
console.log('\n[C] 戳记覆盖（C1）+ state-live 非权威（C2）')
{
  const d = newDriver()
  // 1) shapeResult read（index 强制批量单步）
  setBatchPayload(readStep(['#0 [Button] "A"'], { skipped: 0 }))
  const r1 = await d.drive({ action: 'read', match: 'x', index: 0 })
  check('C1 批量 read 戳 snapshotId(string)', typeof r1.snapshotId === 'string', JSON.stringify(r1).slice(0, 120))
  const p1 = d.decodeSnapshotId(r1.snapshotId)
  check('C1 解析出 seq/gen', p1 && p1.seq === 1 && p1.gen === 0, JSON.stringify(p1))

  // 2) shapeResult state
  setBatchPayload(stateStep('主窗口'))
  const s1 = await d.drive({ action: 'state' })
  check('C1 state 戳 snapshotId', typeof s1.snapshotId === 'string', JSON.stringify(s1).slice(0, 120))
  const p2 = d.decodeSnapshotId(s1.snapshotId)
  check('C1 seq 单调递增（1→2）', p2 && p2.seq === 2, JSON.stringify(p2))
  check('C1 state 的 windowHandle 取窗口标题', p2 && p2.windowHandle === '主窗口', JSON.stringify(p2))

  // 4) state-live：不发权威 id、不抬升权威 seq（C2）
  const seqBefore = d.snapshotState().seq
  setBatchPayload({ ok: true, elapsedMs: 1, steps: [{ step: 1, action: 'state-live', ok: true, window: '主窗口', count: 1, lines: ['#0 [Button] "A"'], secretFocused: false }] })
  const sl = await d.drive({ action: 'state-live' })
  check('C2 state-live 不发 snapshotId', sl.snapshotId === undefined, JSON.stringify(sl).slice(0, 120))
  check('C2 state-live 标 snapshotAuthoritative:false', sl.snapshotAuthoritative === false, JSON.stringify(sl.snapshotAuthoritative))
  check('C2 state-live 不抬升权威 seq', d.snapshotState().seq === seqBefore, d.snapshotState().seq + ' vs ' + seqBefore)

  // 5+6) flow read/state 也戳
  setBatchPayload({ ok: true, elapsedMs: 1, window: '主窗口', steps: [
    { step: 1, action: 'read', ok: true, count: 1, lines: ['#0 [Button] "A"'], skipped: 0 },
    { step: 2, action: 'state', ok: true, window: '主窗口', focused: null, count: 1, lines: ['#0 [Button] "A"'], skipped: 0 },
  ] })
  const f = await d.flow({ tag: 'unit-diff-stamp', steps: [{ action: 'read', match: 'x' }, { action: 'state' }] })
  check('C1 flow read 步戳 snapshotId', typeof f.transcript[0].snapshotId === 'string', JSON.stringify(f.transcript[0]).slice(0, 120))
  check('C1 flow state 步戳 snapshotId', typeof f.transcript[1].snapshotId === 'string', JSON.stringify(f.transcript[1]).slice(0, 120))
  d.warmShutdown()
}
{
  // 3) 一次性 read 产出点（无 index、read 不在 BATCH_ONLY → 走一次性 ui-drive.ps1）
  const d = newDriver()
  const r = await d.drive({ action: 'read' })
  check('C1 一次性 read 解析出 1 行', r.ok === true && r.count === 1, JSON.stringify(r).slice(0, 120))
  check('C1 一次性 read 戳 snapshotId', typeof r.snapshotId === 'string', JSON.stringify(r).slice(0, 120))
  d.warmShutdown()
}

// =======================================================================================
// Block D — 写侧单点端到端：拒绝路径「执行器调用计数=0」，放行路径真执行
// =======================================================================================
console.log('\n[D] 写门端到端（C4/C5/C7/C8/C9 + 坐标动作 C3）')
{
  const d = newDriver()
  // 取一个新鲜 id（state 读）
  setBatchPayload(stateStep('主窗口'))
  const s = await d.drive({ action: 'state' })
  const freshId = s.snapshotId

  // C4：新鲜 id → 放行且真执行（哨兵 +1）
  setBatchPayload(clickStep())
  let n0 = sentinelLen(batchSentinel)
  const okClick = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: freshId })
  check('C4 新鲜 id → 执行（output CLICKED）', okClick.ok === true && /CLICK/.test(okClick.output || ''), JSON.stringify(okClick))
  check('C4 执行器被调用（哨兵 +1）', sentinelLen(batchSentinel) > n0)

  // 现在再读一次 → freshId 变陈旧（seq 落后）
  setBatchPayload(stateStep('主窗口'))
  await d.drive({ action: 'state' })

  // C5：陈旧 seq → 拒、未执行、allowSideEffects:true 也拒
  setBatchPayload(clickStep())
  n0 = sentinelLen(batchSentinel)
  const stale = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: freshId })
  check('C5 陈旧 → ok:false', stale.ok === false, JSON.stringify(stale))
  check('C5 陈旧 → staleSnapshot 是原因串', typeof stale.staleSnapshot === 'string' && /same-window|other-window/.test(stale.staleSnapshot), JSON.stringify(stale.staleSnapshot))
  check('C5 陈旧 → 执行器调用计数 0（哨兵不变）', sentinelLen(batchSentinel) === n0)
  check('C5 陈旧 → 无 output（真没执行）', stale.output === undefined, JSON.stringify(stale.output))

  // C7：未知 id → unknownSnapshot、未执行
  n0 = sentinelLen(batchSentinel)
  const unk = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: 'not-a-real-id' })
  check('C7 未知 id → unknownSnapshot', unk.ok === false && unk.unknownSnapshot === true, JSON.stringify(unk))
  check('C7 未知 id → 执行器调用计数 0', sentinelLen(batchSentinel) === n0)

  // C9：不带 snapshotId → 放行且真执行（零回归）
  setBatchPayload(clickStep())
  n0 = sentinelLen(batchSentinel)
  const noId = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true })
  check('C9 不带 snapshotId → 执行', noId.ok === true && /CLICK/.test(noId.output || ''), JSON.stringify(noId))
  check('C9 不带 snapshotId → 执行器被调用', sentinelLen(batchSentinel) > n0)

  // C3：坐标动作走同一写门——clickat 不带 allowSideEffects → 拒、未执行
  n0 = sentinelLen(batchSentinel)
  const coordDenied = await d.drive({ action: 'clickat', x: 10, y: 10, index: 0 })
  check('C3 clickat 无 allowSideEffects → 拒', coordDenied.ok === false && /allowSideEffects/.test(coordDenied.error || ''), JSON.stringify(coordDenied))
  check('C3 clickat 被拒 → 执行器调用计数 0', sentinelLen(batchSentinel) === n0)
  d.warmShutdown()
}
{
  // C8：warmRestart()（gen++）后旧 id → expiredSnapshot、未执行
  const d = newDriver()
  setBatchPayload(stateStep('主窗口'))
  const s = await d.drive({ action: 'state' })
  const id = s.snapshotId
  d.warmRestart() // gen++
  setBatchPayload(clickStep())
  const n0 = sentinelLen(batchSentinel)
  const expired = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: id })
  check('C8 warmRestart 后旧 id → expiredSnapshot', expired.ok === false && expired.expiredSnapshot === true, JSON.stringify(expired))
  check('C8 世代失效 → 执行器调用计数 0', sentinelLen(batchSentinel) === n0)
  d.warmShutdown()
}

// =======================================================================================
// Block E — C6 端到端：戳记 + 写门共同产出可区分的陈旧原因
// =======================================================================================
console.log('\n[E] 陈旧原因端到端（C6）')
{
  const d = newDriver()
  setBatchPayload(stateStep('主窗口'))
  const a = await d.drive({ action: 'state' }) // seq1 wh=主窗口
  setBatchPayload(stateStep('主窗口'))
  await d.drive({ action: 'state' })            // seq2 wh=主窗口
  setBatchPayload(clickStep())
  const same = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: a.snapshotId })
  check('C6 同窗口再读 → newer-read-same-window', same.staleSnapshot === 'newer-read-same-window', JSON.stringify(same.staleSnapshot))
  d.warmShutdown()
}
{
  const d = newDriver()
  setBatchPayload(stateStep('主窗口'))
  const a = await d.drive({ action: 'state' }) // seq1 wh=主窗口
  setBatchPayload(stateStep('弹窗'))
  await d.drive({ action: 'state' })            // seq2 wh=弹窗
  setBatchPayload(clickStep())
  const other = await d.drive({ action: 'click', name: 'btn', index: 0, allowSideEffects: true, snapshotId: a.snapshotId })
  check('C6 别的窗口再读 → newer-read-other-window', other.staleSnapshot === 'newer-read-other-window', JSON.stringify(other.staleSnapshot))
  d.warmShutdown()
}

// =======================================================================================
// Block F — diff（C10/C11/C12/C13）
// =======================================================================================
console.log('\n[F] read(diff=true)（C10–C13）')
{
  const d = newDriver()
  // C10：首读 → diffBaseline、完整 lines、无幻影 diff
  setBatchPayload(readStep(['#0 [Button] "A"', '#1 [Text] "B"'], { skipped: 0 }))
  const base = await d.drive({ action: 'read', match: 'x', index: 0, diff: true })
  check('C10 首读 diffBaseline:true', base.diffBaseline === true, JSON.stringify(base).slice(0, 160))
  check('C10 首读无 diff 对象', base.diff === undefined, JSON.stringify(base.diff))
  check('C10 首读保留完整 lines', Array.isArray(base.lines) && base.lines.length === 2, JSON.stringify(base.lines))

  // C11：次读（B→C，即 +1 −1）→ added/removed/unchanged 精确
  setBatchPayload(readStep(['#0 [Button] "A"', '#1 [Text] "C"'], { skipped: 0 }))
  const d2 = await d.drive({ action: 'read', match: 'x', index: 0, diff: true })
  check('C11 diff.added 精确（新增 C）', d2.diff && d2.diff.added.length === 1 && /"C"/.test(d2.diff.added[0]), JSON.stringify(d2.diff))
  check('C11 diff.removed 精确（移除 B）', d2.diff && d2.diff.removed.length === 1 && /"B"/.test(d2.diff.removed[0]), JSON.stringify(d2.diff))
  check('C11 diff.unchanged 精确（A 不变=1）', d2.diff && d2.diff.unchanged === 1, JSON.stringify(d2.diff))

  // C13：渲染出摘要
  const txt = renderDrive(d2)
  check('C13 渲染出「新增 1 / 移除 1」摘要', /新增 1 \/ 移除 1/.test(txt), txt.slice(-160))
  check('C13 首读渲染不出增减摘要（出「基线」）', /基线/.test(renderDrive(base)) && !/新增 \d+ \/ 移除/.test(renderDrive(base)), renderDrive(base).slice(-120))
  d.warmShutdown()
}
{
  // C12：skipped>0 → 抑制 diff、保留 warn、回落完整 lines、且不污染基线
  const d = newDriver()
  setBatchPayload(readStep(['#0 [Button] "A"', '#1 [Text] "B"'], { skipped: 0 }))
  await d.drive({ action: 'read', match: 'x', index: 0, diff: true }) // 基线 [A,B]

  setBatchPayload(readStep(['#0 [Edit] "X"'], { skipped: 3, skippedReasons: ['读取元素状态失败'] }))
  const sup = await d.drive({ action: 'read', match: 'x', index: 0, diff: true })
  check('C12 skipped>0 → diffSuppressed:true', sup.diffSuppressed === true, JSON.stringify(sup).slice(0, 160))
  check('C12 skipped>0 → 无 diff 对象', sup.diff === undefined, JSON.stringify(sup.diff))
  check('C12 skipped>0 → 保留 warn（不完整）', typeof sup.warn === 'string' && /跳过 3/.test(sup.warn), String(sup.warn))
  check('C12 skipped>0 → 回落完整 lines', Array.isArray(sup.lines) && sup.lines.length === 1, JSON.stringify(sup.lines))
  check('C13 抑制渲染出「抑制」且不出增减摘要', /抑制/.test(renderDrive(sup)) && !/新增 \d+ \/ 移除/.test(renderDrive(sup)), renderDrive(sup).slice(-120))

  // 基线未被污染：下一次完整读应与原基线 [A,B] 比，而不是与被抑制的 [X] 比
  setBatchPayload(readStep(['#0 [Button] "A"', '#1 [Text] "C"'], { skipped: 0 }))
  const after = await d.drive({ action: 'read', match: 'x', index: 0, diff: true })
  check('C12 抑制不污染基线（vs [A,B]：+C −B）', after.diff && after.diff.added.length === 1 && /"C"/.test(after.diff.added[0]) && after.diff.removed.length === 1 && /"B"/.test(after.diff.removed[0]), JSON.stringify(after.diff))
  d.warmShutdown()
}
{
  // C12：空枚举同样抑制 diff（UIA 给空集合、不报错）
  const d = newDriver()
  setBatchPayload(readStep(['#0 [Button] "A"'], { skipped: 0 }))
  await d.drive({ action: 'read', match: 'x', index: 0, diff: true }) // 基线
  setBatchPayload(readStep([], { skipped: 0, scanned: 0 }))
  const empty = await d.drive({ action: 'read', match: 'x', index: 0, diff: true })
  check('C12 空枚举 → diffSuppressed', empty.diffSuppressed === true, JSON.stringify(empty).slice(0, 160))
  check('C12 空枚举 → 保留空枚举 warn', /0 个元素/.test(empty.warn || ''), String(empty.warn))
  check('C12 空枚举 → 无 diff 对象', empty.diff === undefined, JSON.stringify(empty.diff))
  d.warmShutdown()
}

rmSync(scriptsDir, { recursive: true, force: true })
rmSync(evidenceDir, { recursive: true, force: true })
delete process.env.FAKE_BATCH_PAYLOAD
delete process.env.FAKE_BATCH_SENTINEL
delete process.env.FAKE_ONESHOT_SENTINEL

console.log(failures === 0 ? '\nPASS: ui-drive read-diff / freshness-gate / classify unit test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
