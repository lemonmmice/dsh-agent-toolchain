import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, utimesSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { sourceManifestIdentity } from './source-manifest.mjs'

const directory = mkdtempSync(join(tmpdir(), 'source-manifest-'))
const root = join(directory, 'repo'), cacheDir = join(directory, 'cache')
mkdirSync(root)
execFileSync('git', ['init', '-q', root], { windowsHide: true })
const file = join(root, 'source.cs')
const options = { cacheDir }
try {
  writeFileSync(file, 'class First {}')
  const first = await sourceManifestIdentity(root, options)
  assert.equal(first.available, true)
  assert.equal(first.filesHashed, 1)
  const second = await sourceManifestIdentity(root, options)
  assert.equal(second.filesHashed, 0)
  assert.equal(second.bytesRead, 0)
  assert.equal(second.digest, first.digest)
  const stamp = statSync(file)
  writeFileSync(file, 'class Other {}')
  utimesSync(file, stamp.atime, stamp.mtime)
  const changed = await sourceManifestIdentity(root, options)
  assert.equal(changed.filesHashed, 1)
  assert.notEqual(changed.digest, first.digest)
  assert.equal((await sourceManifestIdentity(root, { ...options, forceFull: true })).digest, changed.digest)
  renameSync(file, join(root, 'renamed.cs'))
  assert.notEqual((await sourceManifestIdentity(root, options)).digest, changed.digest)
  rmSync(join(root, 'renamed.cs'))
  assert.equal((await sourceManifestIdentity(root, options)).fileCount, 0)
  writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]), '{broken')
  writeFileSync(file, 'restored')
  assert.equal((await sourceManifestIdentity(root, options)).filesHashed, 1)
  const controller = new AbortController()
  controller.abort()
  assert.equal((await sourceManifestIdentity(root, { ...options, signal: controller.signal })).available, false)
  console.log('PASS source manifest: persisted reuse, same-size restored-mtime change, full-hash parity, rename/delete, corrupt cache and cancellation')
} finally { rmSync(directory, { recursive: true, force: true }) }
