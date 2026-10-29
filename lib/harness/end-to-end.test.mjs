import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHarnessTrial } from './core.mjs'
import { createExperienceLibrary } from './experience.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-harness2-e2e-'))
const scope = { project: 'e2e', taskType: 'fixture' }
const versions = { executor: 'fixture-1', model: 'fixture-model', tools: 'fixture-tools', evaluator: 'fixture-evaluator' }

function executor() {
  return { async runTask({ workspace }) {
    const value = readFileSync(join(workspace, 'value.txt'), 'utf8').trim()
    writeFileSync(join(workspace, 'result.txt'), value === 'good' ? 'pass' : 'fail')
    return { state: 'completed', completeness: 'complete', model: { id: 'fixture-model' }, usage: { inputTokens: 1, outputTokens: 1, cost: null }, metrics: { score: value === 'good' ? 1 : 0 }, artifacts: [{ path: 'result.txt', sha256: 'fixture' }], trajectory: [{ event: 'fixture' }] }
  } }
}

function improver() {
  return { async runStage({ stage, evidence = [] }) {
    if (stage === 'general' || stage === 'domain') return { files: { 'value.txt': 'good' }, components: ['value.txt'], rationale: 'make the fixture pass' }
    if (stage === 'compose') return { decision: 'adopt', files: { 'value.txt': 'good' }, components: ['value.txt'], observationRefs: [evidence[0].runId], rationale: `adopt based on ${evidence[0].runId}` }
    const observed = evidence.find(item => item.verdict === 'pass') || evidence[0]
    return { reflection: { cue: 'failed fixture', lesson: 'apply the value overlay', component: 'value.txt', attribution: 'helped', evidenceRefs: [observed.runId], confidence: 0.8 } }
  } }
}

async function runTrial(trialId, taskId, experience) {
  return runHarnessTrial({
    directory, trialId, scope, versions, probeRepeats: 1,
    task: { id: taskId, prompt: 'make fixture pass', claims: [{ id: 'result', statement: 'fixture passes', kind: 'gate', cmd: `node -e "const fs=require('fs');process.exit(fs.readFileSync('result.txt','utf8').trim()==='pass'?0:1)"` }] },
    baseHarness: { files: { 'value.txt': 'bad' } }, executor: versions.executor, improver: versions.tools, comparison: { field: 'score', direction: 'higher' },
  }, { executor: executor(), improver: improver(), experience })
}

try {
  const library = createExperienceLibrary({ directory })
  const first = await runTrial('e2e-trial-1', 'e2e-task-1', library)
  const second = await runTrial('e2e-trial-2', 'e2e-task-2', library)
  assert.equal(first.decision.action, 'adopt')
  assert.equal(second.decision.action, 'adopt')
  const proposed = library.query({ scope, versions, states: ['proposed'] })
  assert.equal(proposed.items.length, 2)
  assert.equal(library.query({ scope, versions }).items.length, 0)
  const validated = library.transition({ id: proposed.items[0].id, action: 'validate', supportTrialIds: ['e2e-trial-1', 'e2e-trial-2'] })
  assert.equal(validated.status, 'validated')
  assert.equal(library.query({ scope, versions }).items.length, 1)
  const exportDirectory = join(directory, 'exported')
  const exported = library.exportFiles({ id: validated.id, targetDirectory: exportDirectory })
  assert.equal(exported.ok, true)
  assert.equal(readFileSync(join(exportDirectory, 'value.txt'), 'utf8'), 'good')
  console.log('PASS Harness² end-to-end: core trial, proposed experience, independent validation, query and export')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
