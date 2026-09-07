import { makeDriver } from '../lib/driver.mjs'
import { join } from 'node:path'
const driver = makeDriver({ scriptsDir: join(import.meta.dirname, '..', 'scripts') })
const depth = Number(process.argv[2] || 6)
const r = await driver.tree({ maxDepth: depth })
console.log(JSON.stringify({ ok: r.ok, error: r.error, len: r.text?.length, truncated: r.truncated }, null, 1))
if (r.ok) console.log(r.text.slice(0, 3000))
