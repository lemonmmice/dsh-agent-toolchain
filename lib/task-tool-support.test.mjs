import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TASK_TOOLS, TASK_PARAMETERS } from './task-tools.mjs'
import { wrapTaskDefinition, taskControl, runTaskTool } from './task-tool-support.mjs'

const directory = mkdtempSync(join(tmpdir(), 'task-wrapper-'))
process.env.DSH_TASK_DIR = directory
process.env.DSH_NO_ENV_FALLBACK = '1'
try {
  for (const name of TASK_TOOLS) {
    let called = 0
    const definition = wrapTaskDefinition({ name, parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async args => {
      called++
      assert.equal(args.asyncJob, undefined)
      assert.equal(args.requestKey, undefined)
      assert.equal(args.jobTimeoutMs, undefined)
      return { ok: true }
    } })
    for (const parameter of TASK_PARAMETERS) assert.ok(definition.parameters[parameter.name])
    const options = { asyncJob: true, requestKey: name, jobTimeoutMs: 10000 }
    const accepted = await definition.execute(options)
    assert.equal(accepted.state, 'queued')
    assert.match(definition.output.render(options, accepted)[0].text, /queued/)
    let status
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await taskControl({ action: 'status', jobId: accepted.jobId })
      if (status.state === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(status.state, 'done', name)
    assert.equal((await definition.execute(options)).jobId, accepted.jobId)
    assert.equal(called, 1)
  }
  await assert.rejects(runTaskTool('perf_dump', { asyncJob: true, jobTimeoutMs: -1 }, () => { throw new Error('must not run') }), /jobTimeoutMs/)
  console.log('PASS task middleware: every eligible tool consumes task parameters, strips them from business execution, renders queued truthfully and deduplicates')
} finally { rmSync(directory, { recursive: true, force: true }) }
