import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, renameSync, unlinkSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { sourceIdentity } from './build-evidence.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-source-evidence-'))
try {
  execFileSync('git', ['init', '-q', directory], { windowsHide: true })
  const names = ['A.cs', 'B.cs', 'Large.bin']
  writeFileSync(join(directory, names[0]), 'class A {}')
  writeFileSync(join(directory, names[1]), 'class B {}')
  writeFileSync(join(directory, names[2]), Buffer.alloc(2 * 1024 * 1024, 65))
  const expected = createHash('sha256')
  for (const name of names) {
    const bytes = readFileSync(join(directory, name))
    expected.update(name + '\0').update('file:' + bytes.length + '\0').update(bytes).update('\0')
  }
  const original = await sourceIdentity(directory)
  assert.equal(original.digest, expected.digest('hex'))
  assert.equal(original.filesHashed, 3)
  assert.equal(original.completeness, 'complete')
  assert.equal((await sourceIdentity(directory, { concurrency: 1 })).digest, original.digest)
  writeFileSync(join(directory, names[0]), 'class Z {}')
  assert.notEqual((await sourceIdentity(directory)).digest, original.digest)
  renameSync(join(directory, names[1]), join(directory, 'C.cs'))
  const renamed = await sourceIdentity(directory)
  unlinkSync(join(directory, 'C.cs'))
  assert.notEqual((await sourceIdentity(directory)).digest, renamed.digest)
  execFileSync('git', ['-C', directory, 'add', 'A.cs'], { windowsHide: true })
  unlinkSync(join(directory, names[0]))
  assert.equal((await sourceIdentity(directory)).available, true)
  try {
    symlinkSync('Large.bin', join(directory, 'link'))
    assert.equal((await sourceIdentity(directory)).available, true)
    unlinkSync(join(directory, 'link'))
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; console.log('SKIP: symlink privilege unavailable') }
  const controller = new AbortController()
  controller.abort()
  assert.equal((await sourceIdentity(directory, { signal: controller.signal })).reason, 'aborted')
  const changing = setInterval(() => writeFileSync(join(directory, 'Large.bin'), Buffer.alloc(2 * 1024 * 1024, 66)), 1)
  const unstable = await sourceIdentity(directory)
  clearInterval(changing)
  assert.equal(unstable.available, false)
  assert.equal(unstable.reason, 'source-changed-while-reading')
  console.log('PASS: source digest compatibility, changes, missing tracked files, links, cancellation and concurrent edits')
} finally { rmSync(directory, { recursive: true, force: true }) }
