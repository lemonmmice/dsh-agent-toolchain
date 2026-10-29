import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHarnessTrial } from './core.mjs'

function fixtureExecutor() {
  return {
    async runTask({ workspace, runId }) {
      const value = readFileSync(join(workspace, 'value.txt'), 'utf8').trim()
      const output = join(workspace, 'result.txt')
      writeFileSync(output, value === 'good' ? 'pass' : 'fail')
      return { state: 'completed', completeness: 'complete', artifacts: [{ path: 'result.txt', sha256: 'fixture' }], model: { id: 'fixture' }, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, metrics: { score: value === 'good' ? 1 : 0 }, trajectory: [{ stage: 'task', summary: runId }] }
    },
  }
}

function fixtureImprover() {
  return {
    async runStage({ stage, evidence = [] }) {
      if (stage === 'general' || stage === 'domain') return { files: { 'value.txt': 'good' }, rationale: stage + ' candidate' }
      if (stage === 'compose') return { decision: 'adopt', files: { 'value.txt': 'good' }, observationRefs: [evidence[0].runId], rationale: `adopt based on ${evidence[0].runId}` }
      return { noEntry: true }
    },
  }
}

function config(directory, trialId = 'fixture-trial') {
  return { directory, trialId, task: { id: 'fixture', prompt: 'run fixture', claims: [{ id: 'result', statement: 'result passes', kind: 'gate', cmd: `node -e "const fs=require('fs');process.exit(fs.readFileSync('result.txt','utf8').trim()==='pass'?0:1)"` }] }, baseHarness: { files: { 'value.txt': 'bad' } }, executor: { kind: 'fixture' }, improver: { kind: 'fixture' }, comparison: { field: 'score', direction: 'higher' } }
}

test('single-round trial executes base, candidates and composition and adopts improvement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-'))
  const result = await runHarnessTrial(config(directory), { executor: fixtureExecutor(), improver: fixtureImprover() })
  assert.equal(result.status, 'completed')
  assert.equal(result.runs.length, 8)
  assert.equal(result.decision.action, 'adopt')
  assert.equal(result.runs[0].verification.verifiedVerdict, 'fail')
  assert.equal(result.runs[6].verification.verifiedVerdict, 'pass')
  assert.ok(readFileSync(join(directory, 'trials', 'fixture-trial', 'result.json'), 'utf8').includes('adopt'))
})

test('both passing without a frozen metric retain the base result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-'))
  const result = await runHarnessTrial({ ...config(directory, 'no-metric'), comparison: undefined, baseHarness: { files: { 'value.txt': 'good' } } }, { executor: fixtureExecutor(), improver: fixtureImprover() })
  assert.equal(result.decision.action, 'keep_base')
})

test('composer adoption with an empty file map retains the base harness', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-empty-composer-'))
  const emptyComposer = {
    async runStage({ stage, evidence = [] }) {
      if (stage === 'general' || stage === 'domain') return { keepBase: true, rationale: 'no change' }
      if (stage === 'compose') return { decision: 'adopt', files: {}, observationRefs: [evidence[0].runId], rationale: `adopt based on ${evidence[0].runId}` }
      return { noEntry: true }
    },
  }
  const result = await runHarnessTrial({ ...config(directory, 'empty-composer'), baseHarness: { files: { 'value.txt': 'good' } } }, { executor: fixtureExecutor(), improver: emptyComposer })
  assert.equal(result.decision.action, 'keep_base')
  assert.match(result.decision.reason, /did not change|candidate did not change/)
})

test('metric-only noise does not authorize adoption when both verdicts pass', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-metric-noise-'))
  let executions = 0
  const noisyExecutor = {
    async runTask({ workspace }) {
      executions++
      writeFileSync(join(workspace, 'result.txt'), 'pass')
      return { state: 'completed', completeness: 'complete', metrics: { score: executions <= 2 ? 100 : 101 }, model: { id: 'fixture' }, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, trajectory: [{ event: 'task' }] }
    },
  }
  const result = await runHarnessTrial({ ...config(directory, 'metric-noise'), baseHarness: { files: { 'value.txt': 'good' } } }, { executor: noisyExecutor, improver: fixtureImprover() })
  assert.equal(result.decision.action, 'keep_base')
  assert.match(result.decision.reason, /metric-only|both base and candidate passed/)
})

test('missing required claims is rejected before a trial starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-'))
  await assert.rejects(() => runHarnessTrial({ ...config(directory, 'missing'), task: { ...config(directory).task, claims: [] } }, { executor: fixtureExecutor(), improver: fixtureImprover() }), /claims/)
})

test('cancellation yields an unknown or incomplete trial without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-'))
  const controller = new AbortController()
  controller.abort()
  const result = await runHarnessTrial(config(directory, 'cancelled'), { executor: fixtureExecutor(), improver: fixtureImprover(), signal: controller.signal })
  assert.equal(result.status, 'unknown')
  assert.equal(result.decision.action, 'incomplete')
  assert.equal(result.runs.length, 0)
})

