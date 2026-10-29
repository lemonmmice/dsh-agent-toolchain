import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor, createImprover } from './executor.mjs'

const root = await mkdtemp(join(tmpdir(), 'dsh-harness-executor-'))
try {
  const executor = createExecutor({
    commandBuilder: () => ({ command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('result.txt','ok')"] }),
  })
  const completed = await executor.runTask({ workspace: root, task: { outputs: ['result.txt'] }, budget: { timeoutMs: 5000 } })
  assert.equal(completed.state, 'completed')
  assert.equal(completed.completeness, 'complete')
  assert.equal(completed.artifacts.length, 1)
  assert.equal(completed.artifacts[0].path, 'result.txt')
  assert.equal(completed.artifacts[0].sha256.length, 64)
  assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'ok')

  const controller = new AbortController()
  const pending = createExecutor({
    commandBuilder: () => ({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }),
  }).runTask({ workspace: root, task: {}, budget: { timeoutMs: 10000 }, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  const cancelled = await pending
  assert.equal(cancelled.state, 'unknown')
  assert.equal(cancelled.completeness, 'incomplete')

  const improver = createImprover({ runner: async input => ({
    files: { 'overlay.md': `stage=${input.stage}` }, rationale: 'bounded test proposal', evidenceRefs: ['run-1'], usage: { inputTokens: 2, outputTokens: 3 },
  }) })
  const stage = await improver.runStage({ stage: 'general', task: { id: 'fixture' }, workspace: root })
  assert.deepEqual(stage.files, { 'overlay.md': 'stage=general' })
  assert.deepEqual(stage.usage, { inputTokens: 2, outputTokens: 3, cost: null })
  assert.deepEqual(stage.evidenceRefs, ['run-1'])
  const ignoredShell = createExecutor({ shell: true, commandBuilder: () => ({ command: 'definitely-no-harness-shell-command', args: ['ok'] }) })
  const shellResult = await ignoredShell.runTask({ workspace: root, task: {}, budget: { timeoutMs: 5000 } })
  assert.notEqual(shellResult.state, 'completed')
  const stageCommand = createImprover({ commandBuilder: () => ({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({files:{"stage.txt":"ok"},rationale:"structured",evidenceRefs:["run-1"]}))'] }) })
  const parsedStage = await stageCommand.runStage({ stage: 'general', task: { id: 'fixture' }, workspace: root })
  assert.equal(parsedStage.files['stage.txt'], 'ok')
  const protocol = createExecutor({ protocol: 'codex', commandBuilder: () => ({ command: process.execPath, args: ['-e', "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:4},model:'fixture-model'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}))"] }) })
  const observed = await protocol.runTask({ workspace: root, task: { id: 'protocol' } })
  assert.deepEqual(observed.usage, { inputTokens: 3, outputTokens: 4, cost: null })
  assert.equal(observed.model.id, 'fixture-model')
  assert.equal(observed.trajectory[0].summary, 'ok')
  console.log('PASS harness executor: isolated command, artifact hash, unknown cancellation, structured improver')
} finally {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break } catch (error) {
      if (error.code !== 'EBUSY' || attempt === 7) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}

