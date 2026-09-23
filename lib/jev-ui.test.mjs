import assert from 'node:assert/strict'
import { makeJevUiController } from './jev-ui.mjs'

const menu = name => ({ type: 'MenuItem', name, aid: '', enabled: true, expanded: 'Collapsed', patterns: ['ExpandCollapse'] })
const button = name => ({ type: 'Button', name, aid: '', enabled: true, patterns: ['Invoke'] })
const initial = [menu('行情\r\n├─指数\r\n│  └─股转指数\r\n')]
const authorized = { goal: '打开行情菜单中的股转指数', allowRemoteData: true, allowSideEffects: true, maxSteps: 3, expectSelected: '股转指数' }

function fixture({ states = [initial], answers = ['control_0_act'], confidence = 0.96, result = { ok: true, actionId: 'act-test' }, count = 1, snapshot = true,
  windowHandle = null, skipped = 0, target = { running: true, pid: 111, handle: 222 } } = {}) {
  const calls = []
  const requests = []
  const executed = [] // 真正被执行的动作（被唯一性门/漂移门拒绝的不计入）
  let statusCalls = 0
  let stateIndex = 0
  let answerIndex = 0
  const driver = {
    status: async () => { statusCalls++; return target },
    drive: async args => {
      calls.push(args)
      if (args.action === 'state') return { ok: true, controls: states[Math.min(stateIndex++, states.length - 1)], skipped, windowHandle, observationId: `obs-${stateIndex}`, snapshotId: snapshot ? `s${stateIndex}` : undefined }
      // 唯一性门已并进动作调用：这里**不再**接受单独的 find 轮（它曾让每个动作多付一整轮 UIA 扫描）
      if (args.action === 'find') throw new Error('ui_jev 不该再单独 find：唯一性门应通过 requireUnique 并进动作调用')
      if (args.requireUnique !== true) throw new Error('动作调用必须带 requireUnique=true，否则唯一性门就丢了')
      // 批量引擎的语义：不唯一 / 已漂移 ⇒ 在**执行之前**拒绝，回报事实，动作一次都不执行
      if (count !== 1) return { ok: false, ambiguous: true, count, error: `目标不唯一：requireUnique 要求恰好 1 个匹配，实际 ${count} 个` }
      if (result && result.drift === true) return result
      executed.push(args.action)
      return result
    },
  }
  const jevClient = { evaluate: async request => {
    requests.push(request)
    return { ok: true, latencyMs: 100, answers: { next: { type: 'choice', confidence, choice: answers[Math.min(answerIndex++, answers.length - 1)] } } }
  } }
  return { controller: makeJevUiController({ driver, jevClient }), calls, requests, executed, statusCalls: () => statusCalls }
}

const remote = fixture()
assert.equal((await remote.controller.run({ goal: '打开行情' })).errorCode, 'remote_data_not_allowed')
assert.equal(remote.calls.length, 0)
assert.equal(remote.requests.length, 0)

const dry = fixture()
const dryResult = await dry.controller.run({ ...authorized, allowSideEffects: false })
assert.equal(dryResult.stopped, 'dry_run')
assert.equal(dry.calls.length, 1)
assert.equal(dryResult.decision.target.name, initial[0].name)
assert.equal(dryResult.decision.target.value, 'Expand')

const multi = fixture({ states: [initial, [menu('指数\r\n├─沪深京指数\r\n└─股转指数\r\n')], [button('股转指数')], [{ type: 'TabItem', name: '股转指数', aid: '', selected: true, enabled: true, patterns: ['SelectionItem'] }]] })
const multiResult = await multi.controller.run(authorized)
assert.equal(multiResult.completed, true)
assert.equal(multiResult.verification.kind, 'uia_selection')
assert.deepEqual(multi.calls.filter(call => ['pattern', 'click'].includes(call.action)).map(call => call.value || call.action), ['Expand', 'Expand', 'click'])
assert.deepEqual(multi.calls.filter(call => ['pattern', 'click'].includes(call.action)).map(call => call.snapshotId), ['s1', 's2', 's3'])
assert.equal(multi.requests.length, 3)
assert.equal(multi.calls.filter(call => call.action === 'state').length, 4)

const repeated = fixture()
assert.equal((await repeated.controller.run(authorized)).stopped, 'repeated_action')
assert.equal(repeated.calls.filter(call => call.action === 'pattern').length, 1)

for (const count of [0, 2]) {
  const ambiguous = fixture({ count })
  assert.equal((await ambiguous.controller.run(authorized)).stopped, 'target_not_unique')
  assert.equal(ambiguous.executed.length, 0, '被唯一性门拒绝时必须一个动作都没执行')
  assert.equal(ambiguous.calls.some(call => call.action === 'find'), false, '不该再单独 find 一轮')
}
// 正例：唯一时动作照常执行，且唯一性门确实挂在动作调用上（不是被删掉了）
const unique = fixture()
const uniqueResult = await unique.controller.run(authorized)
assert.equal(uniqueResult.stopped, 'repeated_action')
assert.deepEqual(unique.executed, ['pattern'], '恰好执行一次动作')
assert.equal(unique.calls.find(call => call.action === 'pattern').requireUnique, true)
assert.equal(unique.calls.some(call => call.action === 'find'), false)
const missingSnapshot = fixture({ snapshot: false })
assert.equal((await missingSnapshot.controller.run(authorized)).errorCode, 'ui_jev_observation_unsupported')
assert.equal(missingSnapshot.requests.length, 0)

