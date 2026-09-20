import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowsProcessInspector, defaultTableExec, parseTable, processTableExecutable } from '../lib/inspector.js'
import { powershellTable } from './powershell-table.mjs'

// Missing identities must never match, even if both strings happen to be empty.
{
  let now = 1000, reads = 0
  const signaled = []
  const inspector = new WindowsProcessInspector({
    exec: () => { reads++; return JSON.stringify([{ pid: 42, ppid: 1, session: null, created: null }]) },
    now: () => now,
    kill: (...args) => signaled.push(args),
    taskkill: (...args) => signaled.push(args),
  })
  const identity = { pid: 42, started: '' }
  assert.equal(inspector.foregroundPgid(42), 42, 'unknown identity does not hide a present PID')
  assert.equal(inspector.isAlive(identity), false)
  assert.equal(inspector.snapshot().alive(identity), false)
  inspector.signalProcess(identity, 'SIGTERM')
  assert.deepEqual(signaled, [])
  assert.equal(reads, 1, 'all queries share the cached table')
  now += 301
  inspector.processTable()
  assert.equal(reads, 2, 'expired cache refreshes')
  const terminalWrites = []
  inspector.attach({ write: value => terminalWrites.push(value) })
  inspector.signalGroup(42, 'SIGINT')
  assert.deepEqual(terminalWrites, ['\x03'], 'ConPTY interrupt stays in JS')
}

if (process.platform !== 'win32') {
  console.log('PASS native backend offline contract; SKIP Windows integration on this platform')
} else {
  const taskDir = mkdtempSync(join(tmpdir(), 'dsh-native-backend-'))
  let child
  try {
    assert.throws(() => defaultTableExec(join(taskDir, 'missing.exe')), /build:terminal-inspector/)
    const badArgs = spawnSync(processTableExecutable(), ['unexpected'], { encoding: 'utf8', windowsHide: true })
    assert.equal(badArgs.status, 1)
    assert.equal(badArgs.stdout, '', 'helper failure must not emit a successful table')
    assert.match(badArgs.stderr, /usage:/)

    child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) })
    const before = parseTable(defaultTableExec())
    const reference = parseTable(powershellTable())
    const after = parseTable(defaultTableExec())
    for (const pid of [process.pid, child.pid]) {
      const a = before.find(row => row.pid === pid)
      const b = reference.find(row => row.pid === pid)
      const c = after.find(row => row.pid === pid)
      assert.ok(a?.started && b?.started && c?.started, 'owned processes have identities')
      assert.deepEqual(a, b, 'native PID, parent, session and creation time match CIM')
      assert.deepEqual(a, c, 'identity remains stable across snapshots')
    }
    assert.equal(after.find(row => row.pid === child.pid).parentPid, process.pid)
    const inspector = new WindowsProcessInspector({ ttlMs: 0 })
    const identity = { pid: child.pid, started: after.find(row => row.pid === child.pid).started }
    assert.equal(inspector.snapshot().alive({ ...identity, started: 'wrong-identity' }), false)
    const exited = once(child, 'exit')
    child.kill()
    await exited
    assert.equal(inspector.isAlive(identity), false, 'exited child disappears')

    // Exercise the real deploy script in an isolated miniature checkout.
    // Missing binaries must fail before any profile copy; a complete deployment
    // must resolve its own executable independently of cwd, including spaces.
    const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
    const source = join(taskDir, 'source')
    const pluginSource = join(source, 'plugins', 'dsh-win-terminal-inspector')
    cpSync(join(pluginRoot, 'lib'), join(pluginSource, 'lib'), { recursive: true })
    cpSync(join(pluginRoot, 'package.json'), join(pluginSource, 'package.json'))
    mkdirSync(join(source, 'scripts'), { recursive: true })
    const deployScript = join(source, 'scripts', 'deploy-plugins.mjs')
    cpSync(fileURLToPath(new URL('../../../scripts/deploy-plugins.mjs', import.meta.url)), deployScript)
    const profile = join(taskDir, 'profile with spaces')
    mkdirSync(profile)
    const deploy = () => spawnSync(process.execPath, [deployScript, '--profile', profile, '--only', 'dsh-win-terminal-inspector'], {
      cwd: taskDir, encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    const missingBinary = deploy()
    assert.equal(missingBinary.status, 2)
    assert.match(missingBinary.stderr, /build:terminal-inspector/)
    assert.equal(existsSync(join(profile, 'plugins')), false, 'failed preflight writes no plugin')
    cpSync(join(pluginRoot, 'bin'), join(pluginSource, 'bin'), { recursive: true })
    const deployedResult = deploy()
    assert.equal(deployedResult.status, 0, deployedResult.stderr)
    const deployed = join(profile, 'plugins', 'dsh-win-terminal-inspector')
    const probe = 'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]).href);if(!m.parseTable(m.defaultTableExec()).some(p=>p.pid===process.pid))process.exit(1)'
    const env = { ...process.env }
    delete env.DSH_TERMINAL_PROCESS_TABLE_EXE
    const copied = spawnSync(process.execPath, ['--input-type=module', '-e', probe, join(deployed, 'lib', 'inspector.js')], {
      cwd: taskDir, env, encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    assert.equal(copied.status, 0, copied.stderr)
    console.log('PASS native backend: CIM parity, PID identity, exit detection, cache, errors, ConPTY routing, deployment preflight and copied plugin')
  } finally {
    if (child && child.exitCode === null) child.kill()
    if (dirname(resolve(taskDir)) !== resolve(tmpdir())) throw new Error('Unexpected test cleanup path')
    rmSync(taskDir, { recursive: true, force: true })
  }
}
