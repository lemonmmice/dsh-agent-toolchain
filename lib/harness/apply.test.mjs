import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyValidatedExperience, retireApplied, listApplied } from './apply.mjs'

// A real runGate: runs the frozen gate cmd in the rebuilt workspace apply.mjs hands it (ctx.cwd).
// This exercises the actual reproduction rebuild, not just the label logic.
const realRunGate = async (claim, ctx = {}) => {
  try { execSync(claim.cmd, { cwd: ctx.cwd, stdio: 'ignore' }); return { runnable: true, pass: true } }
  catch { return { runnable: true, pass: false } }
}

// Harness root with a real trial manifest (base files + a frozen gate) and a real overlay dir the
// experience points at via filesRef — enough for apply to rebuild base+overlay and re-run the gate.
function realFixture({ baseFiles, overlayFiles, gateCmd }) {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'apply-real-'))
  const projectSkillsDir = join(harnessRoot, 'proj', '.dsh-skills')
  mkdirSync(join(harnessRoot, 'trials', 't1'), { recursive: true })
  writeFileSync(join(harnessRoot, 'trials', 't1', 'manifest.json'), JSON.stringify({ baseHarness: { files: baseFiles }, frozenContract: { claims: [{ kind: 'gate', cmd: gateCmd }] } }), 'utf8')
  const overlayRel = join('experiences', 'exp-1', 'files')
  const overlayAbs = join(harnessRoot, overlayRel)
  mkdirSync(overlayAbs, { recursive: true })
  for (const [rel, content] of Object.entries(overlayFiles)) { mkdirSync(join(overlayAbs, rel, '..'), { recursive: true }); writeFileSync(join(overlayAbs, rel), content, 'utf8') }
  const record = { id: 'exp-1', status: 'validated', scope: { project: 'p', taskType: 'thread-hang' }, reflection: { component: 'skills/x.md' }, fingerprint: 'fp1', trialId: 't1', filesRef: overlayRel.replaceAll('\\', '/') }
  const library = {
    get(id) { return id === 'exp-1' ? { ...record } : null },
    exportFiles({ targetDirectory }) { mkdirSync(targetDirectory, { recursive: true }); for (const [rel, content] of Object.entries(overlayFiles)) { mkdirSync(join(targetDirectory, rel, '..'), { recursive: true }); writeFileSync(join(targetDirectory, rel), content, 'utf8') } return { ok: true } },
  }
  return { harnessRoot, projectSkillsDir, library }
}

// A minimal harness root with one trial carrying a self-contained gate, plus a fake experience
// library (get + exportFiles) — enough to exercise the apply + regression logic without the
// executor. runGate is injected so each test fixes the regression outcome.
function fixture({ status = 'validated', withGate = true } = {}) {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'apply-harness-'))
  const projectSkillsDir = join(harnessRoot, 'project', '.dsh-skills')
  const record = { id: 'exp-1', status, scope: { project: 'p', taskType: 'thread-hang' }, reflection: { component: 'skills/hint.md' }, fingerprint: 'fp1', trialId: 't1' }
  mkdirSync(join(harnessRoot, 'trials', 't1'), { recursive: true })
  writeFileSync(join(harnessRoot, 'trials', 't1', 'manifest.json'), JSON.stringify({ frozenContract: { claims: withGate ? [{ kind: 'gate', cmd: 'node -e ""' }] : [{ kind: 'manual', statement: 'x' }] } }), 'utf8')
  const library = {
    get(id) { return id === record.id ? { ...record } : null },
    exportFiles({ id, targetDirectory }) { mkdirSync(targetDirectory, { recursive: true }); writeFileSync(join(targetDirectory, 'skill.md'), 'lesson ' + id, 'utf8'); return { ok: true } },
  }
  return { harnessRoot, projectSkillsDir, library }
}

const PASS = async () => ({ runnable: true, pass: true })

test('refuses to apply an experience that is not validated', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture({ status: 'proposed' })
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: PASS })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'not-validated')
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
})

test('applies a validated experience as a project-scoped on-demand skill when all gates pass', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: PASS, now: () => '2026-10-30T00:00:00.000Z' })
  assert.equal(result.applied, true)
  assert.equal(result.regression.ran, 1)
  assert.ok(readFileSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md'), 'utf8').includes('lesson exp-1'))
  assert.equal(listApplied({ projectSkillsDir }).length, 1)
})

