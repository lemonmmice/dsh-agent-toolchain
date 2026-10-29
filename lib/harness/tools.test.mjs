import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHarnessTools } from './tools.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-harness-tools-'))
const configPath = join(root, 'trial.json')
writeFileSync(configPath, JSON.stringify({ trialId: 'trial-tools', scope: { project: 'test', taskType: 'offline' } }))
mkdirSync(join(root, 'trials', 'trial-tools'), { recursive: true })
writeFileSync(join(root, 'trials', 'trial-tools', 'manifest.json'), JSON.stringify({ trialId: 'trial-tools', state: 'completed', phase: 'decision' }))
try {
  let seen
  const tools = makeHarnessTools({
    directory: root,
    executorFactory: async value => ({ kind: 'executor', value }),
    improverFactory: async value => ({ kind: 'improver', value }),
    runTrial: async (config, deps) => { seen = { config, deps }; return { ok: true, trialId: config.trialId } },
    libraryFactory: async () => ({ query: value => ({ value }), get: id => ({ id }), transition: value => ({ value }) }),
  })
  assert.deepEqual(await tools.trial({ action: 'status', trialId: 'trial-tools' }), { ok: true, trialId: 'trial-tools', state: 'completed', phase: 'decision', updatedAt: null, resultPath: null })
  assert.deepEqual(await tools.trial({ action: 'run', configPath: resolve(configPath) }), { ok: true, trialId: 'trial-tools' })
  assert.equal(seen.config.directory, root)
  assert.equal(seen.deps.executor.kind, 'executor')
  await assert.rejects(tools.trial({ action: 'status', trialId: '../escape' }), /trialId/)
  assert.deepEqual(await tools.experience({ action: 'query', scopeJson: '{"project":"p"}' }), { value: { scope: { project: 'p' }, versions: undefined, states: undefined, limit: undefined } })
  await assert.rejects(tools.trial({ action: 'status', trialId: 'missing-trial' }), error => error.code === 'HARNESS_NOT_FOUND')

  let injected
  const proposedTools = makeHarnessTools({
    directory: root,
    executorFactory: async value => ({ value }),
    improverFactory: async value => ({ value }),
    runTrial: async config => { injected = config; return { ok: true, trialId: config.trialId } },
    libraryFactory: async () => ({ query: () => ({ items: [{ id: 'proposed-1', status: 'proposed' }] }), get: () => null, transition: value => value }),
  })
  writeFileSync(configPath, JSON.stringify({ trialId: 'trial-proposed', scope: { project: 'test', taskType: 'offline' }, executor: { __hostShell: true } }))
  await proposedTools.trial({ action: 'run', configPath: resolve(configPath) })
  assert.deepEqual(injected.experiences, [])
  assert.ok(injected.warnings.some(value => /host-only/.test(value)))
  writeFileSync(configPath, JSON.stringify({ trialId: 'trial-proposed', scope: { project: 'test', taskType: 'offline' }, includeProposed: true }))
  await proposedTools.trial({ action: 'run', configPath: resolve(configPath) })
  assert.equal(injected.experiences[0].unvalidated, true)
  await assert.rejects(proposedTools.experience({ action: 'get', id: 'missing-experience' }), error => error.code === 'HARNESS_NOT_FOUND')
  console.log('PASS harness tools: shared DSH/MCP handlers validate safe ids, local config and persisted status')
} finally { rmSync(root, { recursive: true, force: true }) }
