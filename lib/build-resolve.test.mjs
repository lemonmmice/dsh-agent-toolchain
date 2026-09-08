// lib/build-resolve.test.mjs — build-target resolution self-test:
// legacy client layout (WholeSolution.sln + x86) must be preserved, stock
// repos must get solution/platform auto-detection, and ambiguity must be an
// explicit error instead of a guess.
import {
  findDefaultSolution,
  detectSolutionPlatform,
  defaultPlatformFor,
  isLegacyLayout,
  isSolutionPath,
  isProjectPath,
  resolveTargetPath,
} from './build-resolve.mjs'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'build-resolve-'))
  for (const f of files) {
    const p = join(root, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '')
  }
  return root
}

// ---------------------------------------------------------------- findDefaultSolution

// 1. legacy: WholeSolution.sln at the root always wins
{
  const root = fixture(['WholeSolution.sln', 'src/Other.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'found' && r.display === 'WholeSolution.sln', 'WholeSolution.sln wins even with other solutions present')
}

// 2. exactly one root-level solution
{
  const root = fixture(['App.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'found' && r.display === 'App.sln', 'single root solution auto-detected')
}

// 3. multiple root solutions -> explicit error, never a guess
{
  const root = fixture(['A.sln', 'B.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'multiple' && r.solutions.length === 2 && r.error.length > 0, 'multiple root solutions -> error listing candidates')
}

// 4. exactly one solution one level deep
{
  const root = fixture(['src/App.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'found' && r.display === join('src', 'App.sln'), 'single nested solution auto-detected (relative display)')
}

// 5. multiple nested solutions -> error
{
  const root = fixture(['src/A.sln', 'tests/B.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'multiple' && r.solutions.length === 2, 'multiple nested solutions -> error')
}

// 6. no solution anywhere -> explicit none error
{
  const root = fixture(['src/Foo.csproj'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'none' && r.error.length > 0, 'no solution -> none + guidance error')
}

// 7. skip dirs (node_modules/bin/obj/.git) are never searched
{
  const root = fixture(['node_modules/X.sln', 'bin/Y.sln', '.git/Z.sln', 'src/App.sln'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'found' && r.display === join('src', 'App.sln'), 'skip dirs ignored, real solution found')
}

// 8. .slnx counts as a solution
{
  const root = fixture(['App.slnx'])
  const r = findDefaultSolution(root)
  ok(r.kind === 'found' && r.display === 'App.slnx', '.slnx auto-detected')
}

// ---------------------------------------------------------------- platform detection

// 9. prefer Any CPU when listed
{
  const root = fixture(['App.sln'])
  writeFileSync(
    join(root, 'App.sln'),
    'GlobalSection(SolutionConfigurationPlatforms) = preSolution\n' +
      '\tDebug|Any CPU = Debug|Any CPU\n' +
      '\tDebug|x86 = Debug|x86\n' +
      'EndGlobalSection\n',
  )
  ok(detectSolutionPlatform(join(root, 'App.sln')) === 'Any CPU', 'Any CPU preferred over x86')
}

// 10. Mixed Platforms preferred over the rest when no Any CPU
{
  const root = fixture(['App.sln'])
  writeFileSync(
    join(root, 'App.sln'),
    'GlobalSection(SolutionConfigurationPlatforms) = preSolution\n' +
      '\tDebug|Mixed Platforms = Debug|Mixed Platforms\n' +
      '\tDebug|x64 = Debug|x64\n' +
      'EndGlobalSection\n',
  )
  ok(detectSolutionPlatform(join(root, 'App.sln')) === 'Mixed Platforms', 'Mixed Platforms preferred when Any CPU absent')
}

// 11. x86-only solution keeps x86
{
  const root = fixture(['App.sln'])
  writeFileSync(
    join(root, 'App.sln'),
    'GlobalSection(SolutionConfigurationPlatforms) = preSolution\n' +
      '\tDebug|x86 = Debug|x86\n' +
      'EndGlobalSection\n',
  )
  ok(detectSolutionPlatform(join(root, 'App.sln')) === 'x86', 'x86-only solution detected as x86')
}

// 12. unparseable solution -> null (caller omits /p:Platform)
{
  const root = fixture(['App.sln'])
  writeFileSync(join(root, 'App.sln'), 'this is not a solution file\n')
  ok(detectSolutionPlatform(join(root, 'App.sln')) === null, 'unparseable solution -> null (omit platform)')
}

// 13. WholeSolution.sln keeps the legacy x86 default regardless of content
{
  const root = fixture(['WholeSolution.sln'])
  writeFileSync(
    join(root, 'WholeSolution.sln'),
    'GlobalSection(SolutionConfigurationPlatforms) = preSolution\n' +
      '\tDebug|Any CPU = Debug|Any CPU\n' +
      'EndGlobalSection\n',
  )
  ok(defaultPlatformFor(join(root, 'WholeSolution.sln')) === 'x86', 'WholeSolution.sln -> legacy x86 even when Any CPU is listed')
}

// ---------------------------------------------------------------- helpers

ok(isLegacyLayout(fixture(['WholeSolution.sln'])), 'isLegacyLayout true with WholeSolution.sln')
ok(!isLegacyLayout(fixture(['App.sln'])), 'isLegacyLayout false without WholeSolution.sln')
ok(isSolutionPath('App.sln') && isSolutionPath('App.slnx') && !isSolutionPath('App.csproj'), 'isSolutionPath matches .sln/.slnx only')
ok(isProjectPath('App.csproj') && isProjectPath('App.vbproj') && !isProjectPath('App.sln'), 'isProjectPath matches project files only')
ok(resolveTargetPath('C:/repo', 'src/App.sln') === join('C:/repo', 'src', 'App.sln'), 'resolveTargetPath resolves against repo root')

if (failures > 0) {
  console.error(`\nBUILD-RESOLVE TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nBUILD-RESOLVE TEST PASSED')
