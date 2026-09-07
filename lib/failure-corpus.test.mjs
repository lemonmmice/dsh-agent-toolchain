// lib/failure-corpus.test.mjs — self-test for the failure corpus core.
// Runs on a temp dir; no network, no side effects outside that dir.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFailureCorpus } from './failure-corpus.mjs'

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}
const throws = (fn, msg) => {
  try {
    fn()
    failures++
    console.error('  FAIL - ' + msg + ' (did not throw)')
  } catch {
    console.log('  ok - ' + msg + ' (rejected)')
  }
}

const dir = mkdtempSync(join(tmpdir(), 'fc-test-'))
const c = makeFailureCorpus({ dir, maxBytes: 700 })

const r1 = c.record({
  task: 'push CI workflow file',
  failureClass: 'tool-error',
  description: 'token lacked workflow scope',
  resolution: 'device-flow token',
  tags: ['git', 'auth'],
  costMs: 600000,
  context: { runtime: 'cli' },
})
ok(!!r1.id && !!r1.ts && r1.failureClass === 'tool-error', 'record returns full record with id/ts')

throws(() => c.record({ task: 'x', description: 'y' }), 'missing failureClass')
throws(() => c.record({ task: 'x', failureClass: 'nonsense', description: 'y' }), 'unknown failureClass')
throws(() => c.record({ task: 'x', failureClass: 'flaky', description: 'y', tags: ['a', 1] }), 'non-string tag')
throws(() => c.record({ task: 'x', failureClass: 'flaky', description: 'y', costMs: -1 }), 'negative costMs')

c.record({ task: 'UI render mismatch', failureClass: 'agent-misjudge', description: 'claimed rendered, screenshot showed old page', tags: ['ui'] })
c.record({ task: 'flaky unit test', failureClass: 'flaky', description: 'passed locally, failed in CI', tags: ['ci'] })

ok(c.query({ q: 'workflow' }).total === 1, 'substring query')
ok(c.query({ failureClass: 'flaky' }).total === 1, 'class filter')
ok(c.query({ tag: 'auth' }).total === 1, 'tag filter')
ok(c.query({ fromTs: Date.now() + 1e9 }).total === 0, 'fromTs filter')
ok(c.query({ limit: 1 }).count === 1, 'limit applied')

const s = c.stats()
ok(s.total === 3 && s.byClass['tool-error'] === 1 && s.last7d === 3, 'stats shape')

// rotation: write records until the active file exceeds maxBytes
for (let i = 0; i < 25; i++) {
  c.record({ task: `filler ${i}`, failureClass: 'flaky', description: 'padding record to cross the rotation threshold' })
}
const archives = readdirSync(dir).filter((n) => n.startsWith('records-') && n.endsWith('.jsonl'))
ok(archives.length >= 1, 'rotation produced an archive file')
ok(existsSync(join(dir, 'records.jsonl')), 'active file exists after rotation')
ok(c.stats().total < 28, 'rotated records moved out of the active file')

rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nFAILURE-CORPUS TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nFAILURE-CORPUS TEST PASSED')
