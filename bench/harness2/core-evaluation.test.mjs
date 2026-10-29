import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHarnessTrial } from '../../lib/harness/core.mjs'
import { runEvaluation } from './evaluate.mjs'

const root = mkdtempSync(join(tmpdir(), 'harness2-core-evaluation-'))
const tasks = [{ id: 'train-improvable', taskType: 'fixture', prompt: 'make the fixture pass', baseHarness: { files: { 'result.txt': 'bad' } }, candidate: { files: { 'result.txt': 'good' } } }]
const heldOut = [{ id: 'heldout-improvable', taskType: 'fixture', prompt: 'make the held-out fixture pass', baseHarness: { files: { 'result.txt': 'bad' } }, candidate: { files: { 'result.txt': 'good' } } }]

function executor() {
  return { async runTask({ workspace }) {
    const value = (await readFile(join(workspace, 'result.txt'), 'utf8')).trim()
    return { state: 'completed', completeness: 'complete', metrics: { score: value === 'good' ? 1 : 0 }, model: { id: 'fixture' }, usage: { inputTokens: 10, outputTokens: 5, cost: null }, trajectory: [{ event: 'fixture' }] }
  } }
}

function improver(task, arm) {
  return { async runStage({ stage, evidence = [] }) {
    if (stage === 'compose') return arm === 'harness2' ? { decision: 'adopt', files: task.candidate.files, components: ['result.txt'], observationRefs: [evidence[0].runId], rationale: `fixture decision based on ${evidence[0].runId}` } : { decision: 'keep_base', observationRefs: [evidence[0].runId], rationale: `retain base based on ${evidence[0].runId}` }
    if (arm === 'harness2' && stage !== 'reflect') return { files: task.candidate.files, components: ['result.txt'], rationale: 'fixture candidate' }
    return stage === 'reflect' ? { noEntry: true } : { keepBase: true }
  } }
}

const runTrial = async ({ task, arm, repetition, heldOut: isHeldOut }) => {
  const trialTask = { id: task.id, type: task.taskType, prompt: task.prompt, claims: [{ id: 'result', statement: 'fixture passes', kind: 'gate', cmd: `node -e "const fs=require('fs');process.exit(fs.readFileSync('result.txt','utf8').trim()==='good'?0:1)"` }], budget: { timeoutMs: 5000 } }
  return runHarnessTrial({ directory: root, trialId: `${task.id}-${arm}-${repetition}-${isHeldOut ? 'holdout' : 'train'}`, scope: { project: 'fixture', taskType: task.taskType }, task: trialTask, baseHarness: task.baseHarness, comparison: { field: 'score', direction: 'higher' }, executor: { kind: 'fixture' }, improver: { kind: 'fixture' } }, { executor: executor(), improver: improver(task, arm) })
}

const report = await runEvaluation({ tasks, heldOut, repetitions: 1, runTrial })
assert.equal(report.summary.fixed.accepted, 0)
assert.equal(report.summary.harness2.accepted, 2)
assert.equal(report.summary.fixed.completionRate, 1)
assert.equal(report.summary.harness2.completionRate, 1)
assert.equal(report.summary.harness2.cost, null)
console.log('PASS harness2 core evaluation: equal fixture budget, train/holdout and unknown cost')
