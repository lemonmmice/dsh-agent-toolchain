import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const client = new Client({ name: 'native-tool-export', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'mcp/server.mjs')],
  env: { ...process.env, DSH_ENV_FILE: 'none', DSH_TOOL_PROFILE: '', DSH_RUNTIME_BRIDGE: '1' }, stderr: 'inherit' })
try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const content = JSON.stringify(tools, null, 2) + '\n'
  const target = join(root, 'native/toolchain/tools.json')
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) throw new Error('Native tool manifest is stale; run node scripts/export-native-tools.mjs')
  } else writeFileSync(target, content)
  console.log('Native tool manifest: ' + tools.length + ' tools')
} finally { await client.close() }
