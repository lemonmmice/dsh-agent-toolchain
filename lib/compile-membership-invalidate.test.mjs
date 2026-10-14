// F01 回归：工程未变、但**新建**一个原本缺失的 Directory.Build.props / import 目标时，
// 缓存必须失效重算 —— 否则会把"其实不进编译"误判成"进编译"（假肯定）。
// 复刻审查 19b-delta-probes 的反例：SDK 工程先判 included=true，创建关闭默认项的 props 后应翻为 false。
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { checkCompileMembership, collectItemSources } from './compile-membership.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }

// ---- 1. 新建 Directory.Build.props（关默认项）后，SDK 默认 glob 判定必须从 true 翻成 false ----
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-inv-sdk-'))
  try {
    const project = join(dir, 'App.csproj')
    const file = join(dir, 'A.cs')
    writeFileSync(file, 'class A {}')
    writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"></Project>')
    const options = { projectPath: project, repoRoot: dir }

    const before = checkCompileMembership(file, options)
    check('初始：SDK 默认 glob ⇒ included=true', before.included === true && before.basis === 'sdk-default-glob', JSON.stringify({ included: before.included, basis: before.basis }))

    // 工程文件原样不动，只是新建一个原本不存在的 Directory.Build.props 关掉默认项
    writeFileSync(join(dir, 'Directory.Build.props'), '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>')
    const after = checkCompileMembership(file, options)
    check('★ 新建 props 后缓存失效：included=false（不再沿用旧的 true）', after.included === false, JSON.stringify({ included: after.included, basis: after.basis }))
    check('  且依据反映默认项被关掉', after.basis === 'sdk-default-disabled', String(after.basis))
    check('  props 进了 sources（确实重算、读到了它）', after.sources.some((s) => s.endsWith('Directory.Build.props')), JSON.stringify(after.sources))

    // 删掉 props 后应再翻回 true（出现/消失双向都要失效）
    rmSync(join(dir, 'Directory.Build.props'), { force: true })
    const restored = checkCompileMembership(file, options)
    check('删除 props 后再翻回 included=true', restored.included === true && restored.basis === 'sdk-default-glob', JSON.stringify({ included: restored.included, basis: restored.basis }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---- 2. legacy 工程：新建一个原本解析不到的 import 目标（带 <Compile Include>）后，需重算并把源纳入 ----
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-inv-imp-'))
  try {
    const project = join(dir, 'Legacy.csproj')
    const file = join(dir, 'B.cs')
    writeFileSync(file, 'class B {}')
    // legacy（无 Sdk），导入一个此刻还不存在的 Shared.targets
    writeFileSync(project, '<Project ToolsVersion="4.0"><Import Project="Shared.targets" /></Project>')
    const options = { projectPath: project, repoRoot: dir }

    const r1 = collectItemSources(project, { repoRoot: dir })
    check('初始：Shared.targets 不存在 ⇒ 记为 unresolvedImports', r1.unresolvedImports.includes('Shared.targets'), JSON.stringify(r1.unresolvedImports))

    // 现在把这个 import 目标**创建**出来，且它把 B.cs 列进编译
    writeFileSync(join(dir, 'Shared.targets'), '<Project><ItemGroup><Compile Include="B.cs" /></ItemGroup></Project>')
    const r2 = collectItemSources(project, { repoRoot: dir })
    check('★ 新建 import 目标后缓存失效：Shared.targets 进 sources', r2.sources.some((s) => s.path.endsWith('Shared.targets')), JSON.stringify(r2.sources.map((s) => s.path.replace(dir, '.'))))
    const member = checkCompileMembership(file, options)
    check('  且判定 B.cs included=true（命中导入文件里的 Compile Include）', member.included === true, JSON.stringify({ included: member.included, basis: member.basis }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---- 2b. R1：备用候选命中后，更高优先候选出现 / 消失也要失效（嵌套 import 的双候选边界）----
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-inv-prio-'))
  try {
    // App.csproj → build/outer.targets → (import "Shared.targets")；解析器优先按"导入文件自己的目录"(build/)，再按工程目录
    mkdirSync(join(dir, 'build'), { recursive: true })
    const project = join(dir, 'App.csproj')
    const file = join(dir, 'A.cs')
    writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><Import Project="build/outer.targets" /></Project>')
    writeFileSync(file, 'class A {}')
    writeFileSync(join(dir, 'build', 'outer.targets'), '<Project><Import Project="Shared.targets" /></Project>')
    // 初始只有工程目录的 Shared.targets（备用候选 B 命中），build/Shared.targets（优先候选 A）尚不存在
    writeFileSync(join(dir, 'Shared.targets'), '<Project></Project>')
    const options = { projectPath: project, repoRoot: dir }

    const before = checkCompileMembership(file, options)
    check('初始：命中工程目录的备用 Shared.targets ⇒ included=true', before.included === true, JSON.stringify({ included: before.included, basis: before.basis }))

    // 创建**更高优先**候选 build/Shared.targets（关默认项）——工程文件/outer.targets 都没变
    writeFileSync(join(dir, 'build', 'Shared.targets'), '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>')
    const after = checkCompileMembership(file, options)
    check('★ 优先候选出现后缓存失效：included=false（不再沿用备用候选的结论）', after.included === false, JSON.stringify({ included: after.included, basis: after.basis }))
    check('  且重算选中了 build/Shared.targets', after.sources.some((s) => s.replace(/\\/g, '/').endsWith('build/Shared.targets')), JSON.stringify(after.sources))

    // 删除优先候选后应再翻回 true（出现/消失双向都失效）
    rmSync(join(dir, 'build', 'Shared.targets'), { force: true })
    const restored = checkCompileMembership(file, options)
    check('删除优先候选后再翻回 included=true', restored.included === true, JSON.stringify({ included: restored.included, basis: restored.basis }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---- 3. 返回的缓存对象不可被外部改写（冻结）----
{
  const dir = mkdtempSync(join(tmpdir(), 'cc-inv-frz-'))
  try {
    const project = join(dir, 'App.csproj')
    writeFileSync(join(dir, 'A.cs'), 'class A {}')
    writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"></Project>')
    const r = collectItemSources(project, { repoRoot: dir })
    let threw = false
    try { r.sources.push({ path: 'x', role: 'x' }) } catch { threw = true }
    check('缓存结果的 sources 已冻结（外部 push 抛错，不污染缓存）', threw === true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: compile-membership cache invalidation (new props/targets/import flips the verdict; frozen result)')
