import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const profileDir = resolve(process.env.DSH_DEV_PROFILE_DIR || process.argv[2] || '')
const profileRequire = createRequire(join(profileDir, 'package.json'))
const visionRoot = dirname(profileRequire.resolve('dsh-vision-diff/package.json'))
const { encodePng } = await import(pathToFileURL(join(visionRoot, 'lib/png.js')).href)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-recommended-'))
const client = new Client({ name: 'recommended-integration', version: '1' })
const evidence = []
const transport = new StdioClientTransport({ command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], env: { ...process.env, DSH_DEV_PROFILE_DIR: profileDir, DSH_TOOL_PROFILE: 'dev', DSH_OUTPUT_MAX_TOKENS: '0', DSH_VISION_DIFF_DIR: join(temporary, 'evidence'), DSH_FAILURE_CORPUS_DIR: join(temporary, 'failures'), DSH_VERIFY_DIR: join(temporary, 'verification'), DSH_TEST: '1' }, stderr: 'inherit' })
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 })
  assert.equal(result.isError === true, false, JSON.stringify(result))
  const value = JSON.parse(result.content.find(block => block.type === 'text').text)
  assert.equal(value.ok, true, JSON.stringify(value))
  return value
}
try {
  await client.connect(transport)
  const listed = (await client.listTools()).tools
  const names = ['dev_docs_search', 'dev_docs_read', 'dev_vision_diff', 'dev_plugin_check']
  assert.ok(names.every(name => listed.some(tool => tool.name === name)))
  evidence.push({ check: 'tools/list', names })
  const baseline = new Uint8Array(8 * 8 * 4).fill(255)
  const modified = baseline.slice()
  modified[(3 * 8 + 2) * 4] = 0
  const before = join(temporary, 'before.png')
  const after = join(temporary, 'after.png')
  const resized = join(temporary, 'resized.png')
  await writeFile(before, encodePng({ width: 8, height: 8, rgba: baseline }))
  await writeFile(after, encodePng({ width: 8, height: 8, rgba: modified }))
  await writeFile(resized, encodePng({ width: 9, height: 8, rgba: new Uint8Array(9 * 8 * 4).fill(255) }))
  const same = await call('dev_vision_diff', { before, after: before })
  assert.equal(same.pixelChanged, false)
  assert.equal(same.diffPixels, 0)
  const changed = await call('dev_vision_diff', { before, after, label: 'known single-pixel change' })
  assert.equal(changed.pixelChanged, true)
  assert.equal(changed.diffPixels, 1)
  assert.deepEqual(changed.boundingBox, { x: 2, y: 3, w: 1, h: 1 })
  const ignored = await call('dev_vision_diff', { before, after, ignoreJson: JSON.stringify([{ x: 2, y: 3, w: 1, h: 1 }]) })
  assert.equal(ignored.pixelChanged, false)
  assert.equal(ignored.ignoredPixels, 1)
  const dimension = await call('dev_vision_diff', { before, after: resized })
  assert.equal(dimension.dimensionChanged, true)
  assert.equal(dimension.pixelChanged, true)
  assert.match(await readFile(changed.artifacts.html, 'utf8'), /data:image\/png;base64/)
  assert.equal(JSON.parse(await readFile(changed.artifacts.report, 'utf8')).diffPixels, 1)
  const corrupt = join(temporary, 'corrupt.png')
  await writeFile(corrupt, 'not a PNG')
  const invalid = await client.callTool({ name: 'dev_vision_diff', arguments: { before, after: corrupt } })
  assert.equal(invalid.isError, true)
  evidence.push({ check: 'vision', same: false, changedPixels: 1, ignoredPixels: 1, dimensionChanged: true, artifactsVerified: true, corruptRejected: true })
  const fixture = join(temporary, 'manifest')
  await mkdir(fixture)
  const hostFile = profileRequire.resolve('@deepseek-ai/dsh/package.json')
  const hostVersion = JSON.parse(await readFile(hostFile, 'utf8')).version
  const metadata = { name: 'fixture-compatible', version: '1.0.0', engines: { node: '>=22', dsh: hostVersion }, peerDependencies: { '@deepseek-ai/dsh-tools': hostVersion }, dsh: { bundle: { patch: './cordis.patch.yml' } } }
  await writeFile(join(fixture, 'package.json'), JSON.stringify(metadata))
  const accepted = await call('dev_plugin_check', { spec: fixture })
  assert.equal(accepted.verdict, 'compatible-metadata')
  assert.equal(accepted.trialBoot, 'not-run')
  metadata.engines.dsh = '>=999.0.0'
  await writeFile(join(fixture, 'package.json'), JSON.stringify(metadata))
  const blocked = await call('dev_plugin_check', { spec: fixture })
  assert.equal(blocked.verdict, 'blocked')
  metadata.engines.dsh = hostVersion
  metadata.peerDependencies['@deepseek-ai/dsh-tools'] = '0.1.0-rc.6'
  await writeFile(join(fixture, 'package.json'), JSON.stringify(metadata))
  assert.equal((await call('dev_plugin_check', { spec: fixture })).verdict, 'blocked')
  evidence.push({ check: 'precheck', accepted: true, wrongHostRejected: true, wrongPeerRejected: true, noScriptsExecuted: true })
  if (process.argv.includes('--live-docs')) {
    const search = await call('dev_docs_search', { libraryName: 'Prism', query: 'WPF navigation documentation' })
    assert.match(search.text, /\/prismlibrary\/prism-documentation/)
    const docs = await call('dev_docs_read', { libraryId: '/prismlibrary/prism-documentation', query: 'WPF INavigationAware OnNavigatedTo navigation parameters', language: 'C#' })
    assert.match(docs.text, /OnNavigatedTo/)
    assert.match(docs.text, /Source:/)
    evidence.push({ check: 'Context7', search: true, documentRead: true, version72Specific: 'not-established' })
  }
  console.log(JSON.stringify({ passed: true, evidence }, null, 2))
} finally {
  await client.close()
  await rm(temporary, { recursive: true, force: true })
}
