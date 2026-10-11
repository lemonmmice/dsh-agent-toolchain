import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'proc-id': { type: 'string' },
  'proc-name': { type: 'string', default: '' },
  'window-name': { type: 'string', default: '' },
  'win-handle': { type: 'string' },
  'find-aid': { type: 'string', default: '' },
  'find-name': { type: 'string', default: '' },
  samples: { type: 'string', default: '8' },
  warmups: { type: 'string', default: '1' },
  max: { type: 'string', default: '500' },
  timeout: { type: 'string', default: '15000' },
  output: { type: 'string', default: join(root, '.dsh-agent-toolchain', 'ui-benchmark', 'latest.json') },
  scripts: { type: 'string' },
  help: { type: 'boolean', default: false },
} })

if (values.help) {
  console.log('Usage: node scripts/bench-ui-drive.mjs --proc-id PID [--proc-name NAME] [--window-name TITLE] [--win-handle HWND] [--find-aid ID | --find-name NAME] [--samples 8] [--warmups 1] [--max 500] [--timeout 15000] [--output FILE] [--scripts DIR]\nRead-only status/state/read/find benchmark. The existing target is never launched or terminated. Raw UI text is not saved. Use the same selector, max, and target window for before/after runs. Cold initialization is reported separately from measured rounds.')
  process.exit(0)
}

