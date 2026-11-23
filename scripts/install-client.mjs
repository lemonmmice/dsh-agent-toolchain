import { cpSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync, realpathSync, unlinkSync, statSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { planClientConfigs, writeWithBackup, applyConfigPlans } from './lib/client-config.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const argumentsList = process.argv.slice(2)
const option = name => {
  const index = argumentsList.indexOf('--' + name)
  if (index < 0) return undefined
  if (!argumentsList[index + 1] || argumentsList[index + 1].startsWith('--')) throw new Error('Missing --' + name + ' value')
  return argumentsList[index + 1]
}
const interactive = !argumentsList.includes('--non-interactive')
const userHome = resolve(option('home') || homedir())
const appData = resolve(option('app-data') || process.env.APPDATA || join(userHome, 'AppData', 'Roaming'))
const codexHome = option('codex-home') || process.env.CODEX_HOME || join(userHome, '.codex')
const settingsDirectory = join(userHome, '.dsh-agent-toolchain')
const envPath = join(settingsDirectory, 'env.json')
const previousEnvText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const previous = previousEnvText ? JSON.parse(previousEnvText.replace(/^\uFEFF/, '')) : {}
if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Existing env.json must be an object')
const cli = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null

async function ask(prompt, fallback) {
  if (!cli) return fallback
  const answer = (await cli.question(prompt)).trim()
  return answer || fallback
}

async function run(command, args, cwd, env = process.env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error('Verification failed, exit ' + code)))
  })
}

