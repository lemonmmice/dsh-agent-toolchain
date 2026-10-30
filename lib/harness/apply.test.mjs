import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyValidatedExperience, retireApplied, listApplied } from './apply.mjs'

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

test('fail-closed: a regressing gate blocks the apply and writes nothing', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  const result = await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: async () => ({ runnable: true, pass: false }) })
  assert.equal(result.applied, false)
  assert.equal(result.blocked, 'regression')
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

test('retireApplied removes the skill files and marks the entry retired', async () => {
  const { harnessRoot, projectSkillsDir, library } = fixture()
  await applyValidatedExperience({ harnessRoot, library, projectSkillsDir, experienceId: 'exp-1', runGate: PASS })
  const retired = retireApplied({ projectSkillsDir, id: 'exp-1', reason: 'superseded' })
  assert.equal(retired.retired, true)
  assert.ok(!existsSync(join(projectSkillsDir, 'thread-hang', 'exp-1', 'skill.md')))
  assert.equal(listApplied({ projectSkillsDir }).length, 0)
})
