import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const configuredProfile = process.env.DSH_DEV_PROFILE_DIR || process.argv[2]
if (!configuredProfile) throw new Error('Set DSH_DEV_PROFILE_DIR or pass the profile containing the four installed backends')
const profileDir = resolve(configuredProfile)
const requireProfile = createRequire(join(profileDir, 'package.json'))
const iconv = requireProfile('iconv-lite')
const directory = await mkdtemp(join(tmpdir(), 'dsh-dev-mcp-'))
const workspace = join(directory, 'workspace')
await mkdir(workspace)
const client = new Client({ name: 'development-integration', version: '1' })
const evidence = []
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')],
  env: { ...process.env, DSH_DEV_PROFILE_DIR: profileDir, DSH_TOOL_PROFILE: 'dev', DSH_OUTPUT_MAX_TOKENS: '0', DSH_FAILURE_CORPUS_DIR: join(directory, 'failures'), DSH_VERIFY_DIR: join(directory, 'reports'), DSH_TEST: '1' },
  stderr: 'inherit',
})
async function call(name, args = {}, expectSuccess = true) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  const value = JSON.parse(result.content.find(block => block.type === 'text').text)
  assert.equal(value.ok, expectSuccess, JSON.stringify(value))
  assert.equal(result.isError === true, !expectSuccess)
  return value
}
try {
  await client.connect(transport)
  const listed = (await client.listTools()).tools
  const names = ['dev_status', 'dev_csharp', 'dev_logs', 'dev_skills', 'dev_read', 'dev_edit']
  for (const name of names) assert.ok(listed.some(tool => tool.name === name), name)
  assert.equal(listed.find(tool => tool.name === 'dev_read').annotations.readOnlyHint, true)
  assert.equal(listed.find(tool => tool.name === 'dev_edit').annotations.destructiveHint, true)
  assert.equal((await call('dev_status')).state, 'installed')
  evidence.push({ check: 'tools/list', names })
  const found = await call('dev_skills', { query: 'binlog', limit: 10 })
  assert.ok(found.skills.some(skill => skill.name === 'binlog-failure-analysis'))
  assert.match((await call('dev_skills', { name: 'binlog-failure-analysis' })).content, /binlog/i)
  evidence.push({ check: 'dotnet-skills', matches: found.total })
  const log = join(directory, 'sample.log')
  await writeFile(log, '2026-10-25 09:00:00 INFO older\n2026-10-26 09:00:00 INFO 页面加载\n2026-10-26 09:05:00 ERROR 示例错误\n2026-10-26 09:10:00 WARN 示例警告\n')
  const logs = await call('dev_logs', { file: log, timeText: '2026-10-26', timezone: 'Asia/Singapore', maxLines: 2 })
  assert.equal(logs.filter.total_matched, 3)
  assert.equal(logs.filter.lines.length, 2)
  assert.equal(logs.filter.stats.errors, 1)
  assert.match(JSON.stringify(logs.filter.lines), /示例错误/)
  const emptyLogs = await call('dev_logs', { file: log, timeText: '2026-10-24', timezone: 'Asia/Singapore' })
  assert.equal(emptyLogs.filter.total_matched, 0)
  evidence.push({ check: 'log-query', matches: 3, errors: 1 })
  for (const encoding of ['utf8bom', 'gbk']) {
    const file = join(workspace, `${encoding}.txt`)
    const encode = text => encoding === 'gbk' ? iconv.encode(text, 'gbk') : Buffer.from('\uFEFF' + text, 'utf8')
    const original = encode('你好，世界\r\n第二行\r\n')
    await writeFile(file, original)
    const opened = await call('dev_read', { repoRoot: workspace, file, ...(encoding === 'gbk' ? { encoding } : {}) })
    assert.equal(opened.encoding, encoding)
    assert.equal(opened.lineEnding, '\r\n')
    const edit = { repoRoot: workspace, file, encoding, expectedHash: opened.sha256, oldText: '世界', newText: '项目' }
    assert.equal((await call('dev_edit', edit, false)).errorCode, 'DEV_WRITE_NOT_ALLOWED')
    assert.deepEqual(await readFile(file), original)
    await call('dev_edit', { ...edit, allowWrite: true })
    const expected = encode('你好，项目\r\n第二行\r\n')
    assert.deepEqual(await readFile(file), expected)
    assert.equal((await call('dev_edit', { ...edit, allowWrite: true }, false)).errorCode, 'DEV_STALE_FILE')
    assert.deepEqual(await readFile(file), expected)
    evidence.push({ check: 'encoding-edit', encoding, preserved: true, staleRejected: true })
  }
  assert.equal((await call('dev_read', { repoRoot: workspace, file: log }, false)).errorCode, 'DEV_PATH_OUTSIDE_ROOT')
  await writeFile(join(workspace, 'Fixture.csproj'), '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><Configuration>Debug</Configuration><Platform>x86</Platform><ProjectGuid>{421B3F4B-4CCA-4D76-9A19-B3D9C28FAEF1}</ProjectGuid><OutputType>Library</OutputType><AssemblyName>Fixture</AssemblyName><TargetFrameworkVersion>v4.5.2</TargetFrameworkVersion><PlatformTarget>x86</PlatformTarget><OutputPath>bin\\Debug\\</OutputPath></PropertyGroup><ItemGroup><Reference Include="System"/><Reference Include="WindowsBase"/><Reference Include="PresentationCore"/><Reference Include="PresentationFramework"/><Compile Include="Sample.cs"/></ItemGroup><Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets"/></Project>')
  const source = [
    'using System.Windows;',
    'public interface ICalculator { int Add(int left, int right); }',
    'public sealed class Calculator : ICalculator { public int Add(int left, int right) { return left + right; } }',
    'public sealed class Demo { public int Calculate() {',
    '    ICalculator calculator = new Calculator();',
    '    Thickness margin = new Thickness(1);',
    '    return calculator.Add(1, 2) + (int)margin.Left;',
    '} }',
  ]
  await writeFile(join(workspace, 'Sample.cs'), source.join('\n'))
  for (const [operation, line, symbol] of [['goToDefinition', 7, 'Add'], ['findReferences', 2, 'Add'], ['goToImplementation', 2, 'Add'], ['hover', 6, 'Thickness']]) {
    const result = await call('dev_csharp', { repoRoot: workspace, file: 'Sample.cs', operation, line, character: source[line - 1].indexOf(symbol) + 1, timeoutMs: 90000 })
    if (operation === 'hover') assert.match(result.hover?.contents || '', /System\.Windows\.Thickness/)
    else assert.ok(result.locations.length > 0, JSON.stringify(result))
    evidence.push({ check: 'csharp-lsp', operation, found: operation === 'hover' ? true : result.locations.length })
  }
  console.log(JSON.stringify({ passed: true, evidence }, null, 2))
} finally {
  await client.close()
  await rm(directory, { recursive: true, force: true })
}
