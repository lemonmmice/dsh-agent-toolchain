import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KvMemory } from '../lib/kv.mjs'

if (process.argv[2] === 'writer') {
  const store = new KvMemory(process.argv[3])
  try { for (let index = 0; index < 50; index++) store.save(process.argv[4] + '-' + index, '并发值', 'fixture') }
  finally { store.close() }
} else {
  const directory = mkdtempSync(join(tmpdir(), 'kv-sqlite-'))
  const store = new KvMemory(directory)
  let other
  try {
    store.save('first', { nested: '中文' }, 'scope', { kind: 'debug', expiresAt: new Date(0).toISOString() })
    const original = readFileSync(store.file, 'utf8')
    assert.equal(store.migrate().dryRun, true)
    assert.equal(existsSync(join(directory, 'kv.sqlite')), false)
    const result = store.migrate({ confirm: true })
    assert.equal(result.migrated, true)
    assert.equal(readFileSync(result.backup, 'utf8'), original)
    assert.deepEqual(store.get('first', 'scope').value, { nested: '中文' })
    assert.equal(store.stats().expired, 1)
    store.save('second', 'point-write')
    unlinkSync(join(directory, 'kv-sqlite-v1.json'))
    assert.equal(readFileSync(store.file, 'utf8'), original, 'SQLite point writes leave the legacy snapshot unchanged')
    other = new KvMemory(directory)
    assert.equal(other.get('second').value, 'point-write')
    assert.equal(other.forget('second').deleted, 1)
    assert.equal(store.get('second'), null)
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'writer', directory, String(index)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let error = ''
      child.stderr.on('data', data => { error += data })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(error)))
    })))
    assert.equal(store.all('fixture').length, 200)
    assert.equal(store.migrate({ confirm: true }).alreadyMigrated, true)
    writeFileSync(store.file, original + JSON.stringify({ key: 'legacy', scope: 'global', value: 'late old writer' }) + '\n')
    assert.throws(() => store.get('first', 'scope'), error => error.code === 'KV_LEGACY_CHANGED')
    assert.throws(() => store.save('unsafe', 'value'), error => error.writesApplied === false)
    console.log('PASS SQLite KV: reversible migration, indexed point operations, expiry aggregates, four writers, legacy-writer refusal')
  } finally { other?.close(); store.close(); rmSync(directory, { recursive: true, force: true }) }
}
