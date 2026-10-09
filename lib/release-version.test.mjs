import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))
const version = read('package.json').version
for (const file of ['mcp/package.json', '.claude-plugin/plugin.json', ...readdirSync(join(root, 'plugins')).map((name) => 'plugins/' + name + '/package.json')]) {
  if (!existsSync(join(root, file))) continue
  const pkg = read(file)
  if (pkg.version) assert.equal(pkg.version, version, file)
}
assert.equal(read('mcp/package-lock.json').version, version)
assert.equal(read('mcp/package-lock.json').packages[''].version, version)
assert.equal(read('.claude-plugin/marketplace.json').plugins.find((plugin) => plugin.name === 'dsh-agent-toolchain').version, version)
assert.ok(readFileSync(join(root, 'mcp', 'server.mjs'), 'utf8').includes("version: '" + version + "'"))
console.log('PASS release versions: package manifests, lockfile, marketplace and MCP identity agree')
