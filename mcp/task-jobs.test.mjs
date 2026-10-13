import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TASK_TOOLS, TASK_PARAMETERS } from '../lib/task-tools.mjs'

const directory = mkdtempSync(join(tmpdir(), 'mcp-jobs-'))
const source = join(directory, 'source')
mkdirSync(source)
writeFileSync(join(source, 'fixture.txt'), 'local fixture for background indexing')
const client = new Client({ name: 'task-jobs-test', version: '1' })
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
Object.assign(env, { DSH_TEST: '1', DSH_NO_ENV_FALLBACK: '1', DSH_HOME: directory, MINIMAX_CN_API_KEY: '', DSH_MEMORY_DIR: join(directory, 'memory'), DSH_TASK_DIR: join(directory, 'tasks'), DSH_FAILURE_CORPUS_DIR: join(directory, 'failure') })
const payload = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content.find(block => block.type === 'text').text) }
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, 'server.mjs')], env, stderr: 'pipe' }))
  for (const tool of (await client.listTools()).tools.filter(tool => TASK_TOOLS.has(tool.name))) {
    for (const parameter of TASK_PARAMETERS) assert.ok(tool.inputSchema.properties[parameter.name], tool.name + '.' + parameter.name)
  }
  const args = { path: source, asyncJob: true, requestKey: 'index-once', jobTimeoutMs: 10000, budgetMs: 2000 }
  const accepted = payload(await client.callTool({ name: 'memory_index', arguments: args }))
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.state, 'queued')
  assert.equal(accepted.completeness, 'pending')
  let status
  for (let attempt = 0; attempt < 200; attempt++) {
    status = payload(await client.callTool({ name: 'toolchain_job', arguments: { action: 'status', jobId: accepted.jobId } }))
    if (['done', 'failed', 'unknown', 'cancelled'].includes(status.state)) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(status.state, 'done', JSON.stringify(status))
  const result = payload(await client.callTool({ name: 'toolchain_job', arguments: { action: 'result', jobId: accepted.jobId } }))
  assert.equal(result.resultReady, true)
  assert.equal(payload(JSON.parse(readFileSync(result.result.path, 'utf8'))).indexed, 1)
  const duplicate = payload(await client.callTool({ name: 'memory_index', arguments: args }))
  assert.equal(duplicate.jobId, accepted.jobId)
  assert.equal(duplicate.deduplicated, true)
  assert.equal((await client.callTool({ name: 'memory_index', arguments: { ...args, budgetMs: 3000 } })).isError, true)
  assert.equal(payload(await client.callTool({ name: 'toolchain_job', arguments: { action: 'cancel', jobId: accepted.jobId } })).cancellationApplied, false)
  console.log('PASS MCP tasks: real schema, queued acknowledgement, completed artifact, argument-bound deduplication and terminal cancellation')
} finally { await client.close(); rmSync(directory, { recursive: true, force: true }) }
