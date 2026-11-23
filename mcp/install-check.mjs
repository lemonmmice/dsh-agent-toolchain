import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const client = new Client({ name: 'standalone-install-check', version: '1' })
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./standalone.mjs', import.meta.url))],
  env: { ...process.env, DSH_ENV_FILE: process.argv[2] }, stderr: 'inherit',
})
try {
  await client.connect(transport)
  const names = []
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    names.push(...page.tools.map(tool => tool.name))
    cursor = page.nextCursor
  } while (cursor)
  for (const name of ['toolchain_status', 'build_run', 'ui_observe', 'perf_breakdown', 'capture_start', 'capture_rules']) {
    if (!names.includes(name)) throw new Error('MCP tool missing: ' + name)
  }
  const result = await client.callTool({ name: 'toolchain_status', arguments: {} }, undefined, { timeout: 60000 })
  if (result.isError) throw new Error('MCP toolchain_status failed')
  const payload = JSON.parse(result.content.find(block => block.type === 'text').text)
  if (!Array.isArray(payload.items)) throw new Error('Invalid toolchain_status response')
  const report = { ok: true, toolCount: names.length, status: payload }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n')
  console.log('MCP handshake and tool call passed: ' + names.length + ' tools')
  for (const item of payload.items.filter(item => item.ok !== true)) console.log('  Not ready: ' + item.label)
} finally {
  await client.close()
  await transport.close()
}
