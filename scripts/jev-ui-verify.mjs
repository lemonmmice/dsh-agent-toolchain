/**
 * ui_jev 真机验证（只做**零风险**的两件事，不需要用户先确认按钮名）：
 *
 *   --gate   证明 requireUnique 真的被执行器认账。两条探针都刻意选成"门一旦失效也无害"：
 *             ① 匹配 0 个的目标 + click —— 没有任何东西可点，即使门失效也点不到东西；
 *             ② 匹配 ≥2 个的目标 + move —— 门失效时最坏结果是鼠标移动，不会产生点击。
 *            （真正的点击类验证**必须**先报按钮名给用户确认，不放在这里。）
 *
 *   --dry "<目标>"   真跑一次 ui_jev 的完整决策周期（观察 → 真实 Jev 决策 → **不执行**）。
 *            allowSideEffects=false，所以只观察+决策；allowRemoteData 必须显式打开才会
 *            把**脱敏后**的控件清单发到 TypeSafe（这是 dry-run 的用途，不是执行动作）。
 *
 * 用法：
 *   node scripts/jev-ui-verify.mjs --gate
 *   node scripts/jev-ui-verify.mjs --dry "刷新新闻列表"
 */
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { createJevClient } from '../lib/jev-client.mjs'
import { makeJevUiController } from '../lib/jev-ui.mjs'
import { envValue } from '../lib/env-fallback.mjs'

const argv = process.argv.slice(2)
const driver = makeDriver({})
const out = { ok: true, steps: [] }
const need = (cond, message) => { if (!cond) { out.ok = false; out.steps.push({ check: message, pass: false }) } else out.steps.push({ check: message, pass: true }) }

