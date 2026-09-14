// 「文件进没进编译」核对器的单测 —— 用**临时目录里现造的工程**，不碰任何真实仓库。
//
// 为什么单测要点名这些场景：本仓已知的坑是"legacy .csproj 不自动包含 .cs，漏写 <Compile Include>
// 时构建通过但文件根本没编"，而 G1 黑盒 agent 的原话是"kind:file 只验存在 ⇒ 裁决器给假安全感"。
// 所以这里的核心断言是：**"不在"必须说"不在"，"读不到"必须说"读不到"，两者不许混**。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkCompileMembership, findProjectFor, globToRegExp, parseCompileItems, renderMembership } from '../../../lib/compile-membership.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-compile-membership-'))
const W = (p, s) => { mkdirSync(join(root, p.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(root, p), s, 'utf8') }

// ---------- legacy 工程：显式列了 A.cs，没列 B.cs ----------
W('legacy/Legacy.csproj', `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Compile Include="A.cs" />
    <Compile Include="Sub\\C.cs" />
    <Compile Include="**\\Generated\\*.cs" />
    <Compile Include="Excluded.cs" />
    <Compile Remove="Excluded.cs" />
  </ItemGroup>
</Project>`)
W('legacy/A.cs', '// a')
W('legacy/B.cs', '// b')
W('legacy/Sub/C.cs', '// c')
W('legacy/Sub/D.cs', '// d')
W('legacy/Generated/x.cs', '// x')
W('legacy/Excluded.cs', '// excluded')

// ---------- SDK 工程：默认 glob ----------
W('sdk/Sdk.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')
W('sdk/New.cs', '// new')

// ---------- SDK 工程但关了默认项 ----------
W('sdkopt/SdkOpt.csproj', `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
  <ItemGroup><Compile Include="Listed.cs" Condition="'$(Configuration)'=='Debug'" /></ItemGroup>
</Project>`)
W('sdkopt/Listed.cs', '// listed')
W('sdkopt/Unlisted.cs', '// unlisted')

// ---------- 同层多工程的歧义 ----------
W('multi/A.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>')
W('multi/B.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>')
W('multi/F.cs', '// f')

// ---------- 坏工程 ----------
W('broken/Broken.csproj', '<Project><ItemGroup><Compile Include="X.cs"')  // 截断的 XML
W('broken/X.cs', '// x')

// ---------- （r43）跨目录 / 上层目录的显式 Include ----------
W('cross/Shared/Widget.cs', '// widget')
W('cross/App/App.csproj', `<Project ToolsVersion="15.0">
  <ItemGroup>
    <Compile Include="..\\Shared\\Widget.cs" />
    <Compile Include="Local.cs" />
  </ItemGroup>
</Project>`)
W('cross/App/Local.cs', '// local')
W('cross/App/NotListed.cs', '// not listed')

// ---------- （r43）Directory.Build.props 里加编译项 ----------
W('dirprops/Directory.Build.props', `<Project>
  <ItemGroup><Compile Include="FromProps.cs" /></ItemGroup>
</Project>`)
W('dirprops/App/App.csproj', `<Project ToolsVersion="15.0">
  <ItemGroup><Compile Include="Local.cs" /></ItemGroup>
</Project>`)
W('dirprops/App/FromProps.cs', '// 由上层 props 列进编译')
W('dirprops/App/Local.cs', '// local')
W('dirprops/App/Orphan.cs', '// 谁都没列')

// ---------- （r43）Directory.Build.props 关掉 SDK 默认项 ----------
W('sdkprops/Directory.Build.props', `<Project>
  <PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
</Project>`)
W('sdkprops/App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>')
W('sdkprops/App/Lonely.cs', '// SDK 默认项被上层 props 关掉了')

// ---------- （r43）带宏的 Include ⇒ 必须让步给"无法判定" ----------
W('macro/Macro.csproj', `<Project ToolsVersion="15.0">
  <ItemGroup><Compile Include="$(SolutionDir)Shared\\Injected.cs" /></ItemGroup>
</Project>`)
W('macro/Plain.cs', '// 没被列出，但我们不敢说"不在"')

// ---------- （r43）可静态解析的 <Import> ----------
W('imp/Imp.csproj', `<Project ToolsVersion="15.0">
  <Import Project="Extra.items" />
  <ItemGroup><Compile Include="A.cs" /></ItemGroup>
</Project>`)
W('imp/Extra.items', '<Project><ItemGroup><Compile Include="B.cs" /></ItemGroup></Project>')
W('imp/A.cs', '// a')
W('imp/B.cs', '// b（由被导入的文件列进编译）')
W('imp/C.cs', '// c（谁都没列）')

// ---------- （r43）标准框架导入（每个 legacy 工程都有）不该把结论拖成"无法判定" ----------
W('stdimport/Std.csproj', `<Project ToolsVersion="15.0">
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
  <ItemGroup><Compile Include="A.cs" /></ItemGroup>
</Project>`)
W('stdimport/A.cs', '// a')
W('stdimport/Unlisted.cs', '// 没列出 —— 结论仍然必须是确定的 false')

// ---------------------------------------------------------------- 1. 纯函数
{
  check('glob：`**` 跨目录、`*` 不跨目录',
    globToRegExp('**\\Generated\\*.cs').test('Sub/Generated/x.cs') && !globToRegExp('Sub\\*.cs').test('Sub/Deep/x.cs'))
  const items = parseCompileItems('<Compile Include="A.cs" /><Compile Remove="B.cs" /><Compile Include="C.cs" Condition="&apos;x&apos;==&apos;y&apos;" />')
  check('解析出 Include/Remove 与 Condition（条件**保留原样**，不求值）',
    items.length === 3 && items[0].kind === 'include' && items[1].kind === 'remove' && items[2].condition !== null)
}

// ---------------------------------------------------------------- 2. legacy：命中 / 未命中 / 被 Remove
{
  const a = checkCompileMembership(join(root, 'legacy/A.cs'))
  check('legacy：显式列出的文件 ⇒ included=true（basis=explicit-item）', a.ok === true && a.included === true && a.basis === 'explicit-item', JSON.stringify(a))
  const b = checkCompileMembership(join(root, 'legacy/B.cs'))
  check('★ legacy：**没被列出**的文件 ⇒ included=false（这正是"构建通过但文件没编"的陷阱）',
    b.ok === true && b.included === false && b.basis === 'not-listed', JSON.stringify(b))
  check('★ 这条结论自带解释（写明"与构建通过完全相容"）', /构建通过/.test(b.note), b.note)
  const c = checkCompileMembership(join(root, 'legacy/Sub/C.cs'))
  check('legacy：子目录里的显式路径（反斜杠写法）也能命中', c.included === true, JSON.stringify(c))
  const d = checkCompileMembership(join(root, 'legacy/Sub/D.cs'))
  check('legacy：同目录但没列出的 ⇒ false', d.included === false, JSON.stringify(d))
  const g = checkCompileMembership(join(root, 'legacy/Generated/x.cs'))
  check('legacy：通配符 Include 命中', g.included === true, JSON.stringify(g))
  const e = checkCompileMembership(join(root, 'legacy/Excluded.cs'))
  check('★ Remove 优先于 Include（显式排除必须赢）', e.included === false && e.basis === 'removed', JSON.stringify(e))
}

// ---------------------------------------------------------------- 3. SDK 两种
{
  const n = checkCompileMembership(join(root, 'sdk/New.cs'))
  check('SDK：默认 glob ⇒ included=true（basis=sdk-default-glob）', n.included === true && n.basis === 'sdk-default-glob', JSON.stringify(n))
  const u = checkCompileMembership(join(root, 'sdkopt/Unlisted.cs'))
  check('★ SDK 但关了默认项：没显式列出 ⇒ false（basis=sdk-default-disabled）',
    u.included === false && u.basis === 'sdk-default-disabled', JSON.stringify(u))
  const l = checkCompileMembership(join(root, 'sdkopt/Listed.cs'))
  check('SDK 关默认项但显式列出 ⇒ true', l.included === true, JSON.stringify(l))
  check('★ 带 Condition 的条目：结论里**注明条件没被求值**（不许假装有条件求值能力）',
    l.conditionsIgnored >= 1 && /不求值|不\*\*求值/.test(l.note), l.note)
}

// ------------------------------------------- 3b.（r43）编译项不止在 .csproj 里
// 起因：只读 .csproj 时，凡"由 Directory.Build.props / <Import> 列进编译"的文件都会被误判成"不在编译集里"
// （**假 fail**：裁决器把真话判成假话）。这里把每条替代路径都钉成断言。
{
  // ⚠ 这条必须带 repoRoot：源码文件在工程目录**之外**时，"从文件往上找工程"永远找不到
  //   （我第一版就是这么写的，被下面这条 noRoot 断言当场证伪）—— 给了 repoRoot，判定器才会去扫"哪个工程引用了它"。
  const widgetNoRoot = checkCompileMembership(join(root, 'cross/Shared/Widget.cs'))
  check('★ 不给 repoRoot 时如实说"这说明不了它没被编译"，并**告诉调用方：给我 repoRoot 我就去扫**',
    widgetNoRoot.ok === false && widgetNoRoot.reason === 'no-project-found' && /repoRoot/.test(widgetNoRoot.hint), JSON.stringify(widgetNoRoot))
  const widget = checkCompileMembership(join(root, 'cross/Shared/Widget.cs'), { repoRoot: root })
  check('★ 跨目录显式 Include（`..\\Shared\\Widget.cs`，文件在工程目录之外）⇒ included=true',
    widget.ok === true && widget.included === true && widget.basis === 'explicit-item', JSON.stringify(widget))
  check('  并说明"按哪种相对路径解释命中"（MSBuild 版本间不一致，本工具不站队）',
    widget.matchedVia === 'project-dir' && /不站队/.test(widget.pathSemanticsNote || ''), JSON.stringify(widget.matchedVia))
  const notListed = checkCompileMembership(join(root, 'cross/App/NotListed.cs'))
  check('跨目录工程里没列出的文件 ⇒ 仍然是确定的 false（别被上面的放宽带偏）',
    notListed.ok === true && notListed.included === false, JSON.stringify(notListed))
  const nobody = (() => { W('cross/Shared/Nobody.cs', '// 谁都没引用'); return checkCompileMembership(join(root, 'cross/Shared/Nobody.cs'), { repoRoot: root }) })()
  check('★★ 扫完所有工程都没人引用它 ⇒ **确定的 false**（basis=not-referenced-by-any-project），而不是含糊的"找不到工程"',
    nobody.ok === true && nobody.included === false && nobody.basis === 'not-referenced-by-any-project' && nobody.scannedProjects >= 5,
    JSON.stringify(nobody))

  const fromProps = checkCompileMembership(join(root, 'dirprops/App/FromProps.cs'))
  check('★ 由**上层 Directory.Build.props** 列进编译 ⇒ included=true（只读 .csproj 会误判成 false）',
    fromProps.ok === true && fromProps.included === true, JSON.stringify(fromProps))
  check('★ 并如实指出条目声明在哪份文件里（matchedIn 指向 Directory.Build.props）',
    /Directory\.Build\.props$/.test(String(fromProps.matchedIn)) && fromProps.itemSourceCount >= 2, JSON.stringify(fromProps))
  const orphan = checkCompileMembership(join(root, 'dirprops/App/Orphan.cs'))
  check('上层 props 存在但没列它 ⇒ 仍是 false（不是"无法判定"）', orphan.ok === true && orphan.included === false, JSON.stringify(orphan))

  const lonely = checkCompileMembership(join(root, 'sdkprops/App/Lonely.cs'))
  check('★★ `EnableDefaultCompileItems=false` 写在 **Directory.Build.props** 里也认（否则会误报"会进编译"）',
    lonely.ok === true && lonely.included === false && lonely.basis === 'sdk-default-disabled', JSON.stringify(lonely))

  const macro = checkCompileMembership(join(root, 'macro/Plain.cs'))
  check('★★ 带 `$(…)` 宏的编译项 ⇒ **无法判定**（ok:false），绝不判 false',
    macro.ok === false && macro.reason === 'unresolved-item-sources' && macro.included === null, JSON.stringify(macro))
  check('  并点名那个解析不了的宏（不藏在自由文本里）',
    Array.isArray(macro.unresolvedPatterns) && macro.unresolvedPatterns.some((p) => /\$\(SolutionDir\)/.test(p)), JSON.stringify(macro.unresolvedPatterns))
  check('  渲染也走"无法判定"分支并给出下一步', /无法判定/.test(renderMembership(macro)) && /下一步/.test(renderMembership(macro)), renderMembership(macro))

  const imported = checkCompileMembership(join(root, 'imp/B.cs'))
  check('★ 由 `<Import>` 进来的文件列进编译 ⇒ included=true，且说明来自哪个文件',
    imported.ok === true && imported.included === true && /Extra\.items$/.test(String(imported.matchedIn)), JSON.stringify(imported))
  const impC = checkCompileMembership(join(root, 'imp/C.cs'))
  check('Import 链解析得干净时，没列出就是确定的 false', impC.ok === true && impC.included === false, JSON.stringify(impC))

  const std = checkCompileMembership(join(root, 'stdimport/Unlisted.cs'))
  check('★★ 标准框架导入（`$(MSBuildToolsPath)\\Microsoft.CSharp.targets`）**不该**把结论拖成"无法判定"',
    std.ok === true && std.included === false, JSON.stringify(std))
  check('  但它必须**如实登记**在 ignoredStandardImports 里（不是悄悄忽略）',
    Array.isArray(std.ignoredStandardImports) && std.ignoredStandardImports.length === 1 && /Microsoft\.CSharp\.targets/.test(std.ignoredStandardImports[0]),
    JSON.stringify(std.ignoredStandardImports))
  check('  并带一句"为什么可以忽略"的说明', /标准框架导入/.test(String(std.ignoredStandardImportsNote)), String(std.ignoredStandardImportsNote))
  const stdListed = checkCompileMembership(join(root, 'stdimport/A.cs'))
  check('标准导入存在时，显式列出的文件仍然正确判 true', stdListed.ok === true && stdListed.included === true, JSON.stringify(stdListed))
}

// ---------------------------------------------------------------- 4. "读不到" ≠ "不在"
{
  const missing = checkCompileMembership(join(root, 'legacy/DoesNotExist.cs'))
  check('★ 文件不存在 ⇒ ok:false（不是 included:false）', missing.ok === false && missing.reason === 'file-missing', JSON.stringify(missing))
  const noProj = checkCompileMembership(join(root, 'loose/Free.cs'))
  const loose = (() => { W('loose/Free.cs', '// free'); return checkCompileMembership(join(root, 'loose/Free.cs')) })()
  check('★ 找不到工程 ⇒ ok:false + 明说"这说明不了它没被编译"',
    loose.ok === false && loose.reason === 'no-project-found' && /说明不了/.test(loose.error), JSON.stringify(loose))
  const amb = checkCompileMembership(join(root, 'multi/F.cs'))
  check('★ 同层多工程 ⇒ ok:false（歧义）+ 列出候选（而不是随便挑一个）',
    amb.ok === false && amb.reason === 'ambiguous-project' && Array.isArray(amb.candidates) && amb.candidates.length === 2, JSON.stringify(amb))
  const broken = checkCompileMembership(join(root, 'broken/X.cs'))
  check('坏工程（截断 XML）：不抛异常，按"没命中"给出结论', broken.ok === true && broken.included === false, JSON.stringify(broken))
  check('显式指定 project 时不再自动向上找', checkCompileMembership(join(root, 'sdk/New.cs'), { projectPath: join(root, 'legacy/Legacy.csproj') }).included === false)
  void missing; void noProj
}

// ---------------------------------------------------------------- 5. 渲染
{
  const inc = renderMembership(checkCompileMembership(join(root, 'legacy/A.cs')))
  check('渲染：命中时给人话 + 依据', /会进编译/.test(inc) && /依据/.test(inc), inc)
  const bad = renderMembership({ ok: false, error: '读不出来', hint: '检查路径' })
  check('★ 渲染：无法判定时明说"无法判定"+下一步（不许渲染成"不在编译"）', /无法判定/.test(bad) && /下一步/.test(bad), bad)
  check('渲染：不存在的文件走"无法判定"分支', /无法判定/.test(renderMembership(checkCompileMembership(join(root, 'nope.cs')))))
}

rmSync(root, { recursive: true, force: true })
if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 编译成员核对（"不在编译"与"读不到"必须分开）')
