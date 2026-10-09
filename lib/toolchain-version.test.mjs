import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const scratch = mkdtempSync(join(tmpdir(), 'toolchain-version-'))
try {
  for (const [index, fixture] of [
    { pkg: { name: 'dsh-agent-toolchain', version: '2.0.0' }, head: 'a'.repeat(40), expected: { version: '2.0.0', sha: 'a'.repeat(12) } },
    { pkg: { name: 'other-profile', version: '9.0.0' }, expected: { version: null } },
    { pkg: { name: 'other-profile' }, stamp: { version: '2.0.0', sha: 'b'.repeat(12), dirty: true }, expected: { version: '2.0.0', sha: 'b'.repeat(12), dirty: true, source: 'deploy-stamp' } },
    { pkg: { name: 'other-profile' }, stamp: '{broken', expected: { version: null } },
  ].entries()) {
    const root = join(scratch, String(index))
    mkdirSync(join(root, 'lib'), { recursive: true })
    copyFileSync(new URL('./toolchain-version.mjs', import.meta.url), join(root, 'lib', 'toolchain-version.mjs'))
    writeFileSync(join(root, 'package.json'), JSON.stringify(fixture.pkg))
    if (fixture.head) { mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'HEAD'), fixture.head) }
    if (fixture.stamp) writeFileSync(join(root, '.dsh-toolchain-deploy.json'), typeof fixture.stamp === 'string' ? fixture.stamp : JSON.stringify(fixture.stamp))
    const module = await import(pathToFileURL(join(root, 'lib', 'toolchain-version.mjs')))
    assert.deepEqual(module.toolchainVersion(), fixture.expected)
  }
  console.log('PASS toolchain version: checkout identity, foreign package, deployment stamp and corrupt stamp')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