for (const confidence of [0.4, null, '0.99', NaN]) {
  const invalid = fixture({ confidence })
  const result = await invalid.controller.run(authorized)
  assert.equal(result.completed, false)
  assert.equal(invalid.calls.some(call => call.action === 'pattern'), false)
}
const unknownChoice = fixture({ answers: ['invented_action'] })
assert.equal((await unknownChoice.controller.run(authorized)).errorCode, 'ui_jev_invalid_decision')
const unknownResult = fixture({ result: { ok: false, unknown: true, error: 'timeout' } })
assert.equal((await unknownResult.controller.run(authorized)).errorCode, 'ui_jev_action_unknown')
assert.equal(unknownResult.calls.filter(call => call.action === 'pattern').length, 1)
const modelDone = fixture({ answers: ['done'] })
assert.equal((await modelDone.controller.run(authorized)).completed, false)

const scoped = fixture({ states: [[button('public'), button('private@example.com'), { type: 'Edit', name: 'secret', aid: 'password', secret: true, enabled: true }]] })
await scoped.controller.run({ ...authorized, allowedNamesJson: '["public"]', allowSideEffects: false, inputValue: 'never-send-this' })
assert.equal(JSON.stringify(scoped.requests).includes('private@example.com'), false)
assert.equal(JSON.stringify(scoped.requests).includes('never-send-this'), false)
assert.equal(JSON.stringify(scoped.requests).includes('password'), false)

const exact = fixture({ states: [[button('600519 (A+B)')]] })
await exact.controller.run({ ...authorized, maxSteps: 1 })
assert.equal(exact.calls.find(call => call.action === 'click').name, '600519 (A+B)')
assert.equal(exact.calls.find(call => call.action === 'click').match, undefined)

// ---- 组1：漂移门（观察 → 决策 1~2 s → 动作，这期间界面可能已经换页） ----
// 观察到的矩形/窗口句柄必须当作凭据交给执行器；不符则**在执行动作之前**被拒。
const rected = { type: 'MenuItem', name: '行情', aid: '', enabled: true, expanded: 'Collapsed', patterns: ['ExpandCollapse'], rect: { x: 10, y: 20, w: 60, h: 24 } }
const drifted = fixture({ states: [[rected]], windowHandle: 777, result: { ok: false, drift: true, movedBy: { dx: 500, dy: 300 }, expectedRect: { x: 10, y: 20, w: 60, h: 24 }, rect: { x: 510, y: 320, w: 60, h: 24 } } })
const driftResult = await drifted.controller.run({ ...authorized, maxSteps: 1 })
assert.equal(driftResult.stopped, 'target_drifted')
assert.equal(drifted.executed.length, 0, '判定漂移时一个动作都不能执行')
assert.deepEqual(driftResult.drift.movedBy, { dx: 500, dy: 300 })
{
  const act = drifted.calls.find(call => call.action === 'pattern')
  assert.deepEqual(act.expectedRect, { x: 10, y: 20, w: 60, h: 24 }, '观察到的矩形必须作为凭据传下去')
  assert.equal(act.expectedWindowHandle, 777, '观察到的窗口句柄必须传下去')
}

// ---- 组1：没有 expectSelected 时，触顶不再白跑一次观察 ----
// （给了 expectSelected 时那次观察是**终点校验**，多跑是应该的 —— 见上面的 multi 用例 state=4）
const noVerify = fixture({ states: [[button('a')], [button('a')]], answers: ['control_0_act'] })
const noVerifyResult = await noVerify.controller.run({ ...authorized, maxSteps: 1, expectSelected: undefined })
assert.equal(noVerifyResult.stopped, 'step_limit')
assert.equal(noVerify.calls.filter(call => call.action === 'state').length, 1, 'maxSteps=1 且没给终点 ⇒ 只观察 1 次')

// ---- 组1：完整性事实必须回报（没读到 ≠ 没有） ----
const honest = fixture({ states: [[button('a'), { type: 'Custom', name: '', aid: '', enabled: true }, { type: 'Custom', name: '', aid: '', enabled: true }]], skipped: 3 })
const honestResult = await honest.controller.run({ ...authorized, maxSteps: 1, expectSelected: undefined })
assert.equal(honestResult.observation.unlocatable, 2, '既无 name 也无 aid 的控件数必须如实回报')
assert.equal(honestResult.observation.skipped, 3)

// ---- 组1：调用方已点名进程+窗口时跳过 status（省约 0.9 s） ----
const addressed = fixture()
await addressed.controller.run({ ...authorized, procId: 111, winHandle: 222, expectSelected: undefined, maxSteps: 1 })
assert.equal(addressed.statusCalls(), 0, 'procId+winHandle 都给全时不该再问 status')
const unaddressed = fixture()
await unaddressed.controller.run({ ...authorized, maxSteps: 1 })
assert.equal(unaddressed.statusCalls(), 1, '没点名时 status 是"目标是誰/还在不在"的唯一来源，必须问')

console.log('PASS: Jev UI multistep navigation, exact selectors, action scope, observation verification and failure stops')
