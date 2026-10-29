import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createExperienceLibrary } from './experience.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-harness-experience-'))
const scope = { project: 'demo', taskType: 'offline-script' }
const versions = { executor: 'fixture-1', model: 'model-1', tools: 'tools-1', evaluator: 'claims-1' }
const trial = (id, fingerprint, { component = 'tool-guidance', components = [component], attribution = 'helped', candidateId = 'candidate-1', runId = `run-${id}`, verifiedVerdict = 'pass', evidenceLevel = 'observed', state = 'completed', completeness = 'complete' } = {}) => {
  const dir = path.join(root, 'trials', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ trialId: id, scope, versions, taskFingerprint: fingerprint, contractFingerprint: 'claims-1' }))
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    trialId: id, scope, versions, taskFingerprint: fingerprint, contractFingerprint: 'claims-1',
    candidates: [{ candidateId, component, components, files: Object.fromEntries(components.map(name => [name + '.txt', 'safe'])), fingerprint: candidateId }],
    runs: [{ runId, state, completeness, verification: { verifiedVerdict, claims: [{ id: 'required', check: 'gate', status: 'pass', evidenceLevel }] } }],
    decision: { action: 'adopt', candidateId, runId },
    reflection: { cue: 'when output is truncated', lesson: 'use bounded summaries', component, attribution, evidenceRefs: [runId], confidence: 0.8 },
  }))
}

trial('t1', 'task-1')
trial('t2', 'task-2')
trial('t3', 'task-3', { components: ['tool-guidance', 'prompt'], component: 'tool-guidance' })
trial('t4', 'task-4', { evidenceLevel: 'selfReported' })
const library = createExperienceLibrary({ directory: root, memoryDirectory: path.join(root, 'memory') })
const proposed = library.propose({ trialId: 't1', scope, versions, reflection: { cue: 'when output is truncated', lesson: 'use bounded summaries', component: 'tool-guidance', attribution: 'helped', evidenceRefs: ['run-t1'], confidence: 0.8 } })
assert.equal(proposed.status, 'proposed')
assert.equal(library.query({ scope, versions }).items.length, 0)
assert.equal(library.query({ scope, versions, states: ['proposed'] }).items.length, 1)
assert.throws(() => library.propose({ trialId: 't1', scope, versions, reflection: { cue: 'token=sk-abcdefghijklmnopqrstuvwxyz', lesson: 'bad', component: 'x', attribution: 'helped', evidenceRefs: ['run-t1'] } }), /sensitive/)
assert.throws(() => library.transition({ id: proposed.id, action: 'validate', supportTrialIds: ['t1'] }), /independent support/)
const validated = library.transition({ id: proposed.id, action: 'validate', supportTrialIds: ['t1', 't2'] })
assert.equal(validated.status, 'validated')
assert.equal(library.query({ scope, versions, states: ['validated'] }).items.length, 1)
const exportRoot = path.join(root, 'export')
const exported = library.exportFiles({ id: proposed.id, targetDirectory: exportRoot })
assert.equal(exported.ok, true)
assert.equal(fs.readFileSync(path.join(exportRoot, 'tool-guidance.txt'), 'utf8'), 'safe')
assert.throws(() => library.exportFiles({ id: proposed.id, targetDirectory: exportRoot }), /empty/)
assert.equal(library.query({ scope: { project: 'other', taskType: scope.taskType }, versions }).items.length, 0)
assert.throws(() => library.propose({ trialId: 't1', scope, versions, reflection: { cue: 'x', lesson: 'x', component: 'x', attribution: 'helped', evidenceRefs: ['run-t1'], confidence: 1.1 } }), /confidence/)
const confounded = library.propose({ trialId: 't3', scope, versions, reflection: { cue: 'x', lesson: 'x', component: 'tool-guidance', attribution: 'helped', evidenceRefs: ['run-t3'] } })
assert.throws(() => library.transition({ id: confounded.id, action: 'validate', supportTrialIds: ['t3', 't2'] }), /complete adopted machine evidence|confounded|multi-component/)
const unsupported = library.propose({ trialId: 't4', scope, versions, reflection: { cue: 'x', lesson: 'x', component: 'tool-guidance', attribution: 'helped', evidenceRefs: ['run-t4'] } })
assert.throws(() => library.transition({ id: unsupported.id, action: 'validate', supportTrialIds: ['t4', 't2'] }), /evidence/)
assert.throws(() => library.transition({ id: proposed.id, action: 'validate', supportTrialIds: ['t1', 't2'] }), /only proposed/)
const retired = library.transition({ id: proposed.id, action: 'retire', reason: 'version changed' })
assert.equal(retired.status, 'retired')
assert.equal(library.query({ scope, versions, states: ['validated'] }).items.length, 0)
console.log('harness experience tests passed')
