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
if (!target) throw new Error('Unsupported capture-store build platform: ' + process.platform + '-' + process.arch)
const targetDir = join(root, '.dsh-agent-toolchain', 'native')
const env = { ...process.env }
if (process.platform === 'win32') env.RUSTFLAGS = [env.RUSTFLAGS, '-C target-feature=+crt-static'].filter(Boolean).join(' ')
const result = spawnSync('cargo', [
  'build', '--release', '--locked', '--manifest-path', join(root, 'native', 'capture-store', 'Cargo.toml'),
  '--target', target, '--target-dir', targetDir,
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
if (result.error) throw new Error('Cannot run cargo. Install Rust and the platform linker/build tools.', { cause: result.error })
if (result.status !== 0) process.exit(result.status ?? 1)
const library = process.platform === 'win32' ? 'dsh_capture_store.dll'
  : process.platform === 'darwin' ? 'libdsh_capture_store.dylib' : 'libdsh_capture_store.so'
const bin = join(root, 'plugins', 'dsh-api-visualizer', 'bin', `${process.platform}-${process.arch}`)
mkdirSync(bin, { recursive: true })
copyFileSync(join(targetDir, target, 'release', library), join(bin, 'capture-store.node'))
console.log('Built capture-store Node-API module: ' + join(bin, 'capture-store.node'))
