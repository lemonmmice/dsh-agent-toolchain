// scripts/deploy-plugins.mjs — copy the repo's plugins into a live DSH profile.
//
// The DSH host loads profile plugins from files on disk, so a repo edit is not
// live until it is copied into the profile and the plugin is reloaded (the web
// profile watches its cordis.patch.yml). This script is the supported way to do
// that copy: no absolute machine paths in the repo, target comes from an
// argument or DSH_PROFILE_DIR.
//
// Usage:
//   node scripts/deploy-plugins.mjs                       # default profile: $DSH_HOME/profiles/web
//   node scripts/deploy-plugins.mjs --profile <dir>       # explicit profile dir
//   node scripts/deploy-plugins.mjs --only dsh-ui-drive
//   node scripts/deploy-plugins.mjs --check               # dry run: report drift only
//
// Every repo plugin is deployed to <profile>/plugins/<name> (the same layout the
// profile's cordis.patch.yml references). npm-installed plugin packages under
// <profile>/node_modules are NOT touched — those are managed by `dsh plugin add`.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const argOf = (n) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
}
const check = argv.includes('--check')
const only = argOf('only')
const profileDir = argOf('profile') || process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web')

if (!existsSync(profileDir)) {
  console.error('profile dir not found: ' + profileDir)
  process.exit(2)
}

const pluginsRoot = join(root, 'plugins')
const targets = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => (only ? n === only : true))

const hashOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function listFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else out.push(p)
    }
  }
  return out
}

let drift = 0
let copied = 0
for (const name of targets) {
  const src = join(pluginsRoot, name)
  const dst = join(profileDir, 'plugins', name)
  const files = listFiles(src)
  const missing = []
  const changed = []
  for (const f of files) {
    const rel = relative(src, f)
    const df = join(dst, rel)
    if (!existsSync(df)) missing.push(rel)
    else if (hashOf(f) !== hashOf(df)) changed.push(rel)
  }
  const status = missing.length === 0 && changed.length === 0 ? 'in sync' : 'drift'
  if (status === 'drift') drift++
  console.log(`${name.padEnd(28)} ${status}` + (missing.length ? ` missing=${missing.length}` : '') + (changed.length ? ` changed=${changed.length}` : ''))
  for (const m of missing.slice(0, 5)) console.log('    + ' + m)
  for (const c of changed.slice(0, 5)) console.log('    ~ ' + c)
  if (!check && status === 'drift') {
    mkdirSync(dst, { recursive: true })
    cpSync(src, dst, { recursive: true, force: true })
    copied++
  }
}

console.log(check ? `\nDRY RUN: ${drift} plugin(s) drifted` : `\nDEPLOYED: ${copied} plugin(s) updated into ${profileDir}`)
