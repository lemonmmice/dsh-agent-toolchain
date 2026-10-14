/**
 * shot-state 单测（无客户端、无 PowerShell）：
 * 守住「纯色 ⇒ 重拍」这条替代视觉黑屏识别的本地判据。
 *
 * ⚠ 判据是**启发式**：这里断言的只是"distinctColors<=2 时重拍、>2 立即返回、未知(null)立即返回"，
 * 不声称它能证明画面渲染完了。
 */
import assert from 'node:assert/strict'
import { shotState } from '../lib/shot-state.mjs'

function fakeDriver(sequence) {
  const calls = []
  let i = 0
  return {
    calls,
    drive: async (args) => {
      calls.push(args)
      const spec = sequence[Math.min(i++, sequence.length - 1)]
      if (spec === null) return { ok: false, error: 'shot failed' }
      return { ok: true, action: 'shot', path: 'shot' + i + '.png', w: 100, h: 50, ...spec }
    },
  }
}

// ① 第一次就够丰富 ⇒ 只截一次，settleRetries=0
{
  const d = fakeDriver([{ distinctColors: 512 }])
  const r = await shotState(d, { label: 'x' })
  assert.equal(d.calls.length, 1)
  assert.equal(r.distinctColors, 512)
  assert.equal(r.settleRetries, 0)
  assert.equal(r.screenshot, 'shot1.png')
  assert.equal(r.size, '100x50')
  assert.equal(r.note, undefined)
}

// ② 连续两个纯色帧后画出来 ⇒ 共 3 次（2 次重拍），最终返回真图且不带 note
{
  const d = fakeDriver([{ distinctColors: 1 }, { distinctColors: 2 }, { distinctColors: 300 }])
  const r = await shotState(d, { label: 'x', retryWaitMs: 1 })
  assert.equal(d.calls.length, 3)
  assert.equal(r.distinctColors, 300)
  assert.equal(r.settleRetries, 2)
  assert.equal(r.note, undefined)
  // 第一次用 label，重拍用 -retryN（证据目录里能看出哪张是重拍）
  assert.equal(d.calls[0].label, 'x')
  assert.equal(d.calls[1].label, 'x-retry1')
  assert.equal(d.calls[2].label, 'x-retry2')
}

// ③ 一直是纯色 ⇒ 用满重拍次数并**如实交代**（note + distinctColors + settleRetries 三个都在）
{
  const d = fakeDriver([{ distinctColors: 1 }])
  const r = await shotState(d, { label: 'x', retryWaitMs: 1 })
  assert.equal(d.calls.length, 3)
  assert.equal(r.distinctColors, 1)
  assert.equal(r.settleRetries, 2)
  assert.match(r.note, /启发式/)
  assert.match(r.note, /不是"空白的证明"/)
}

// ④ 老脚本/老部署副本不返回 distinctColors ⇒ 报 null（未知），**不得**当成"渲染好了"去重拍或断言
{
  const d = fakeDriver([{}])
  const r = await shotState(d, { label: 'x' })
  assert.equal(d.calls.length, 1)
  assert.equal(r.distinctColors, null)
  assert.equal(r.note, undefined)
}

// ⑤ 截图连续失败 ⇒ 用满重拍次数后**如实报 error**（不是静默 null —— 真机实测窗口刚可见那刻会失败一次）
{
  const d = fakeDriver([null])
  const r = await shotState(d, { label: 'x', retryWaitMs: 1 })
  assert.equal(d.calls.length, 3)
  assert.equal(r.screenshot, null)
  assert.equal(r.distinctColors, null)
  assert.equal(r.settleRetries, 2)
  assert.match(r.error, /shot failed/)
}

// ⑤b 第一次失败、第二次成功 ⇒ 重拍救回来（这正是真机上发生的那一次）
{
  const d = fakeDriver([null, { distinctColors: 9 }])
  const r = await shotState(d, { label: 'x', retryWaitMs: 1 })
  assert.equal(d.calls.length, 2)
  assert.equal(r.distinctColors, 9)
  assert.equal(r.settleRetries, 1)
  assert.equal(r.error, undefined)
}

// ⑤c 驱动层抛异常不许带崩调用方（转成可重试失败）
{
  let n = 0
  const d = { calls: [], drive: async () => { n++; if (n === 1) throw new Error('UI_LOCK_BUSY'); return { ok: true, action: 'shot', path: 'p.png', w: 1, h: 1, distinctColors: 5 } } }
  const r = await shotState(d, { label: 'x', retryWaitMs: 1 })
  assert.equal(r.distinctColors, 5)
  assert.equal(r.settleRetries, 1)
}

// ⑥ maxRetries=0 ⇒ 只截一次，纯色也不再重拍（尊重调用方给的次数）
{
  const d = fakeDriver([{ distinctColors: 1 }])
  const r = await shotState(d, { label: 'x', retries: 0, maxRetries: 0 })
  assert.equal(d.calls.length, 1)
  assert.equal(r.settleRetries, 0)
  assert.match(r.note, /重拍 0 次/)
}

console.log('PASS shot-state: 纯色重拍（含次数/标签/note 诚实性）、失败也重拍且如实报 error、未知字段不冒充、异常不带崩调用方')
