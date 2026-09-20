// Build the Rust helper and stage only its executable inside the plugin.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const targets = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc', ia32: 'i686-pc-windows-msvc' }
if (process.platform !== 'win32' || !targets[process.arch]) {
  throw new Error('Build the terminal inspector on Windows with a supported Node architecture (x64, arm64, ia32).')
}
const target = targets[process.arch]
const targetDir = join(root, '.dsh-agent-toolchain', 'native')
const result = spawnSync('cargo', [
  'build', '--release', '--locked', '--manifest-path', join(root, 'native', 'windows-process-table', 'Cargo.toml'),
  '--target', target, '--target-dir', targetDir,
], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  // Ship a standalone helper; do not require a separate VC++ redistributable.
  env: { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, '-C target-feature=+crt-static'].filter(Boolean).join(' ') },
})
if (result.error) throw new Error('Cannot run cargo. Install the Rust MSVC toolchain and Visual C++ build tools.', { cause: result.error })
if (result.status !== 0) process.exit(result.status ?? 1)
const binDir = join(root, 'plugins', 'dsh-win-terminal-inspector', 'bin', `win32-${process.arch}`)
mkdirSync(binDir, { recursive: true })
const output = join(binDir, 'dsh-process-table.exe')
copyFileSync(join(targetDir, target, 'release', 'dsh-process-table.exe'), output)
console.log('Built terminal process-table helper: ' + output)
