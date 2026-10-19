import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(process.execPath, ['scripts/export-native-tools.mjs', '--check'])
const targetDir = join(root, '.dsh-agent-toolchain/native')
const env = { ...process.env }
if (process.platform === 'win32') env.RUSTFLAGS = [env.RUSTFLAGS, '-C target-feature=+crt-static'].filter(Boolean).join(' ')
run('cargo', ['build', '--release', '--locked', '--manifest-path', 'native/toolchain/Cargo.toml', '--target-dir', targetDir], env)
const executable = 'dsh-toolchain' + (process.platform === 'win32' ? '.exe' : '')
const destination = join(root, 'mcp/bin', `${process.platform}-${process.arch}`)
mkdirSync(destination, { recursive: true })
copyFileSync(join(targetDir, 'release', executable), join(destination, executable))
console.log('Built standalone Rust MCP runtime: ' + join(destination, executable))
