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

// Local-only paths (task packages, run artifacts, agent env overrides) that
// must never be committed. Their content is skipped by the text scans below;
// section 4 below hard-fails if anything under them is tracked by git.
const LOCAL_ONLY = [
  join(root, 'bench', 'tasks'),
  join(root, 'bench', 'local.env'),
  join(root, 'bench-runs'),
  // Tool evidence directories hold real client screenshots/UI text (and may
  // legitimately contain product names) — local artifacts, never scanned and
  // never committed. ui-evidence is the default evidence root when a run is
  // started from the repo root.
  join(root, '.dsh-agent-toolchain'),
  join(root, 'ui-evidence'),
]

function isLocalOnly(p) {
  return LOCAL_ONLY.some((d) => p === d || p.startsWith(d + '\\'))
}

// Local-only trees can be huge (bench-runs holds per-run repo clones: 100k+
// files, 19k+ dirs). Recursing into them blew the call stack before the first
// scan could even run, so prune them at the directory level — they are never
// scanned anyway, and section 4 still checks them via `git ls-files`.
function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur) } catch { continue }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git') continue
      const p = join(cur, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (isLocalOnly(p)) continue
        stack.push(p)
      } else {
        out.push(p)
      }
    }
  }
  return out
}

let failures = 0

// 1. syntax-check every .js/.mjs
for (const f of walk(root)) {
  if (isLocalOnly(f)) continue
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
  if (SKIP_SCAN.has(f) || isLocalOnly(f)) continue
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
  if (isLocalOnly(f)) continue
  if (f.includes('\\.git\\') || f.includes('\\node_modules\\')) {
    failures++
    console.error('NESTED EXCLUDE DIR leaked:', relative(root, f))
  }
}

// 4. local-only benchmark paths must not be tracked by git (privacy gate).
try {
  const tracked = spawnSync('git', ['ls-files', '--', 'bench/tasks', 'bench/local.env', 'bench-runs'], { encoding: 'utf8' })
  if (tracked.status === 0 && tracked.stdout.trim()) {
    for (const line of tracked.stdout.trim().split(/\r?\n/)) {
      failures++
      console.error('LOCAL-ONLY FILE TRACKED BY GIT (remove it before committing):', line)
    }
  }
} catch {
  /* git not available */
}

// 5. DSH tool-schema guard: an object-typed parameter without
//    `additionalProperties` makes defineTool throw at boot and crash-loops
//    the host (observed with dsh-verify's `context` param: the watchdog
//    relaunched node every 3s). Static scan catches the single-line form;
//    multi-line object values are not covered by this scan.
for (const f of walk(join(root, 'plugins'))) {
  const ext = extname(f)
  if (ext !== '.js' && ext !== '.mjs') continue
  const text = readFileSync(f, 'utf8')
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*\w+\s*:\s*\{\s*type:\s*['"]object['"]\s*,/.test(line) && !line.includes('additionalProperties')) {
      failures++
      console.error(`OBJECT PARAM MISSING additionalProperties at ${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`)
    }
  }
}

// 6. PowerShell 5.1 encoding guard: a UTF-8 .ps1 WITHOUT a BOM is decoded as
//    the system ANSI codepage on CN-locale Windows (GBK), which mangles the
//    Chinese comments so badly that string quotes get swallowed and the
//    whole script fails to parse (observed: every ui_drive action died with
//    "Unexpected token"). Every tracked .ps1 must start with EF BB BF.
for (const f of walk(root)) {
  if (isLocalOnly(f)) continue
  if (extname(f) !== '.ps1') continue
  const buf = readFileSync(f)
  if (!(buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) {
    failures++
    console.error('PS1 MISSING UTF-8 BOM (PowerShell 5.1 GBK parse break):', relative(root, f))
  }
}

if (failures > 0) {
  console.error(`\nCHECK FAILED: ${failures} problem(s)`)
  process.exit(1)
}
console.log('CHECK PASSED: syntax OK, no private references, no nested dirs, tool schemas complete, ps1 encodings safe')
