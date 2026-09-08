/**
 * lib/build-resolve.mjs — build-target resolution shared by the build
 * engines. Framework-free: used by plugins/dsh-build (DSH) and mcp/server.mjs.
 *
 * Why this exists: the msbuild engine was born on a legacy client layout
 * (WholeSolution.sln + platform x86). Stock repos have arbitrary solution
 * names and platforms, so defaults must be discovered, not hardcoded:
 *   - a repo containing WholeSolution.sln keeps the legacy defaults
 *     (WholeSolution.sln, platform x86) — byte-for-byte compatibility;
 *   - any other repo gets solution auto-detection (repo root first, then
 *     exactly-one solution one level deep) and platform auto-detection
 *     from the .sln file itself ("Any CPU" preferred, then
 *     "Mixed Platforms", then "x86", then the first listed).
 *
 * Ambiguity is an error, never a guess: multiple candidates ask the caller
 * to pass `project` explicitly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const SLN_RE = /\.slnx?$/i
const PROJECT_RE = /\.(csproj|vbproj|fsproj)$/i
// Directories never searched for solutions.
const SKIP_DIRS = new Set(['.git', '.vs', 'bin', 'obj', 'node_modules', 'packages', 'artifacts', 'TestResults'])

/** True when path looks like a solution (.sln / .slnx). */
export function isSolutionPath(p) {
  return SLN_RE.test(p)
}

/** True when path looks like a project file (.csproj / .vbproj / .fsproj). */
export function isProjectPath(p) {
  return PROJECT_RE.test(p)
}

/** True when the repo uses the legacy client layout (WholeSolution.sln at the root). */
export function isLegacyLayout(repoRoot) {
  return existsSync(join(repoRoot, 'WholeSolution.sln'))
}

/** Absolute path for a project/sln argument given relative to the repo root. */
export function resolveTargetPath(repoRoot, target) {
  return resolve(repoRoot, target)
}

/** *.sln / *.slnx directly inside dir (files only, unreadable dirs ignored). */
function listSolutions(dir) {
  const out = []
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!SLN_RE.test(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isFile()) out.push(p)
  }
  return out
}

function relDisplay(repoRoot, p) {
  const r = relative(repoRoot, p)
  return r || basename(p)
}

/**
 * Find the default solution when the caller passes no `project`.
 * Deterministic order: WholeSolution.sln (legacy) → exactly-one root-level
 * solution → exactly-one solution one level deep. Everything else is an
 * explicit error listing the candidates.
 *
 * @returns {{kind:'found', path:string, display:string}
 *         | {kind:'multiple', solutions:string[], error:string}
 *         | {kind:'none', error:string}}
 */
export function findDefaultSolution(repoRoot) {
  const rootSlns = listSolutions(repoRoot)
  const legacy = rootSlns.find((p) => basename(p).toLowerCase() === 'wholesolution.sln')
  if (legacy) return { kind: 'found', path: legacy, display: relDisplay(repoRoot, legacy) }
  if (rootSlns.length === 1) return { kind: 'found', path: rootSlns[0], display: relDisplay(repoRoot, rootSlns[0]) }
  if (rootSlns.length > 1) {
    return { kind: 'multiple', solutions: rootSlns.map((p) => relDisplay(repoRoot, p)), error: '在 ' + repoRoot + ' 根目录找到多个解决方案，无法确定默认目标' }
  }
  const nested = []
  let dirs
  try {
    dirs = readdirSync(repoRoot)
  } catch {
    dirs = []
  }
  for (const name of dirs) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(repoRoot, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    nested.push(...listSolutions(p))
  }
  if (nested.length === 1) return { kind: 'found', path: nested[0], display: relDisplay(repoRoot, nested[0]) }
  if (nested.length > 1) {
    return { kind: 'multiple', solutions: nested.map((p) => relDisplay(repoRoot, p)), error: '在 ' + repoRoot + ' 找到多个解决方案，无法确定默认目标' }
  }
  return { kind: 'none', error: '在 ' + repoRoot + ' 找不到 .sln/.slnx 解决方案，请用 project 指定目标' }
}

/** Platform names listed in a classic .sln SolutionConfigurationPlatforms section. */
function parseSlnPlatforms(text) {
  const m = text.match(/GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/)
  if (!m) return []
  const platforms = []
  for (const line of m[1].split(/\r?\n/)) {
    // "Debug|Any CPU = Debug|Any CPU"
    const mm = line.match(/^\s*[^=|]+\|\s*([^=|]+?)\s*=\s*[^=|]+\|/)
    if (!mm) continue
    const p = mm[1].trim()
    if (p && !platforms.includes(p)) platforms.push(p)
  }
  return platforms
}

/** Platform names in a .slnx (XML) solution — best-effort, format is new. */
function parseSlnxPlatforms(text) {
  const platforms = []
  const re = /(?:Platform\s+Name|Solution)="[^"]*\|([^"]+)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const p = m[1].trim()
    if (p && !platforms.includes(p)) platforms.push(p)
  }
  if (platforms.length === 0) {
    const re2 = /<Platform\s+Name="([^"]+)"/g
    while ((m = re2.exec(text)) !== null) {
      const p = m[1].trim()
      if (p && !platforms.includes(p)) platforms.push(p)
    }
  }
  return platforms
}

/**
 * Detect the solution-wide platform from the .sln/.slnx file itself.
 * Preference: "Any CPU" → "Mixed Platforms" → "x86" → first listed.
 * Returns null when the file cannot be parsed (caller omits /p:Platform
 * and lets MSBuild use the solution's own default).
 */
export function detectSolutionPlatform(slnPath) {
  let text
  try {
    text = readFileSync(slnPath, 'utf8')
  } catch {
    return null
  }
  const platforms = slnPath.toLowerCase().endsWith('.slnx') ? parseSlnxPlatforms(text) : parseSlnPlatforms(text)
  if (platforms.length === 0) return null
  for (const pref of ['Any CPU', 'Mixed Platforms', 'x86']) {
    if (platforms.some((p) => p.toLowerCase() === pref.toLowerCase())) return pref
  }
  return platforms[0]
}

/**
 * Default platform for a resolved solution target.
 * WholeSolution.sln keeps the legacy x86 default; everything else is
 * detected from the solution. null = omit /p:Platform (solution default).
 */
export function defaultPlatformFor(slnPath) {
  if (basename(slnPath).toLowerCase() === 'wholesolution.sln') return 'x86'
  return detectSolutionPlatform(slnPath)
}
