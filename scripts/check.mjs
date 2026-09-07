// scripts/check.mjs — repo-wide sanity gate: syntax-check all JS/MJS,
// and hard-fail if any private/environment-specific reference sneaks in.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

// Environment-specific leaks that must never appear in this public repo.
const FORBIDDEN = [
  '牛股王',
  'NiuGuWang',
  'niugu',
  'dsh-files',
  'E:\\',
  'hntz18',
  'NGW_CLIENT',
  '57782',
  'PC客户端',
  'linxin666',
]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let failures = 0

// 1. syntax-check every .js/.mjs
for (const f of walk(root)) {
  const ext = extname(f)
  if (ext !== '.js' && ext !== '.mjs') continue
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) {
    failures++
    console.error('SYNTAX FAIL:', relative(root, f))
    console.error(r.stderr)
  }
}

// 2. forbidden-reference scan over text files
//    (skip this script itself and CONTRIBUTING.md, which legitimately
//     mention the forbidden patterns as examples of what NOT to include)
const SKIP_SCAN = new Set([join(root, 'scripts', 'check.mjs'), join(root, 'CONTRIBUTING.md')])
for (const f of walk(root)) {
  if (SKIP_SCAN.has(f)) continue
  const ext = extname(f)
  if (!['.js', '.mjs', '.ps1', '.md', '.json', '.yaml', '.yml', '.cs'].includes(ext)) continue
  const text = readFileSync(f, 'utf8')
  for (const pat of FORBIDDEN) {
    if (text.includes(pat)) {
      // Proxy-Authenticate legitimately contains "-Authe..." pattern; skip line-level noise
      for (const [i, line] of text.split('\n').entries()) {
        if (line.includes(pat)) {
          failures++
          console.error(`FORBIDDEN REF "${pat}" at ${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`)
        }
      }
    }
  }
}

// 3. no nested .git or node_modules
for (const f of walk(root)) {
  if (f.includes('\\.git\\') || f.includes('\\node_modules\\')) {
    failures++
    console.error('NESTED EXCLUDE DIR leaked:', relative(root, f))
  }
}

if (failures > 0) {
  console.error(`\nCHECK FAILED: ${failures} problem(s)`)
  process.exit(1)
}
console.log('CHECK PASSED: syntax OK, no private references, no nested dirs')
