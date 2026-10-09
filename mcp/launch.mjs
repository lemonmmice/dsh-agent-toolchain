#!/usr/bin/env node
/**
 * MCP 启动器（插件安装方式的入口；直接 `node mcp/server.mjs` 的老方式不受影响）。
 *
 *   1. 载入本机配置文件（lib/toolchain-env-file.mjs：默认 ~/.dsh-agent-toolchain/env.json；
 *      与旧的 MCP 注册 env 块同语义 —— 覆盖继承来的同名环境变量）；
 *   2. 首次启动时补齐依赖：插件从 git 仓库装下来时没有 node_modules（MCP SDK 是唯一的运行期依赖）；
 *   3. 启动 server.mjs。
 *
 * stdout 是 MCP 协议通道，这里的任何提示都只写 stderr；npm 的输出也重定向到 stderr。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyEnvFile } from '../lib/toolchain-env-file.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const log = (s) => process.stderr.write('[dsh-agent-toolchain] ' + s + '\n')

const env = applyEnvFile(process.env)
if (env.error) log(env.error + '（' + env.path + '）—— 本次不使用该文件')
if (env.rejected) log('env 文件里这些键被忽略（只接受 DSH_* 字符串，DSH_CRED_* 凭据不收）：' + env.rejected.join(', '))
if (env.overridden.length) log('env 文件覆盖了继承来的环境变量：' + env.overridden.join(', '))

const sdk = join(here, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')
if (!existsSync(sdk)) {
  log('首次启动：安装 MCP 依赖（npm ci --omit=dev）…')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: here,
    stdio: ['ignore', 2, 2],
    shell: process.platform === 'win32', // Node 新版本要求 .cmd 经 shell 启动
  })
  if (r.status !== 0 || !existsSync(sdk)) {
    log('依赖安装失败：请在插件目录手动执行 `npm install --prefix mcp` 后重启客户端。')
    process.exit(1)
  }
}

await import(pathToFileURL(join(here, 'server.mjs')).href)
