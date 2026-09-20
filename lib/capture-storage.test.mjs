import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CaptureStorage, shardName } from './capture-storage.mjs'
import { trimToCaps } from '../plugins/dsh-api-visualizer/lib/compaction.mjs'
import { sortNewestFirst } from './capture-store.mjs'

const directory = mkdtempSync(join(tmpdir(), 'capture-native-'))
const row = (id, ts, extra = {}) => ({ id, ts, method: 'GET', url: 'https://example.invalid/' + encodeURIComponent(id.replace(/[\uD800-\uDFFF]/g, '_')), ...extra })
const oldTs = new Date(2026, 0, 1, 12).getTime()
const newTs = new Date(2026, 0, 2, 12).getTime()
const children = []
try {
  const emptyDirectory = join(directory, 'not-created')
  const empty = new CaptureStorage(emptyDirectory)
  assert.deepEqual(empty.readAll(), [])
  assert.equal(readdirSync(directory).length, 0, 'empty read creates no directory or lock')

  // Legacy malformed lines, last-ID-wins semantics, canonical bytes and UTF-16 IDs.
  const legacy = join(directory, 'records.jsonl')
  writeFileSync(legacy, '\uFEFF' + JSON.stringify(row('dup', oldTs, { note: 'legacy' })) + '\nnot json\n' +
    '{ "id": "hand-edited", "ts": 1e3, "method": "GET", "url": "/x", "0": "value" }\n', 'utf8')
  const a = new CaptureStorage(directory), b = new CaptureStorage(directory)
  assert.equal(a.readAll().length, 2)
  assert.equal(a.stats().retainedBytes, a.readAll().reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)) + 1, 0))
  a.append([row('dup', newTs, { note: 'newer shard' }), row('new-day', newTs + 1)])
  assert.equal(b.readAll().find(r => r.id === 'dup').note, 'newer shard')
  b.append([row('dup', oldTs + 1, { note: 'older shard must not win' }), row('backdated', oldTs + 2)])
  assert.equal(a.readAll().find(r => r.id === 'dup').note, 'newer shard')
  assert.deepEqual(a.readAll(), new CaptureStorage(directory).readAll(), 'cached order matches a cold cross-day read')

  const edge = [row('\ud800', 0, { resBody: '\ud800😀中文' }), row('😀', -0), row('\ue000', 0)]
  a.append(edge)
  for (const r of edge) assert.deepEqual(a.readAll().find(x => x.id === r.id), JSON.parse(JSON.stringify(r)))
  for (const maxRecords of [0, 1, 3, 3.2, NaN, 20000]) {
    for (const maxBytes of [0, -1, NaN, Infinity, 100, 500, 4000]) {
      const expect = trimToCaps(sortNewestFirst(a.readAll()), { maxRecords, maxBytes })
      const got = a.plan(maxRecords, maxBytes)
      if (!expect.dropped) assert.equal(got, null)
      else assert.deepEqual(got, expect, 'native retention matches JS reference exactly')
    }
  }

  // Deterministic stale read/modify/write: never silently overwrite b's append.
  const snapshot = a.readAll().map(r => ({ ...r, tag: 'edit' }))
  b.append([row('concurrent', newTs + 10)])
  assert.throws(() => a.replace(snapshot), /CAPTURE_STORE_CHANGED/)
  assert.ok(a.readAll().some(r => r.id === 'concurrent'))

  // In-place external edits and a truncated trailing JSON line are detected.
  const shard = join(directory, shardName(newTs))
  const before = readFileSync(shard, 'utf8')
  writeFileSync(shard, before.replace('newer shard', 'other value') + '{"incomplete":', 'utf8')
  assert.equal(a.readAll().find(r => r.id === 'dup').note, 'other value')
  a.append([row('after-partial', newTs + 20)])
  assert.ok(new CaptureStorage(directory).readAll().some(r => r.id === 'after-partial'))

  // Independent Node processes write through the same native lock. JSONL must
  // remain parseable and every acknowledged unique record must survive.
  const script = `import { CaptureStorage } from ${JSON.stringify(new URL('./capture-storage.mjs', import.meta.url).href)};
const s = new CaptureStorage(process.argv[1]);
for (let i = 0; i < 30; i++) s.append([{id:process.argv[2]+'-'+i,ts:${newTs + 100}+i,method:'GET',url:'https://example.invalid/concurrent'}]);`
  for (let i = 0; i < 3; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory, 'writer' + i], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.resume()
    children.push({ child, result: once(child, 'exit', { signal: AbortSignal.timeout(30000) }), stderr: () => stderr })
  }
  for (const c of children) assert.equal((await c.result)[0], 0, c.stderr())
  const all = a.readAll()
  for (let w = 0; w < 3; w++) assert.equal(all.filter(r => r.id.startsWith('writer' + w + '-')).length, 30)
  assert.ok(a.stats().physicalBytes >= a.stats().retainedBytes)
  const latest = a.plan(20, 1000000)
  a.replace([...latest.keep].reverse())
  assert.equal(b.readAll().length, 20)
  assert.equal(statSync(join(directory, '.capture-store.lock')).size, 0)
  // Deployment copies both the shared JS adapter and the plugin-local addon.
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const source = join(directory, 'source'), profile = join(directory, 'profile with spaces')
  for (const name of ['scripts', 'lib', 'plugins/dsh-api-visualizer/lib']) mkdirSync(join(source, name), { recursive: true })
  mkdirSync(profile)
  cpSync(join(repository, 'scripts/deploy-plugins.mjs'), join(source, 'scripts/deploy-plugins.mjs'))
  for (const name of ['capture-store.mjs', 'capture-storage.mjs', 'env-fallback.mjs']) cpSync(join(repository, 'lib', name), join(source, 'lib', name))
  cpSync(join(repository, 'plugins/dsh-api-visualizer/lib/compaction.mjs'), join(source, 'plugins/dsh-api-visualizer/lib/compaction.mjs'))
  const deploy = () => spawnSync(process.execPath, [join(source, 'scripts/deploy-plugins.mjs'), '--profile', profile, '--only', 'dsh-api-visualizer'], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  })
  assert.equal(deploy().status, 2, 'missing addon stops deployment')
  assert.equal(existsSync(join(profile, 'plugins')), false)
  cpSync(join(repository, 'plugins/dsh-api-visualizer/bin'), join(source, 'plugins/dsh-api-visualizer/bin'), { recursive: true })
  const deployed = deploy()
  assert.equal(deployed.status, 0, deployed.stderr)
  const probe = `import{pathToFileURL}from'node:url';const s=await import(pathToFileURL(process.argv[1]));s.appendRecords([{id:'deployed',method:'GET',url:'https://example.invalid'}]);if(s.queryPage().total!==1)process.exit(1)`
  const queried = spawnSync(process.execPath, ['--input-type=module', '-e', probe, join(profile, 'lib/capture-store.mjs')], {
    cwd: profile, encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, DSH_CAPTURE_STORE_NATIVE: '', DSH_API_CAPTURE_STORE: join(directory, 'deployed-store'), DSH_NO_ENV_FALLBACK: '1' },
  })
  assert.equal(queried.status, 0, queried.stderr)
  console.log('PASS capture native storage: legacy/Unicode parity, cross-day IDs, external edits, stale-write rejection, multi-process append, retention, deployment')
} finally {
  for (const { child } of children) if (child.exitCode === null) child.kill()
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Unexpected test cleanup path')
  rmSync(directory, { recursive: true, force: true })
}
