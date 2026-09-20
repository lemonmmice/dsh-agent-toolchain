import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const targets = {
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
}
const target = targets[process.platform]?.[process.arch]
if (!target) throw new Error('Unsupported memory-store platform: ' + process.platform + '-' + process.arch)
const targetDir = join(root, '.dsh-agent-toolchain', 'native')
const env = { ...process.env }
if (process.platform === 'win32') env.RUSTFLAGS = [env.RUSTFLAGS, '-C target-feature=+crt-static'].filter(Boolean).join(' ')
const result = spawnSync('cargo', [
  'build', '--release', '--locked', '--manifest-path', join(root, 'native', 'memory-store', 'Cargo.toml'),
  '--target', target, '--target-dir', targetDir,
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
if (result.error) throw new Error('Cannot run cargo. Install Rust and platform build tools.', { cause: result.error })
if (result.status !== 0) process.exit(result.status ?? 1)
const library = process.platform === 'win32' ? 'dsh_memory_store.dll'
  : process.platform === 'darwin' ? 'libdsh_memory_store.dylib' : 'libdsh_memory_store.so'
const bin = join(root, 'plugins', 'dsh-memory', 'bin', `${process.platform}-${process.arch}`)
mkdirSync(bin, { recursive: true })
copyFileSync(join(targetDir, target, 'release', library), join(bin, 'memory-store.node'))
console.log('Built memory-store Node-API module: ' + join(bin, 'memory-store.node'))