test("fail-closed: the new lesson's own gate failing on re-run is needs-reproduction, not a false regression", async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: async () => ({ runnable: true, pass: false }) })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'needs-reproduction')
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
})

test('fail-closed: a new lesson that regresses an already-applied sibling gate is blocked as regression', async () => {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'apply-sibling-'))
  const projectSkillsDir = join(harnessRoot, 'proj', '.dsh-skills')
  for (const tid of ['t0', 't1']) {
    mkdirSync(join(harnessRoot, 'trials', tid), { recursive: true })
    writeFileSync(join(harnessRoot, 'trials', tid, 'manifest.json'), JSON.stringify({ frozenContract: { claims: [{ kind: 'gate', cmd: `node -e "${tid}"` }] } }), 'utf8')
  }
  const records = {
    'exp-0': { id: 'exp-0', status: 'validated', scope: { project: 'p', taskType: 'thread-hang' }, reflection: { component: 'skills/a.md' }, fingerprint: 'f0', trialId: 't0' },
    'exp-1': { id: 'exp-1', status: 'validated', scope: { project: 'p', taskType: 'thread-hang' }, reflection: { component: 'skills/b.md' }, fingerprint: 'f1', trialId: 't1' },
  }
  const library = {
    get(id) { return records[id] ? { ...records[id] } : null },
    exportFiles({ id, targetDirectory }) { mkdirSync(targetDirectory, { recursive: true }); writeFileSync(join(targetDirectory, 'skill.md'), 'lesson ' + id, 'utf8'); return { ok: true } },
  }
  const applied0 = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-0', runGate: async () => ({ runnable: true, pass: true }) })
  assert.equal(applied0.applied, true)
  // exp-1's own gate passes, but it regresses the already-applied sibling exp-0 (t0) gate.
  const applied1 = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: async (claim) => ({ runnable: true, pass: !String(claim.cmd).includes('t0') }) })
  assert.equal(applied1.applied, false)
  assert.equal(applied1.blocked, 'regression')
  assert.deepEqual(applied1.regression.failed, ['exp-0'])
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
})

test('fail-closed: a gate that cannot be re-run (reproduction gone) blocks the apply', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: async () => ({ runnable: false }) })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'needs-reproduction')
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
})

test('fail-closed: a lesson with no self-contained gate cannot be auto-applied', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture({ withGate: false })
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: PASS })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'needs-reproduction')
})

test('rebuild lands a FILE-SATISFIABLE gate: base+overlay is materialized and the real gate passes', async () => {
  // Overlay flips marker.txt bad→good; the gate is satisfiable by files alone → must apply.
  const { harnessRoot, projectSkillsDir, library } = realFixture({
    baseFiles: { 'marker.txt': 'bad' },
    overlayFiles: { 'marker.txt': 'good', 'skills/x.md': 'lesson' },
    gateCmd: `node -e "const fs=require('fs');process.exit(fs.readFileSync('marker.txt','utf8').trim()==='good'?0:1)"`,
  })
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: realRunGate })
  assert.equal(result.applied, true)
  assert.equal(result.regression.passed, 1)
  assert.ok(existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skills', 'x.md')))
})

test('rebuild blocks an EXECUTION-DEPENDENT gate as needs-reproduction (artifact not in source+overlay)', async () => {
  // The gate inspects result.txt, which only the agent task produced at trial time — absent from a
  // source+overlay rebuild → the real gate fails → needs-reproduction, nothing written.
  const { harnessRoot, projectSkillsDir, library } = realFixture({
    baseFiles: { 'value.txt': 'bad' },
    overlayFiles: { 'value.txt': 'good', 'skills/x.md': 'lesson' },
    gateCmd: `node -e "const fs=require('fs');process.exit(fs.readFileSync('result.txt','utf8').trim()==='pass'?0:1)"`,
  })
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: realRunGate })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'needs-reproduction')
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skills', 'x.md')))
})

test('retireApplied removes the skill files and marks the entry retired', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: PASS })
  const retired = retireApplied({ projectSkillsDir, id: 'exp-1', reason: 'superseded' })
  assert.equal(retired.retired, true)
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
  assert.equal(listApplied({ projectSkillsDir }).length, 0)
})
