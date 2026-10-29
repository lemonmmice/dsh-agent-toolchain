import assert from 'node:assert/strict'
import { runEvaluation } from './evaluate.mjs'

const calls = []
const report = await runEvaluation({
  tasks: [{ id: 'train' }], heldOut: [{ id: 'holdout' }], repetitions: 2,
  budget: { maxTokens: 100 },
  runTrial: async input => { calls.push(input); return { state: 'completed', completeness: 'complete', decision: { action: input.arm === 'harness2' ? 'candidate' : 'baseline' }, usage: { cost: input.arm === 'harness2' ? 2 : null } } },
})
assert.equal(calls.length, 8)
assert.equal(report.summary.fixed.runs, 4)
assert.equal(report.summary.harness2.accepted, 4)
assert.equal(report.summary.fixed.cost, null)
assert.equal(report.summary.harness2.cost, 8)
assert.equal(report.budget.maxTokens, 100)
assert.equal(report.runs.filter(run => run.heldOut).length, 4)
console.log('PASS harness2 evaluation: equal arms, repetitions, holdout and unknown cost')