function integer(name, minimum) {
  const value = Number(values[name])
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`)
  return value
}

const procId = integer('proc-id', 1)
const samples = integer('samples', 5)
const warmups = integer('warmups', 0)
const max = integer('max', 1)
const timeoutMs = integer('timeout', 1)
const requestedHandle = values['win-handle'] === undefined ? undefined : integer('win-handle', 1)
const output = resolve(values.output)
const evidenceDir = join(dirname(output), 'evidence')
const scriptsDir = resolve(values.scripts || join(root, 'plugins', 'dsh-ui-drive', 'scripts'))
const driverFile = join(root, 'plugins', 'dsh-ui-drive', 'lib', 'driver.mjs')
const sourceFiles = [driverFile, join(scriptsDir, 'ui-drive.ps1'), join(scriptsDir, 'ui-drive-batch.ps1')]
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const roundMs = value => Math.round(value * 100) / 100
const stats = durations => {
  const sorted = [...durations].sort((left, right) => left - right)
  const percentile = quantile => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
  return { count: sorted.length, minMs: roundMs(sorted[0]), p50Ms: roundMs(percentile(0.5)), p95Ms: roundMs(percentile(0.95)), maxMs: roundMs(sorted.at(-1)), samplesMs: durations.map(roundMs) }
}

for (const key of Object.keys(process.env)) {
  if (/^DSH_/i.test(key)) delete process.env[key]
}
Object.assign(process.env, {
  DSH_NO_ENV_FALLBACK: '1',
  DSH_UI_PROC_NAME: values['proc-name'],
  DSH_UI_WINDOW_NAME: values['window-name'],
  DSH_UI_CLIENT_EXE: '',
  DSH_UI_EVIDENCE_DIR: evidenceDir,
  DSH_UI_APPROVAL_FILE: join(evidenceDir, 'approvals.json'),
  DSH_UI_SERVE: '1',
})

mkdirSync(evidenceDir, { recursive: true })
const { makeDriver } = await import('../plugins/dsh-ui-drive/lib/driver.mjs')
const driver = makeDriver({ procName: values['proc-name'], windowName: values['window-name'], clientExe: '', evidenceDir, scriptsDir, lockPath: '', defaultTimeoutMs: timeoutMs })
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  nodeVersion: process.version,
  mode: 'read-only-existing-process',
  target: { procId },
  settings: { samples, warmups, max, timeoutMs, includeIdentity: true, serve: true },
  sourceHashes: sourceHashes(),
  setup: [],
  rounds: [],
  timings: {},
  ok: false,
}
let windowHandle = requestedHandle
let selector = { aid: values['find-aid'], name: values['find-name'] }
let phase = 'initialization'

function requireResult(condition, message, result) {
  if (!condition) {
    const metadata = result ? { ok: result.ok, unknown: result.unknown, policyCode: result.policyCode, count: result.count, found: result.found } : null
    throw new Error(message + (metadata ? ` (${JSON.stringify(metadata)})` : ''))
  }
}

function verifyStatus(result) {
  requireResult(result.running === true && result.pid === procId, 'Status did not confirm the requested PID', result)
  requireResult(result.identity && typeof result.identity === 'object', 'Status omitted the requested process identity', result)
  requireResult(Number(result.handle) > 0, 'Target has no usable window handle', result)
  if (windowHandle !== undefined) requireResult(String(result.handle) === String(windowHandle), 'Target window changed during benchmark', result)
  return { pid: result.pid, windowHandle: result.handle, desktopState: result.desktopState, identityPresent: result.identity !== null && result.identity !== undefined }
}

function observationSummary(result) {
  requireResult(result.ok === true && Array.isArray(result.lines) && result.lines.length > 0, 'UI observation returned no usable lines', result)
  requireResult(result.skipped === 0, 'UI observation was incomplete or its completeness was unknown', result)
  requireResult(typeof result.snapshotId === 'string' && result.snapshotId.length > 0, 'UI observation omitted its snapshot ID', result)
  if (result.windowHandle != null) requireResult(String(result.windowHandle) === String(windowHandle), 'UI observation targeted a different window', result)
  return {
    count: result.count,
    returned: result.lines.length,
    controls: Array.isArray(result.controls) ? result.controls.length : null,
    truncated: result.truncated === true,
    skipped: result.skipped ?? null,
    scanned: result.scanned ?? null,
    snapshotPresent: true,
    contentHash: digest(result.lines),
  }
}

async function measure(action, operation, verify) {
  phase = action
  const started = performance.now()
  const result = await operation()
  const elapsedMs = performance.now() - started
  const evidence = verify(result)
  return { action, elapsedMs: roundMs(elapsedMs), evidence, result }
}

const savedMeasurement = ({ result, ...measurement }) => measurement
const target = () => ({ procId, winHandle: windowHandle, timeoutMs, waitMs: 0, focus: false })

async function runRound(index) {
  const started = performance.now()
  const measurements = []
  measurements.push(await measure('status', () => driver.status({ ...target(), includeIdentity: true }), verifyStatus))
  measurements.push(await measure('state', () => driver.drive({ ...target(), action: 'state', max }), observationSummary))
  measurements.push(await measure('read', () => driver.drive({ ...target(), action: 'read', max }), observationSummary))
  measurements.push(await measure('find', () => driver.drive({ ...target(), ...selector, action: 'find', requireUnique: true }), result => {
    requireResult(result.ok === true && result.found === true, 'Selected control was not found uniquely', result)
    requireResult(result.count == null || result.count === 1, 'Selected control was ambiguous', result)
    return { found: result.found, count: result.count ?? null, detailHash: digest(result.detail) }
  }))
  return { index, elapsedMs: roundMs(performance.now() - started), measurements: measurements.map(savedMeasurement) }
}

try {
  const initialStatus = await measure('initial-status', () => driver.status({ procId, winHandle: windowHandle, timeoutMs, includeIdentity: true }), verifyStatus)
  windowHandle = initialStatus.result.handle
  report.target.windowHandle = windowHandle
  report.setup.push(savedMeasurement(initialStatus))
  const initialState = await measure('initial-state', () => driver.drive({ ...target(), action: 'state', max }), observationSummary)
  report.setup.push(savedMeasurement(initialState))
  if (!selector.aid && !selector.name) {
    const controls = initialState.result.controls || []
    const candidates = controls.filter(control => control.enabled === true && (control.aid || control.name))
    const uniqueAid = candidates.find(control => control.aid && controls.filter(other => other.aid === control.aid).length === 1)
    const chosen = uniqueAid || candidates.find(control => control.name && controls.filter(other => other.name === control.name).length === 1)
    requireResult(Boolean(chosen), 'No unique control found; specify --find-aid or --find-name')
    selector = uniqueAid ? { aid: chosen.aid } : { name: chosen.name }
  }
  report.selector = { kind: selector.aid ? 'aid' : 'name', hash: digest(selector), explicit: Boolean(values['find-aid'] || values['find-name']) }
  for (let index = 0; index < warmups; index++) report.setup.push({ warmup: index + 1, ...(await runRound(index + 1)) })
  for (let index = 0; index < samples; index++) {
    const measurement = await runRound(index + 1)
    report.rounds.push(measurement)
    console.log(`Sample ${index + 1}/${samples}: ${measurement.measurements.map(item => `${item.action}=${item.elapsedMs}ms`).join(', ')}`)
  }
  phase = 'final-status'
  report.finalStatus = verifyStatus(await driver.status({ ...target(), includeIdentity: true }))
  requireResult(JSON.stringify(sourceHashes()) === JSON.stringify(report.sourceHashes), 'Benchmark source changed while samples were collected')
  report.ok = true
} catch (error) {
  report.failure = { phase, message: error.message }
  process.exitCode = 1
} finally {
  try {
    await driver.warmShutdown()
    driver.releaseLock()
    report.cleanup = { warmShutdown: true, targetProcessTerminated: false }
  } catch (error) {
    report.cleanup = { warmShutdown: false, targetProcessTerminated: false, error: error.message }
    report.ok = false
    process.exitCode = 1
  }
  if (report.rounds.length) {
    for (const action of ['status', 'state', 'read', 'find']) report.timings[action] = stats(report.rounds.map(item => item.measurements.find(measurement => measurement.action === action).elapsedMs))
    report.timings.roundTrip = stats(report.rounds.map(item => item.elapsedMs))
  }
  report.completedAt = new Date().toISOString()
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ ok: report.ok, output, completedSamples: report.rounds.length, timings: report.timings, failure: report.failure }, null, 2))
}
