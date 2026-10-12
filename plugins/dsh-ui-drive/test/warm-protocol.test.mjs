// @heavy-test —— 真机/真进程重型用例（2026-10-12 全量剖面：单文件 >10s；14 个重型文件占全量 78% 时间）。默认层不跑，`npm test -- --all` 跑全量。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
if (process.platform !== 'win32' || !fs.existsSync(powershell)) {
  console.log('SKIP warm protocol requires Windows PowerShell 5.1')
  process.exit(0)
}

const scriptPath = path.resolve(import.meta.dirname, '../scripts/ui-drive-batch.ps1')
const missingPid = 2147483647
const previous = new Map()
for (const [name, value] of Object.entries({ DSH_NO_ENV_FALLBACK: '1', DSH_UI_SERVE: '1', DSH_UI_CONTROL_POLICY: '', DSH_UI_PROC_NAME: '', DSH_UI_WINDOW_NAME: '', DSH_UI_CLIENT_EXE: '' })) {
  previous.set(name, process.env[name])
  process.env[name] = value
}

function ping(requests) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Serve', '-ProcId', String(missingPid)], {
    windowsHide: true, encoding: 'utf8', timeout: 10000, input: requests.map(request => JSON.stringify({ cmd: 'ping', ...request })).join('\n') + '\n',
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  return result.stdout.split(/\r?\n/).filter(line => line.startsWith('RESP_JSON=')).map(line => JSON.parse(line.slice(10)))
}

let driver
let folder
try {
  const firstWorker = ping([{ id: 37 }, { id: 39 }, {}])
  assert.deepEqual(firstWorker.map(result => result.id), [37, 39, 3])
  assert.ok(firstWorker.every(result => result.ok === true && result.pong === true))
  const restartedWorker = ping([{ id: 101 }, { id: 103 }, {}])
  assert.deepEqual(restartedWorker.map(result => result.id), [101, 103, 3])
  assert.ok(restartedWorker.every(result => result.ok === true && result.pong === true))

  const { makeDriver } = await import('../lib/driver.mjs')
  const { createPolicy } = await import('../lib/policy.mjs')
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-warm-protocol-'))
  driver = makeDriver({ scriptsDir: path.dirname(scriptPath), evidenceDir: folder, procName: '', windowName: '', clientExe: '', lockPath: '', defaultWaitMs: 0,
    policy: createPolicy({ approvalFile: '', policyFile: '', estopFile: '', safetyPolicyFile: '' }) })
  const firstRead = await driver.drive({ action: 'read', procId: missingPid, timeoutMs: 2000 })
  assert.equal(firstRead.ok, false)
  assert.notEqual(firstRead.timeout, true, JSON.stringify(firstRead))
  assert.match(firstRead.error, /未找到目标窗口/)
  assert.equal(driver.warmStatus().alive, true)
  const firstStatus = await driver.status({ procId: missingPid, timeoutMs: 2000 })
  assert.equal(firstStatus.running, false)
  assert.notEqual(firstStatus.unknown, true, JSON.stringify(firstStatus))
  const sequenceBeforeRestart = driver.warmStatus().seq
  driver.warmRestart()
  assert.equal(driver.warmStatus().alive, false)
  const secondRead = await driver.drive({ action: 'read', procId: missingPid, timeoutMs: 2000 })
  assert.equal(secondRead.ok, false)
  assert.notEqual(secondRead.timeout, true, JSON.stringify(secondRead))
  assert.match(secondRead.error, /未找到目标窗口/)
  assert.equal(driver.warmStatus().alive, true)
  assert.ok(driver.warmStatus().seq > sequenceBeforeRestart)
  const secondStatus = await driver.status({ procId: missingPid, timeoutMs: 2000 })
  assert.equal(secondStatus.running, false)
  assert.notEqual(secondStatus.unknown, true, JSON.stringify(secondStatus))
  assert.equal(driver.warmStatus().lateResponses, 0)
  assert.equal(driver.warmStatus().pending, 0)
  console.log('PASS real warm protocol: nonconsecutive IDs, legacy requests and driver recovery after worker restart')
} finally {
  driver?.warmShutdown()
  if (folder) fs.rmSync(folder, { recursive: true, force: true })
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
