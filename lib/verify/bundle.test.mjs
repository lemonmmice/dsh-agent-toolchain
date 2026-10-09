import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeVerificationReport } from './report.mjs'

const dir = mkdtempSync(join(tmpdir(), 'verify-bundle-'))
try {
  for (const [key, folder] of Object.entries({ DSH_VERIFY_DIR: 'reports', DSH_FAILURE_CORPUS_DIR: 'failures', DSH_BUILD_LOGS_DIR: 'build', DSH_API_CAPTURE_STORE: 'capture', DSH_UI_EVIDENCE_DIR: 'ui' })) {
    process.env[key] = join(dir, folder)
    mkdirSync(process.env[key])
  }
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'fixture.txt'), 'before')
  git(['add', '-A'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'])
  writeFileSync(join(repo, 'fixture.txt'), 'after')
  const log = join(dir, 'build', 'build.log')
  writeFileSync(log, 'build output')
  writeFileSync(join(dir, 'build', 'run-normal.json'), JSON.stringify({ runId: 'normal', ok: true, logPath: log, at: '2026-01-01T00:00:00Z' }))
  writeFileSync(join(dir, 'failures', 'records.jsonl'), JSON.stringify({ context: { runId: 'normal' }, ts: '2026-01-02T00:00:00Z', description: 'raw failure' }) + '\n')
  writeFileSync(join(dir, 'capture', 'records-fixture.jsonl'), JSON.stringify({ runId: 'normal', id: 'capture-one', ts: 1, method: 'GET', url: 'https://example.com', reqBody: 'request payload', resBody: 'response payload' }) + '\n')
  writeFileSync(join(dir, 'ui', 'shot.png'), 'small screenshot fixture')
  writeFileSync(join(dir, 'ui', 'steps.json'), JSON.stringify({ runId: 'normal', at: '2026-01-03T00:00:00Z', screenshots: ['shot.png'] }))
  const make = (runId, claims, context = {}) => makeVerificationReport({ runId, task: 'bundle fixture', claims, context, bundle: true, recordFailures: false })
  const normal = make('normal', [{ statement: 'log exists', kind: 'file', path: log }], { repoRoot: repo })
  assert.equal(normal.verdict, 'pass')
  assert.equal(normal.bundleError, undefined)
  const manifest = JSON.parse(readFileSync(join(normal.bundlePath, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'dsh-evidence-bundle/1')
  assert.match(manifest.head, /^[0-9a-f]{40}$/)
  assert.ok(manifest.producer.toolchain.version)
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(join(normal.bundlePath, artifact.path))
    assert.equal(bytes.length, artifact.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
  }
  const trace = readFileSync(join(normal.bundlePath, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  for (const kind of ['claim', 'build', 'failure', 'capture', 'ui']) assert.ok(trace.some((row) => row.kind === kind), kind)
  const capture = trace.find((row) => row.kind === 'capture').data
  assert.equal(capture.reqBody, undefined)
  assert.match(capture.bodyReferences.request, /#reqBody$/)
  assert.ok(manifest.artifacts.some((row) => row.kind === 'screenshot'))
  const huge = join(dir, 'oversize.log')
  writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1))
  const dump = join(dir, 'fixture.dmp')
  writeFileSync(dump, 'dump fixture')
  const claims = [huge, dump]
  for (let index = 0; index < 6; index++) {
    const file = join(dir, 'large-' + index + '.log')
    writeFileSync(file, Buffer.alloc(9 * 1024 * 1024))
    claims.push(file)
  }
  const large = make('large', claims.map((path) => ({ statement: 'exists', kind: 'file', path })))
  const largeManifest = JSON.parse(readFileSync(join(large.bundlePath, 'manifest.json'), 'utf8'))
  for (const reason of ['file_limit', 'total_limit', 'dump_excluded']) assert.ok(largeManifest.omitted.some((row) => row.reason === reason), reason)
  const files = [...readdirSync(large.bundlePath).filter((name) => name !== 'payloads').map((name) => join(large.bundlePath, name)), ...readdirSync(join(large.bundlePath, 'payloads')).map((name) => join(large.bundlePath, 'payloads', name))]
  assert.ok(files.every((file) => statSync(file).size <= 10 * 1024 * 1024))
  assert.ok(files.reduce((sum, file) => sum + statSync(file).size, 0) <= 50 * 1024 * 1024)
  const noGit = make('no-git', [{ kind: 'file', path: log }], { repoRoot: dir })
  assert.equal(noGit.verdict, 'pass')
  assert.ok(JSON.parse(readFileSync(join(noGit.bundlePath, 'manifest.json'), 'utf8')).omitted.some((row) => row.reason.startsWith('git:')))
  writeFileSync(join(dir, 'reports', 'blocked.bundle'), 'blocking fixture')
  const blocked = make('blocked', [{ kind: 'file', path: log }])
  assert.equal(blocked.verdict, 'pass')
  assert.ok(blocked.bundleError)
  assert.equal(JSON.parse(readFileSync(blocked.reportPath, 'utf8')).bundleError, blocked.bundleError)
  console.log('PASS evidence bundle: source trace, hashes, caps, dump exclusion, git fallback and unchanged verdict on packaging failure')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
