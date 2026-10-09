import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeFailureCorpus } from '../../lib/failure-corpus.mjs'

const dir = mkdtempSync(join(tmpdir(), 'corpus-hygiene-'))
try {
  const corpus = makeFailureCorpus({ dir })
  const first = corpus.record({ task: 'fixture', failureClass: 'agent-misjudge', description: 'first', producer: { toolchain: { sha: 'a'.repeat(12), version: '1.0.0' } } })
  corpus.record({ task: 'fixture', failureClass: 'agent-misjudge', description: 'legacy' })
  corpus.record({ task: 'fixture', failureClass: 'tool-error', description: 'other class', producer: { toolchain: { sha: 'a'.repeat(12), version: '1.0.0' } } })
  const second = corpus.record({ task: 'fixture', failureClass: 'agent-misjudge', description: 'second', producer: { toolchain: { sha: 'b'.repeat(12), version: '2.0.0' } } })
  const hash = () => createHash('sha256').update(readFileSync(join(dir, 'records.jsonl'))).digest('hex')
  const run = (...args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../corpus-hygiene.mjs', import.meta.url)), '--dir', dir, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const before = hash()
  run('--misjudge-sha', 'a'.repeat(12))
  assert.equal(hash(), before)
  run('--misjudge-sha', 'a'.repeat(12), '--misjudge-version', '2.0.0', '--apply')
  assert.equal(hash(), before, 'combined filters intersect')
  run('--misjudge-sha', 'a'.repeat(12), '--apply')
  assert.ok(!corpus.query({ failureClass: 'agent-misjudge' }).rows.some((row) => row.id === first.id))
  const applied = hash()
  run('--misjudge-sha', 'a'.repeat(12), '--apply')
  assert.equal(hash(), applied)
  run('--misjudge-version', '2.0.0', '--apply')
  const active = corpus.query({ failureClass: 'agent-misjudge' }).rows
  assert.ok(!active.some((row) => row.id === second.id))
  assert.ok(active.some((row) => row.description === 'legacy'))
  assert.ok(corpus.query({ failureClass: 'tool-error' }).rows.some((row) => row.description === 'other class'))
  console.log('PASS corpus hygiene: read-only dry run, provenance filters, legacy isolation and idempotent apply')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
