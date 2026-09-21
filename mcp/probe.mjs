import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const client = new Client({ name: 'dsh-probe', version: '1' })
let connected = false
try {
  const requestedTool = process.argv[2]
  if (!requestedTool) throw new Error('usage: node mcp/probe.mjs <tool> [json-args] | --seq \'[["tool",{}]]\'')
  const calls = requestedTool === '--seq'
    ? JSON.parse(process.argv[3] || '[]')
    : [[requestedTool, JSON.parse(process.argv[3] || '{}')]]
  if (!Array.isArray(calls) || calls.length === 0 || calls.some((call) => !Array.isArray(call) || typeof call[0] !== 'string' || !call[1] || typeof call[1] !== 'object' || Array.isArray(call[1]))) {
    throw new Error('Expected a non-empty sequence of [toolName, argumentsObject] pairs')
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], env: { ...process.env }, stderr: 'inherit' })
  await client.connect(transport)
  connected = true
  for (const [index, [name, argumentsObject]] of calls.entries()) {
    const started = performance.now()
    const result = await client.callTool({ name, arguments: argumentsObject }, undefined, {
      timeout: 240000,
      maxTotalTimeout: 240000,
      onprogress: (progress) => process.stderr.write(`[${name}] ${progress.message || 'running'}\n`),
    })
    console.log(`=== [${index + 1}/${calls.length}] ${name} (${Math.round(performance.now() - started)} ms) ===`)
    console.log('isError:', result.isError === true)
    for (const block of result.content || []) {
      if (block.type !== 'text') continue
      let payload
      try { payload = JSON.parse(block.text) } catch { payload = null }
      if (payload && Array.isArray(payload.lines)) {
        const count = payload.lines.length
        payload.lines = payload.lines.slice(0, 3)
        payload.linesTruncatedForDisplay = count > 3
      }
      console.log(payload === null ? block.text : JSON.stringify(payload, null, 1))
    }
    if (result.isError === true) {
      process.exitCode = 1
      break
    }
  }
} catch (error) {
  console.error('PROBE FAIL: ' + error.message)
  process.exitCode = 1
} finally {
  if (connected) await client.close()
}
