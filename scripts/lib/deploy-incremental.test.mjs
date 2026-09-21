import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-deploy-incremental-'))
const source = join(scratch, 'source')
const profile = join(scratch, 'profile')
const plugin = join(source, 'plugins', 'fixture-plugin')
const deployedPlugin = join(profile, 'plugins', 'fixture-plugin')
try {
  mkdirSync(join(source, 'scripts'), { recursive: true })
  mkdirSync(join(plugin, 'bin'), { recursive: true })
  mkdirSync(join(source, 'lib', 'nested'), { recursive: true })
  mkdirSync(profile)
  const deploy = join(source, 'scripts', 'deploy-plugins.mjs')
  copyFileSync(join(repository, 'scripts', 'deploy-plugins.mjs'), deploy)
  writeFileSync(join(plugin, 'bin', 'unchanged.node'), 'unchanged binary fixture')
  writeFileSync(join(plugin, 'index.js'), 'version one')
  writeFileSync(join(source, 'lib', 'nested', 'shared.mjs'), 'shared fixture')
  const run = (...extra) => {
    const result = spawnSync(process.execPath, [deploy, '--profile', profile, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return result.stdout
  }
  run()
  const binary = join(deployedPlugin, 'bin', 'unchanged.node')
  const oldTime = new Date('2000-01-01T00:00:00Z')
  utimesSync(binary, oldTime, oldTime)
  const before = statSync(binary).mtimeMs
  writeFileSync(join(plugin, 'index.js'), 'version two')
  mkdirSync(join(plugin, 'new', 'nested'), { recursive: true })
  writeFileSync(join(plugin, 'new', 'nested', 'added.mjs'), 'new fixture')
  run()
  assert.equal(statSync(binary).mtimeMs, before, 'unchanged native binaries must not be rewritten when JS changes')
  assert.equal(readFileSync(join(deployedPlugin, 'index.js'), 'utf8'), 'version two')
  assert.equal(readFileSync(join(deployedPlugin, 'new', 'nested', 'added.mjs'), 'utf8'), 'new fixture')
  assert.equal(readFileSync(join(profile, 'lib', 'nested', 'shared.mjs'), 'utf8'), 'shared fixture')
  assert.match(run('--check'), /0 drift/)
  const stamp = readFileSync(join(profile, '.dsh-toolchain-deploy.json'), 'utf8')
  run()
  assert.equal(readFileSync(join(profile, '.dsh-toolchain-deploy.json'), 'utf8'), stamp)
  console.log('PASS incremental deployment: unchanged binaries untouched, nested additions, shared modules and no-op stamp')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