try {
  const status = await driver.status()
  if (!status?.running || !status.pid) throw new Error('目标客户端未运行')
  const target = { procId: status.pid, ...(status.handle ? { winHandle: status.handle } : {}) }

  if (argv.includes('--gate')) {
    // ① 0 匹配 + click：门必须拒绝，且**没有任何东西可点**
    const started1 = performance.now()
    const zero = await driver.drive({ action: 'click', ...target, aid: 'dsh-no-such-aid-for-requireunique-probe', allowSideEffects: true, requireUnique: true, timeoutMs: 20000 })
    out.gateZeroMatch = { ok: zero?.ok, ambiguous: zero?.ambiguous ?? null, count: zero?.count ?? null, error: String(zero?.error || '').slice(0, 120), elapsedMs: Math.round(performance.now() - started1) }
    need(zero?.ok === false && zero?.ambiguous === true && zero?.count === 0, '0 匹配 + click 被 requireUnique 拒绝（ambiguous=true, count=0）')

    // ② ≥2 匹配 + pattern：同一道门，动作换成"注定失败且无副作用"的 pattern。
    //    选 pattern 而不是 click：门一旦失效，最坏结果只是"该控件不支持这个 pattern"报错，
    //    **不会产生点击**。解析（也就是门）发生在调用 pattern 之前，所以这条足以证明 count≥2 分支。
    //    （用 match 而不是 name：match 走 Find-ElementsByMatch，命中面更宽。）
    //    ⚠ 客户端的页面会变（本机实测：进程重启/切页后同一个 `[A-Z]` 从 53 个变成 0 个），
    //    所以这里**按顺序试几种构造歧义的方式**，用第一个真的拿到 ≥2 的；一个都拿不到就如实报"未探到"，
    //    而不是把"探针没构造成歧义"读成"门坏了"。
    const ambiguityProbes = [{ match: '[A-Z]' }, { match: '.' }, { match: '\\S' }, { aid: '', name: '' }]
    let dup = null
    let dupProbe = null
    for (const probe of ambiguityProbes) {
      const started = performance.now()
      const r = await driver.drive({ action: 'pattern', ...target, ...probe, value: 'NoSuchPatternForGateProbe', allowSideEffects: true, requireUnique: true, timeoutMs: 20000 })
      if (Number(r?.count) >= 2) { dup = r; dupProbe = { probe, elapsedMs: Math.round(performance.now() - started) }; break }
      if (!dupProbe) dupProbe = { probe, elapsedMs: Math.round(performance.now() - started), lastCount: r?.count ?? null, lastError: String(r?.error || '').slice(0, 120) }
    }
    out.gateDuplicate = dup
      ? { probe: dupProbe.probe, value: 'NoSuchPatternForGateProbe', ok: dup.ok, ambiguous: dup.ambiguous ?? null, count: dup.count ?? null, error: String(dup.error || '').slice(0, 140), elapsedMs: dupProbe.elapsedMs }
      : { inconclusive: true, reason: '这几种构造都没能拿到 ≥2 个匹配（页面内容变了），未探到该分支', attempted: dupProbe }
    need(dup !== null && dup.ok === false && dup.ambiguous === true && Number(dup.count) >= 2,
      dup ? `≥2 匹配 + pattern 被 requireUnique 拒绝（ambiguous=true, count=${dup.count}）` : '≥2 匹配分支：本页未探到（inconclusive，不是"门坏了"）')

    // ③ 窗口漂移：winHandle 是**真**窗口（否则 Resolve-Window 就先报错了，探不到这道门），
    //    只有 expectedWindowHandle 对不上 ⇒ 模拟"观察之后界面换了窗口"。动作仍是那个无副作用的 pattern。
    const realHandle = Number(target.winHandle)
    const started3 = performance.now()
    const wdrift = await driver.drive({ action: 'pattern', ...target, aid: 'dsh-no-such-aid-for-drift-probe', value: 'NoSuchPatternForGateProbe',
      allowSideEffects: true, expectedWindowHandle: realHandle + 1, timeoutMs: 20000 })
    out.gateWindowDrift = { ok: wdrift?.ok, drift: wdrift?.drift ?? null, windowHandle: wdrift?.windowHandle ?? null, expectedWindowHandle: wdrift?.expectedWindowHandle ?? null, error: String(wdrift?.error || '').slice(0, 160), elapsedMs: Math.round(performance.now() - started3) }
    need(wdrift?.ok === false && wdrift?.drift === true, '窗口句柄不符 ⇒ 动作前被漂移门拒绝（drift=true）')

    // ④ 元素漂移：拿一个**真实存在**的唯一目标，给一个明显不对的 expectedRect。
    //    门失效时最坏结果只是 pattern 名字不认识而报错（不见得会 drift）——所以断言必须看 drift，
    //    不能只看 ok:false，否则"门没生效"会被读成通过。
    const observation = await driver.drive({ action: 'state', ...target, max: 500, timeoutMs: 20000 })
    // 优先挑**自带 AutomationId** 的目标：aid 是开发者设置的，比 name 稳定（菜单元件名里带整棵子树文本，
    // 一旦展开就变；本机实测按 name 挑的目标两次调用之间就会消失 ⇒ ⑤ 会退化成"未找到"而不是"没漂移"）。
    const controls = observation?.controls || []
    const pick = controls.find(c => c.enabled === true && c.rect && c.aid) || controls.find(c => c.enabled === true && c.rect && c.name)
    if (!pick) {
      out.ok = false
      out.steps.push({ check: '④ 需要一个带 rect 的真实控件来探元素漂移门', pass: false, note: '本次观察里没有可用目标（inconclusive）' })
    } else {
      const sel = { ...(pick.aid ? { aid: pick.aid } : {}), ...(pick.name ? { name: pick.name } : {}) }
      const started4 = performance.now()
      const edrift = await driver.drive({ action: 'pattern', ...target, ...sel,
        value: 'NoSuchPatternForGateProbe', allowSideEffects: true, expectedRect: { x: 0, y: 0, w: 1, h: 1 }, timeoutMs: 20000 })
      out.gateElementDrift = { target: { type: pick.type, aid: pick.aid, name: String(pick.name).slice(0, 40) }, observedRect: pick.rect,
        ok: edrift?.ok, drift: edrift?.drift ?? null, movedBy: edrift?.movedBy ?? null, error: String(edrift?.error || '').slice(0, 160), elapsedMs: Math.round(performance.now() - started4) }
      need(edrift?.ok === false && edrift?.drift === true, '元素矩形不符 ⇒ 动作前被漂移门拒绝（drift=true）')

      // ⑤ 反向自证：**正确的** expectedRect 不能被误判成漂移。
      //    没有这一条，④ 只能证明"门会拒"，证明不了"门不瞎拒" —— 一个把一切拒掉的门同样能过 ④。
      //    动作是注定失败且无副作用的 pattern：门若放行，报错会是"不支持该 pattern"而不是 drift。
      //    ⚠ 若目标在两次调用之间消失（"未找到目标控件"），这条是**未探到**，不是"没漂移" —— 如实标注。
      const started5 = performance.now()
      const keep = await driver.drive({ action: 'pattern', ...target, ...sel,
        value: 'NoSuchPatternForGateProbe', allowSideEffects: true, expectedRect: pick.rect, timeoutMs: 20000 })
      const inconclusive = keep?.ok === false && keep?.drift !== true && /未找到/.test(String(keep?.error || ''))
      out.gateNoFalsePositive = { ok: keep?.ok, drift: keep?.drift ?? null, inconclusive, error: String(keep?.error || '').slice(0, 160), elapsedMs: Math.round(performance.now() - started5) }
      need(keep?.drift !== true, inconclusive
        ? '矩形相符时的反向自证：本次目标在两次调用之间消失（未探到，不是"没漂移"）'
        : '矩形相符时**不得**被判成漂移（门不能瞎拒）')
    }
  }

  const dryIndex = argv.indexOf('--dry')
  if (dryIndex >= 0) {
    const goal = argv[dryIndex + 1] || ''
    const key = envValue('TYPESAFE_API_KEY')
    out.jev = { configured: Boolean(key.value), source: key.source }
    const controller = makeJevUiController({ driver, jevClient: createJevClient({ apiKey: key.value }) })
    const started = performance.now()
    const result = await controller.run({ goal, ...target, allowRemoteData: true, allowSideEffects: false, maxSteps: 2, timeoutMs: 5000 })
    out.dryRun = { goal, elapsedMs: Math.round(performance.now() - started), result }
    need(result?.ok === true, 'dry-run 决策周期跑通（未执行任何动作）')
  }

  if (!argv.includes('--gate') && dryIndex < 0) out.note = '没给模式：加 --gate 或 --dry "<目标>"'
} catch (error) {
  out.ok = false
  out.error = String(error?.message || error)
} finally {
  try { await driver.warmShutdown() } catch { /* 关不掉不影响结论 */ }
  try { driver.releaseLock() } catch { /* 同上 */ }
}

console.log(JSON.stringify(out, null, 2))
for (const s of out.steps) console.log(`${s.pass ? 'ok  ' : 'FAIL'} ${s.check}${s.note ? ' — ' + s.note : ''}`)
// 不用 process.exit()：--dry 走过 fetch（undici 的 keep-alive socket），在 socket 正在关闭时
// 硬退会踩 libuv 的 win/async.c 断言（本机实测 exit=-1073740791，且是在打印完结论之后）。
// 设 exitCode 让 Node 自己收尾，结论一样、退出码一样。
process.exitCode = out.ok ? 0 : 1