try {
  console.log('DSH 工具链独立安装：Claude Code / Claude Desktop / Codex')
  const choice = option('clients') || await ask('安装到：1 全部（默认） / 2 Claude Code / 3 Claude Desktop / 4 Codex：', '1')
  const clients = ({ '1': ['claude-code', 'claude-desktop', 'codex'], all: ['claude-code', 'claude-desktop', 'codex'], '2': ['claude-code'], '3': ['claude-desktop'], '4': ['codex'] })[choice] || choice.split(',')
  const exe = (option('exe') || await ask('目标程序 EXE 完整路径（可留空，稍后配置）：', previous.DSH_UI_CLIENT_EXE || '')).replace(/^"|"$/g, '')
  const repo = (option('repo') || await ask('要分析/构建的源码目录（可留空）：', previous.DSH_BUILD_CLIENT_ROOT || '')).replace(/^"|"$/g, '')
  if (exe && (!existsSync(exe) || !statSync(exe).isFile() || !/\.exe$/i.test(exe))) throw new Error('EXE 路径无效：' + exe)
  if (repo && (!existsSync(repo) || !statSync(repo).isDirectory())) throw new Error('源码目录不存在：' + repo)
  const manifestPath = join(source, 'standalone-manifest.json')
  const inPlace = argumentsList.includes('--in-place')
  if (!inPlace && !existsSync(manifestPath)) throw new Error('请使用 Releases 中的 Windows 完整包，或先运行 npm run package:windows。源码调试可用 --in-place。')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { buildId: 'source' }
  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.buildId)) throw new Error('Invalid package build ID')
  const installationRoot = resolve(option('install-dir') || join(process.env.LOCALAPPDATA || join(userHome, 'AppData', 'Local'), 'dsh-agent-toolchain'))
  const installRoot = inPlace ? source : join(installationRoot, 'versions', manifest.buildId)
  const sourceRelative = relative(source, installRoot)
  if (!inPlace && sourceRelative && !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) throw new Error('安装目录需要位于解压目录之外。')
  const nodePath = inPlace ? process.execPath : join(installRoot, 'runtime', 'node.exe')
  const entry = { command: nodePath, args: [join(installRoot, 'mcp', 'standalone.mjs')], env: { DSH_ENV_FILE: envPath } }
  const plans = planClientConfigs({ home: userHome, appData, codexHome, claudeConfigDir: option('claude-config-dir') || process.env.CLAUDE_CONFIG_DIR, clients, entry })
  if (!inPlace && resolve(source) !== resolve(installRoot)) {
    if (existsSync(installRoot)) {
      const installedManifest = join(installRoot, 'standalone-manifest.json')
      if (!existsSync(installedManifest) || readFileSync(installedManifest, 'utf8') !== readFileSync(manifestPath, 'utf8')) throw new Error('安装目录已存在但版本不一致：' + installRoot)
    } else {
      console.log('复制独立运行包…')
      mkdirSync(dirname(installRoot), { recursive: true })
      const staging = installRoot + '.installing-' + randomUUID()
      cpSync(source, staging, { recursive: true, errorOnExist: true, force: false })
      renameSync(staging, installRoot)
    }
  }
  const dataRoot = settingsDirectory
  const values = {
    ...previous,
    DSH_STANDALONE: '1',
    DSH_NO_ENV_FALLBACK: '1',
    DSH_CAPTURE_BACKEND: 'standalone',
    DSH_CAPTURE_SERVICE_DIR: join(dataRoot, 'capture-service'),
    DSH_API_CAPTURE_STORE: previous.DSH_API_CAPTURE_STORE || join(dataRoot, 'capture'),
    DSH_UI_PROC_NAME: exe ? basename(exe).replace(/\.exe$/i, '') : previous.DSH_UI_PROC_NAME || '',
    DSH_UI_CLIENT_EXE: exe ? resolve(exe) : '',
    DSH_UI_WINDOW_NAME: previous.DSH_UI_WINDOW_NAME || '',
    DSH_BUILD_CLIENT_ROOT: repo ? resolve(repo) : '',
    DSH_BUILD_REPO_ROOT: repo ? resolve(repo) : '',
    DSH_BUILD_CLIENT_PROC: exe ? basename(exe).replace(/\.exe$/i, '') : '',
    DSH_HANG_SRC_ROOT: repo ? resolve(repo) : '',
    DSH_PERF_SRC_ROOT: repo ? resolve(repo) : '',
    DSH_UI_EVIDENCE_DIR: join(dataRoot, 'ui-evidence'),
    DSH_PERF_EVIDENCE_DIR: join(dataRoot, 'perf-evidence'),
    DSH_HANG_EVIDENCE_DIR: join(dataRoot, 'hang-evidence'),
    DSH_MEMORY_DIR: join(dataRoot, 'memory'),
    DSH_FAILURE_CORPUS_DIR: join(dataRoot, 'failures'),
    DSH_TOOL_PROFILE: '',
  }
  const components = {
    DSH_PERF_UIFREEZE: 'plugins/dsh-perf/bin/uifreeze/UiFreezeStacks.exe',
    DSH_PERF_DUMPSTACK: 'tools/dumpstack/publish-x86/DumpStack.exe',
    DSH_HANG_DUMPSTACK: 'tools/dumpstack/publish-x86/DumpStack.exe',
    DSH_PERF_HEAPROOTS: 'tools/heaproots/publish-x86/HeapRoots.exe',
  }
  for (const [key, path] of Object.entries(components)) if (existsSync(join(installRoot, path))) values[key] = join(installRoot, path)
  for (const key of ['DSH_UI_EVIDENCE_DIR', 'DSH_PERF_EVIDENCE_DIR', 'DSH_HANG_EVIDENCE_DIR', 'DSH_MEMORY_DIR', 'DSH_FAILURE_CORPUS_DIR']) mkdirSync(values[key], { recursive: true })
  const frameworkDirectory = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319')
  if (existsSync(join(frameworkDirectory, 'mscordacwks.dll'))) {
    values.DSH_PERF_DAC_DIR ||= frameworkDirectory
    values.DSH_HANG_DAC_DIR ||= frameworkDirectory
  }
  const proposedEnv = JSON.stringify(values, null, 2) + '\n'
  mkdirSync(settingsDirectory, { recursive: true })
  const temporaryEnv = join(settingsDirectory, 'install-check-env-' + manifest.buildId + '.json')
  writeFileSync(temporaryEnv, proposedEnv, { mode: 0o600 })
  console.log('验证 MCP 握手、工具发现和真实只读调用…')
  try {
    await run(nodePath, [join(installRoot, 'mcp', 'install-check.mjs'), temporaryEnv, join(settingsDirectory, 'install-check.json')], installRoot)
  } finally {
    unlinkSync(temporaryEnv)
  }
  if (previous.DSH_STANDALONE === '1') {
    await run(nodePath, [join(installRoot, 'mcp', 'standalone.mjs'), '--stop-capture-service'], installRoot, { ...process.env, DSH_ENV_FILE: envPath })
  }
  const changes = applyConfigPlans([{ path: envPath, before: previousEnvText, after: proposedEnv }, ...plans])
  if (clients.includes('claude-code') || clients.includes('codex')) {
    const skillRoots = []
    if (clients.includes('claude-code')) skillRoots.push(join(option('claude-config-dir') || process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'), 'skills'))
    if (clients.includes('codex')) skillRoots.push(join(userHome, '.agents', 'skills'))
    for (const skillRoot of skillRoots) {
      for (const name of readdirSync(join(installRoot, 'skills'))) {
        const destination = join(skillRoot, name)
        if (existsSync(destination)) {
          console.log('保留已有技能：' + destination)
          continue
        }
        mkdirSync(skillRoot, { recursive: true })
        cpSync(join(installRoot, 'skills', name), destination, { recursive: true, force: false, errorOnExist: true })
      }
    }
  }
  writeWithBackup(join(settingsDirectory, 'installation.json'), JSON.stringify({ version: manifest.buildId, root: realpathSync(installRoot), clients, changes }, null, 2) + '\n')
  console.log('\n安装成功。请完全退出并重新打开选中的客户端。')
  console.log('在新会话输入：使用 DSH 的 toolchain_status 检查环境。')
  console.log('本机配置：' + envPath)
  for (const change of changes) console.log((change.changed ? '已更新：' : '无需变更：') + change.path)
  console.log('ETW 实时采集需管理员权限及 Windows Performance Toolkit；转储采集需 ProcDump。未就绪项见 install-check.json。')
} finally {
  cli?.close()
}
