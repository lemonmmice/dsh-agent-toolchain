import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

if (process.platform !== 'win32') throw new Error('The ETW analyzer build is supported on Windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const result = spawnSync('dotnet', [
  'publish', join(root, 'plugins/dsh-perf/tools/uifreeze/UiFreezeStacks.csproj'),
  '-c', 'Release', '--self-contained', 'false',
  '-o', join(root, 'plugins/dsh-perf/bin/uifreeze'),
], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log('Built UiFreezeStacks with CPU breakdown support. Reconnect hosts after deploying source changes.')
