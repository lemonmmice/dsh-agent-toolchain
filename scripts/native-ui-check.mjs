import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { closeNativeRuntime } from '../lib/native-runtime.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const options = JSON.parse(process.argv[2] || '{}')
if (!Number.isSafeInteger(options.procId) || options.procId < 1) throw new Error('An explicit procId is required')
const driver = makeDriver({ defaultTimeoutMs: 20000 })
const started = performance.now()
try {
  const result = Array.isArray(options.steps) ? await driver.flow(options) : await driver.drive(options)
  const durationMs = Math.round(performance.now() - started)
  if (process.env.DSH_NATIVE_UI_REPORT) {
    mkdirSync(dirname(process.env.DSH_NATIVE_UI_REPORT), { recursive: true })
    writeFileSync(process.env.DSH_NATIVE_UI_REPORT, JSON.stringify({ durationMs, result }, null, 2))
  }
  console.log(JSON.stringify({ ...result, durationMs }))
  if (result.ok !== true) process.exitCode = 1
} finally {
  driver.warmShutdown()
  driver.releaseLock()
  closeNativeRuntime()
}
