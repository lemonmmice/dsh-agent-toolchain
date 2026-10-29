import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const directory = mkdtempSync(join(tmpdir(), 'dsh-harness2-mcp-errors-'))
const client = new Client({ name: 'harness2-errors', version: '1' })
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, 'server.mjs')],
    env: { ...environment, DSH_TEST: '1', DSH_NO_ENV_FALLBACK: '1', DSH_HARNESS_DIR: join(directory, 'harness'), DSH_FAILURE_CORPUS_DIR: join(directory, 'failure'), DSH_VERIFY_DIR: join(directory, 'verify') },
    stderr: 'pipe',
  }))
  const result = await client.callTool({ name: 'harness_experience', arguments: { action: 'get', id: 'missing-experience' } })
  assert.equal(result.isError, true)
  const payload = JSON.parse(result.content.find(block => block.type === 'text').text)
  assert.equal(payload.errorCode, 'HARNESS_NOT_FOUND')
  console.log('PASS MCP Harness² errors: missing experience isError and errorCode are preserved')
} finally {
  await client.close()
  rmSync(directory, { recursive: true, force: true })
}
