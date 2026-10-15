import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as drift from './plugin-deploy-drift.mjs'
import { toolchainStatusAsync } from './toolchain-status.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'status-deploy-paths-'))
const root = join(temporary, 'source'), profile = join(temporary, 'profile')
const keys = ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_TOOLCHAIN_REPO_ROOT', 'DSH_NO_ENV_FALLBACK', 'DSH_TEST']
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const write = (base, rel, value) => { const p = join(base, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value) }
const deployItem = result => result.items.find(item => item.key === 'pluginDeploy')
const { scanDeployDrift, resolveDeploySource } = drift
try {
  for (const target of [root, profile]) {
    write(target, 'plugins/demo/index.js', 'same')
    write(target, 'lib/shared.mjs', 'same')
  }
  process.env.DSH_NO_ENV_FALLBACK = '1'
  process.env.DSH_TEST = '1'
  process.env.DSH_PROFILE_DIR = profile
  process.env.DSH_TOOLCHAIN_REPO_ROOT = root
  let item = deployItem(await toolchainStatusAsync({ fresh: true }))
  assert.equal(item.value, profile, 'worker must receive the explicit profile')
  assert.equal(item.ok, true, JSON.stringify(item))
  write(root, 'plugins/demo/index.js', 'changed source')
  item = deployItem(await toolchainStatusAsync({ fresh: true }))
  assert.equal(item.ok, false)
  assert.match(item.note, /index\.js/)

  delete process.env.DSH_PROFILE_DIR
  process.env.DSH_HOME = join(temporary, 'alternate-home')
  item = deployItem(await toolchainStatusAsync({ fresh: true }))
  assert.equal(item.value, join(process.env.DSH_HOME, 'profiles', 'web'))

  assert.equal(scanDeployDrift({ root: profile, profileDir: profile }).compared, false, 'self comparison is not deployment evidence')
  assert.equal(scanDeployDrift({ root: join(temporary, 'missing'), profileDir: profile }).compared, false)
  assert.equal(resolveDeploySource({ moduleRoot: profile, profileDir: profile }), '', 'old stamps without a source cannot prove freshness')
  write(profile, '.dsh-toolchain-deploy.json', JSON.stringify({ sourceRoot: root, atMs: Date.now() }))
  assert.equal(resolveDeploySource({ moduleRoot: profile, profileDir: profile }), root)

  // Run the actual deployed module: its import.meta.url points into profile/lib, not the source checkout.
  cpSync(dirname(fileURLToPath(import.meta.url)), join(profile, 'lib'), { recursive: true })
  const deployed = await import(pathToFileURL(join(profile, 'lib/toolchain-status.mjs')).href)
  item = deployItem(deployed.buildToolchainStatus({ env: { DSH_PROFILE_DIR: profile, DSH_NO_ENV_FALLBACK: '1' }, procList: () => [], adminCheck: () => false }))
  assert.equal(item.ok, false, 'deployed lib must compare against the stamped source')
  assert.match(item.note, /index\.js/)
  console.log('PASS status deployment: worker environment, DSH_HOME, no self comparison, stamped source from deployed module')
} finally {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  rmSync(temporary, { recursive: true, force: true })
}
