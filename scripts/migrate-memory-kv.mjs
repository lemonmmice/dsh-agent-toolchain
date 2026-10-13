import { resolve } from 'node:path'
import { KvMemory } from '../plugins/dsh-memory/lib/kv.mjs'

const directory = process.argv[2]
if (!directory || directory.startsWith('--')) {
  console.error('Usage: node scripts/migrate-memory-kv.mjs <KV directory> [--apply]. Stop old toolchain readers/writers before applying. The legacy file and a backup are retained.')
  process.exitCode = 2
} else {
  const store = new KvMemory(resolve(directory))
  try { console.log(JSON.stringify(store.migrate({ confirm: process.argv.includes('--apply') }), null, 2)) }
  finally { store.close() }
}
