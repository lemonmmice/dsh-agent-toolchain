// lib/config-defaults.test.mjs — regression guard for the "empty string is not
// a config" trap.
//
// Callers habitually write `logsDir: process.env.DSH_BUILD_LOGS_DIR || ''` (the
// MCP server does exactly that). Spread over a default, an empty string erases
// it: build_run died with `ENOENT: mkdir ''`, perf_probe wrote evidence into a
// relative dir under the caller's cwd. These tests pin the fallback behavior.
import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { makePerf } from '../plugins/dsh-perf/lib/perf.mjs'
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const home = homedir()

// ---- dsh-build
{
  const b = makeBuilder({ logsDir: '', msbuild: '', clientRoot: '', repoRoot: '' })
  check('builder: empty logsDir falls back to the default dir', b.config.logsDir === join(home, '.dsh-agent-toolchain', 'build-logs'), b.config.logsDir)
  check('builder: empty msbuild falls back to auto-detect (non-empty)', typeof b.config.msbuild === 'string' && b.config.msbuild.length > 0)
  const b2 = makeBuilder({ logsDir: 'C:\\custom-logs' })
  check('builder: explicit logsDir is honored', b2.config.logsDir === 'C:\\custom-logs')
}

// ---- dsh-perf
{
  const p = makePerf({ evidenceDir: '', procdump: '', dumpstack: '', dacDir: '', srcRoot: '' })
  check('perf: empty evidenceDir falls back to the default dir', p.config.evidenceDir === join(home, '.dsh-agent-toolchain', 'perf-evidence'), p.config.evidenceDir)
  check('perf: empty procdump falls back to the bundled path', typeof p.config.procdump === 'string' && p.config.procdump.length > 0)
  check('perf: empty dacDir falls back to the bundled path', typeof p.config.dacDir === 'string' && p.config.dacDir.length > 0)
}

// ---- dsh-ui-drive
{
  const d = makeDriver({ scriptsDir: '', evidenceDir: '' })
  check('ui-drive: empty evidenceDir falls back to the default dir', d.config.evidenceDir === join(home, '.dsh-agent-toolchain', 'ui-evidence'), d.config.evidenceDir)
  check('ui-drive: empty scriptsDir falls back to the plugin scripts dir', /dsh-ui-drive[\\/]scripts$/.test(d.scriptsDir()), d.scriptsDir())
  d.warmShutdown()
}

console.log(failures === 0 ? '\nPASS: config-defaults test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
