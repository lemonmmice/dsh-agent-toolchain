// 工程 XML/依赖身份缓存：同参且文件未变时命中缓存（返回同一对象），.csproj 变更后失效重算并反映新内容。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { collectItemSources } from './compile-membership.mjs'

const dir = mkdtempSync(join(tmpdir(), 'cc-cache-'))
try {
  const proj = join(dir, 'App.csproj')
  const props = join(dir, 'Shared.props')
  writeFileSync(props, '<Project><PropertyGroup><X>1</X></PropertyGroup></Project>\n')
  writeFileSync(proj, '<?xml version="1.0"?>\n<Project ToolsVersion="4.0"><ItemGroup><Compile Include="A.cs" /></ItemGroup></Project>\n')

  const r1 = collectItemSources(proj, { repoRoot: dir })
  const r2 = collectItemSources(proj, { repoRoot: dir })
  assert.strictEqual(r1, r2, '同参且文件未变 → 命中缓存，返回同一对象（未重读 XML）')
  assert.ok(r1.sources.some((s) => s.role === 'project'), 'sources 含工程本身')

  // 改 .csproj：加一个 Import 到存在的 props；缓存应失效、重算并解析出该 import 源
  writeFileSync(proj, '<?xml version="1.0"?>\n<Project ToolsVersion="4.0"><Import Project="Shared.props" /><ItemGroup><Compile Include="A.cs" /></ItemGroup></Project>\n')
  const r3 = collectItemSources(proj, { repoRoot: dir })
  assert.notStrictEqual(r3, r1, '.csproj 变更 → 缓存失效，重算出新对象')
  assert.ok(r3.sources.some((s) => s.path === props), '重算解析出新增的 Import 源')

  console.log('PASS: compile-membership project-XML cache (hit when unchanged, invalidate on .csproj change)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
