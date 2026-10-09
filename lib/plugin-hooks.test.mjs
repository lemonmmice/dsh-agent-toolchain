// 插件钩子（编译集检查 / 会话开始提示）与本机配置文件的离线自测：node lib/plugin-hooks.test.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCompileCheckHook } from './compile-check-hook.mjs'
import { buildSessionContext, runSessionStartHook, looksLikeDotnetRepo } from './session-start-hook.mjs'
import { readEnvFile, applyEnvFile } from './toolchain-env-file.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }
const tmp = mkdtempSync(join(tmpdir(), 'plugin-hooks-'))

try {
  // ---- 编译集检查：legacy csproj + 漏列的新 .cs → 提醒；已列 / SDK 工程 / 非源码 → 静默
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'App', 'Views'), { recursive: true })
  writeFileSync(join(repo, 'App', 'App.csproj'), `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Compile Include="Views\\Listed.cs" />
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
</Project>`, 'utf8')
  writeFileSync(join(repo, 'App', 'Views', 'Listed.cs'), 'class Listed {}', 'utf8')
  writeFileSync(join(repo, 'App', 'Views', 'Forgotten.cs'), 'class Forgotten {}', 'utf8')
  const stateDir = join(tmp, 'state')
  const hook = (tool_name, file_path, session_id = 's1') => runCompileCheckHook(JSON.stringify({ session_id, tool_name, tool_input: { file_path }, cwd: repo }), { stateDir })

  const warn = hook('Write', join(repo, 'App', 'Views', 'Forgotten.cs'))
  ok(warn?.hookSpecificOutput?.hookEventName === 'PostToolUse' && /不在编译集里/.test(warn.hookSpecificOutput.additionalContext), '漏列的新 .cs → PostToolUse additionalContext 提醒')
  ok(/Compile Include="Views[\\/]Forgotten\.cs"/.test(warn?.hookSpecificOutput?.additionalContext ?? ''), '提醒里给出要加的 <Compile Include>')
  ok(hook('Write', join(repo, 'App', 'Views', 'Forgotten.cs')) === null, '同一会话同一文件只提醒一次')
  ok(hook('Edit', join(repo, 'App', 'Views', 'Forgotten.cs'), 's2') !== null, '换一个会话会再提醒')
  ok(hook('Write', join(repo, 'App', 'Views', 'Listed.cs')) === null, '已列进编译的文件 → 静默')
  ok(hook('Write', join(repo, 'App', 'readme.md')) === null, '非源码文件 → 静默')
  ok(hook('Read', join(repo, 'App', 'Views', 'Forgotten.cs'), 's3') === null, '非写入工具 → 静默')
  const sdk = join(tmp, 'sdk')
  mkdirSync(join(sdk, '.git'), { recursive: true })
  writeFileSync(join(sdk, 'Sdk.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>', 'utf8')
  writeFileSync(join(sdk, 'New.cs'), 'class New {}', 'utf8')
  ok(runCompileCheckHook(JSON.stringify({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: join(sdk, 'New.cs') }, cwd: sdk }), { stateDir }) === null, 'SDK 风格工程（默认 glob 包含）→ 静默')
  ok(runCompileCheckHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(tmp, 'orphan', 'X.cs') } }), { stateDir }) === null, '判不了（文件不存在 / 找不到工程）→ 静默')
  ok(runCompileCheckHook('not json', { stateDir }) === null, '坏输入 → 静默')

  // ---- 本机配置文件
  const envFile = join(tmp, 'env.json')
  writeFileSync(envFile, '\uFEFF' + JSON.stringify({ DSH_UI_PROC_NAME: 'DemoClient', DSH_PERF_SRC_ROOT: repo, OTHER_SECRET: 'x', DSH_NUM: 3, DSH_CRED_api: 'token' }), 'utf8')
  const r = readEnvFile(envFile)
  ok(r.values.DSH_UI_PROC_NAME === 'DemoClient' && !('OTHER_SECRET' in r.values) && !('DSH_NUM' in r.values), '只收 DSH_* 字符串值（带 BOM 也能读）')
  ok(Array.isArray(r.rejected) && r.rejected.includes('OTHER_SECRET'), '被拒的键如实列出')
  ok(!('DSH_CRED_api' in r.values) && r.rejected.includes('DSH_CRED_api'), 'DSH_CRED_* 凭据拒收（凭据不进这个文件）')
  // 与旧 MCP 注册的 env 块同语义：文件覆盖继承来的进程环境（否则插件版会悄悄换一个目标客户端）
  const env = { DSH_ENV_FILE: envFile, DSH_UI_PROC_NAME: 'InheritedFromUserEnv', DSH_OTHER: 'kept' }
  const applied = applyEnvFile(env)
  ok(env.DSH_UI_PROC_NAME === 'DemoClient' && applied.overridden.includes('DSH_UI_PROC_NAME'), '文件覆盖继承来的同名环境变量，并如实报出被覆盖的键')
  ok(env.DSH_PERF_SRC_ROOT === repo && applied.applied.includes('DSH_PERF_SRC_ROOT'), '缺的键从文件补上')
  ok(env.DSH_OTHER === 'kept', '文件里没有的键不受影响')
  const off = { DSH_ENV_FILE: 'none', DSH_UI_PROC_NAME: 'X' }
  ok(applyEnvFile(off).applied.length === 0 && off.DSH_UI_PROC_NAME === 'X', 'DSH_ENV_FILE=none：不读文件')
  writeFileSync(join(tmp, 'bad.json'), '{ nope', 'utf8')
  const bad = applyEnvFile({ DSH_ENV_FILE: join(tmp, 'bad.json') })
  ok(typeof bad.error === 'string' && bad.applied.length === 0, '坏文件：报错且一个值都不套用')
  ok(readEnvFile(join(tmp, 'missing.json')).exists === false, '文件不存在 = 没配置（不是错误）')

  // ---- 会话开始提示
  ok(looksLikeDotnetRepo(repo) === true && looksLikeDotnetRepo(join(tmp, 'state')) === false, '识别 .NET 仓库（有界扫描）')
  const inRoot = buildSessionContext({ cwd: repo, env: { DSH_ENV_FILE: envFile, DSH_NO_ENV_FALLBACK: '1' } })
  ok(/目标进程：DemoClient/.test(inRoot) && !/不在已配置的源码根内/.test(inRoot), '会话在已配置源码根内：报目标、不报错配')
  const inherited = buildSessionContext({ cwd: repo, env: { DSH_ENV_FILE: envFile, DSH_NO_ENV_FALLBACK: '1', DSH_UI_PROC_NAME: 'InheritedFromUserEnv' } })
  ok(/目标进程：DemoClient/.test(inherited), '与启动器同口径：报的是文件覆盖后的目标（MCP server 实际会作用的那个）')
  const otherRepo = join(tmp, 'other')
  mkdirSync(otherRepo, { recursive: true })
  writeFileSync(join(otherRepo, 'Other.sln'), '', 'utf8')
  const mismatch = buildSessionContext({ cwd: otherRepo, env: { DSH_ENV_FILE: envFile, DSH_NO_ENV_FALLBACK: '1' } })
  ok(/不在已配置的源码根内/.test(mismatch), '会话开在另一个 .NET 仓库：明确提醒 UI/性能工具会作用到别的进程上')
  const unconfigured = buildSessionContext({ cwd: otherRepo, env: { DSH_ENV_FILE: join(tmp, 'missing.json'), DSH_NO_ENV_FALLBACK: '1' } })
  ok(/目标进程未配置/.test(unconfigured), '没配置目标：如实说未配置')
  ok(buildSessionContext({ cwd: join(tmp, 'state'), env: { DSH_ENV_FILE: envFile, DSH_NO_ENV_FALLBACK: '1' } }) === null, '不相关目录：静默')
  const out = runSessionStartHook(JSON.stringify({ cwd: repo, source: 'startup' }), { DSH_ENV_FILE: envFile, DSH_NO_ENV_FALLBACK: '1' })
  ok(out?.hookSpecificOutput?.hookEventName === 'SessionStart' && typeof out.hookSpecificOutput.additionalContext === 'string', '钩子输出 SessionStart additionalContext')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: plugin hooks + env file' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
