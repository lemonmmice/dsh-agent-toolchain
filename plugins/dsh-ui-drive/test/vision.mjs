import { makeDriver } from '../lib/driver.mjs'
import { makeVision, UI_STATE_PROMPT } from '../lib/vision.mjs'
import { join } from 'node:path'
const d = makeDriver({ scriptsDir: join(import.meta.dirname, '..', 'scripts') })
const s = await d.drive({ action: 'shot', label: 'vision-test' })
console.log('shot:', JSON.stringify({ ok: s.ok, path: s.path, size: s.w + 'x' + s.h }))
if (s.ok) {
  const v = makeVision({})
  console.log('vision config:', JSON.stringify(v.resolveConfig()).replace(/sk-[A-Za-z0-9]+/, 'sk-***'))
  const r = await v.describeImage(s.path, UI_STATE_PROMPT)
  console.log('describe:', JSON.stringify(r, null, 1))
}