test('k=2 parallel produces independent decisions and anonymized selector input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-core-k2-'))
  let selectorInput
  const result = await runHarnessTrial({ ...config(directory, 'k2'), k: 2, mode: 'parallel', maxExecutions: 16 }, { executor: fixtureExecutor(), improver: fixtureImprover(), selector: { async select(input) { selectorInput = input; return { label: 'A' } } } })
  assert.equal(result.k, 2)
  assert.equal(result.rounds.length, 2)
  assert.equal(result.decisions.length, 2)
  assert.deepEqual(result.selector.selected, 'A')
  assert.ok(selectorInput && selectorInput.candidates.every(candidate => !JSON.stringify(candidate).includes('baseHarness')))
})

test('a candidate that writes a declared deliverable is rejected and keeps base (no gaming)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-surface-'))
  const base = config(directory, 'surface-protected')
  base.task.outputs = ['result.txt']
  const gaming = {
    async runStage({ stage, evidence = [] }) {
      if (stage === 'general') return { files: { 'result.txt': 'pass' }, rationale: 'pre-create the graded deliverable' }
      if (stage === 'domain') return { keepBase: true, rationale: 'no change' }
      if (stage === 'compose') return { decision: 'keep_base', files: {}, observationRefs: [evidence[0].runId], rationale: `keep base per ${evidence[0].runId}` }
      return { noEntry: true }
    },
  }
  const result = await runHarnessTrial(base, { executor: fixtureExecutor(), improver: gaming })
  const general = result.candidates.find(candidate => candidate.candidateId === 'general')
  assert.equal(general.keepBase, true)
  assert.equal(general.fellBack, true)
  assert.match(general.rationale, /result\.txt/)
  assert.match(general.rationale, /deliverable|verification target/)
  assert.equal(result.decision.action, 'keep_base')
})

test('editableSurface rejects an off-surface candidate path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-surface-glob-'))
  const base = { ...config(directory, 'surface-glob'), editableSurface: ['value.txt'] }
  const improver = {
    async runStage({ stage, evidence = [] }) {
      if (stage === 'general') return { files: { 'value.txt': 'good' }, rationale: 'on surface' }
      if (stage === 'domain') return { files: { 'skills/leak.md': 'x' }, rationale: 'off surface' }
      if (stage === 'compose') return { decision: 'adopt', files: { 'value.txt': 'good' }, observationRefs: [evidence[0].runId], rationale: `adopt ${evidence[0].runId}` }
      return { noEntry: true }
    },
  }
  const result = await runHarnessTrial(base, { executor: fixtureExecutor(), improver })
  const general = result.candidates.find(candidate => candidate.candidateId === 'general')
  const domain = result.candidates.find(candidate => candidate.candidateId === 'domain')
  assert.equal(domain.fellBack, true)
  assert.equal(domain.keepBase, true)
  assert.match(domain.rationale, /editable harness surface/)
  assert.equal(general.keepBase, false)
  assert.equal(result.decision.action, 'adopt')
})

test('an invalid candidate is retried once with the rejection fed back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-retry-'))
  let generalCalls = 0
  const retrying = {
    async runStage({ stage, rejection, evidence = [] }) {
      if (stage === 'general') {
        generalCalls++
        if (!rejection) return { files: { 'value.txt': 'good' }, components: ['value.txt', 'phantom'], rationale: 'components do not cover files' }
        return { files: { 'value.txt': 'good' }, rationale: 'fixed after rejection' }
      }
      if (stage === 'domain') return { keepBase: true, rationale: 'no change' }
      if (stage === 'compose') return { decision: 'adopt', files: { 'value.txt': 'good' }, observationRefs: [evidence[0].runId], rationale: `adopt ${evidence[0].runId}` }
      return { noEntry: true }
    },
  }
  const result = await runHarnessTrial(config(directory, 'retry'), { executor: fixtureExecutor(), improver: retrying })
  assert.equal(generalCalls, 2)
  const general = result.candidates.find(candidate => candidate.candidateId === 'general')
  assert.equal(general.keepBase, false)
  assert.deepEqual(general.components, ['value.txt'])
  assert.equal(result.decision.action, 'adopt')
})

test('identical general and domain overlays are reported as collapsed diversity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-diversity-'))
  const result = await runHarnessTrial(config(directory, 'diversity'), { executor: fixtureExecutor(), improver: fixtureImprover() })
  assert.equal(result.diversity.nEdited, 2)
  assert.equal(result.diversity.nDistinct, 1)
  assert.equal(result.diversity.meanLineJaccard, 1)
  assert.equal(result.diversity.collapsed, true)
})
