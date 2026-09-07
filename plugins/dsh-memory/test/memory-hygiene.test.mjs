// plugins/dsh-memory/test/memory-hygiene.test.mjs — hygiene self-test:
// sensitive-string filter (fail-closed) + stale-chunk eviction + incremental
// indexing. Runs offline on temp dirs (bigram embedding, no network).
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DshMemory } from '../lib/memory.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'
import { findSensitive, isSensitive } from '../lib/sensitive.mjs'

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ok - ' + msg)
  else {
    failures++
    console.error('  FAIL - ' + msg)
  }
}
const throws = (fn, msg) => {
  try {
    fn()
    failures++
    console.error('  FAIL - ' + msg + ' (did not throw)')
  } catch {
    console.log('  ok - ' + msg + ' (rejected)')
  }
}

// ---- sensitive-string filter
ok(isSensitive('ghp_' + 'A'.repeat(24)), 'github classic token detected')
ok(isSensitive('sk-' + 'x'.repeat(20)), 'openai-style key detected')
ok(isSensitive('AKIA' + '1'.repeat(16)), 'aws access key detected')
ok(isSensitive('Authorization: Bearer ' + 'b'.repeat(20)), 'bearer token detected')
ok(isSensitive('-----BEGIN RSA PRIVATE KEY-----'), 'private key block detected')
ok(isSensitive('api_key=abcDEF1234567890'), 'labeled secret detected')
ok(!isSensitive('记住约定：提交前先跑 scripts/check.mjs'), 'normal convention text is clean')
ok(!isSensitive('password must be at least 8 chars'), 'prose mention of password is clean')
ok(findSensitive('x-access-token:abc123').length >= 1, 'findSensitive reports the kind')

// ---- stale-chunk eviction + incremental indexing
const dataDir = mkdtempSync(join(tmpdir(), 'dshmem-'))
const ws = mkdtempSync(join(tmpdir(), 'dshws-'))
const mem = new DshMemory({ dataDir, embedProvider: new EmbedProvider({ apiKey: null, cacheDir: join(dataDir, '.cache') }) })

const f1 = join(ws, 'a.md')
writeFileSync(f1, '第一版内容 alpha')
await mem.indexWorkspace(ws)
ok(mem.status().chunks === 1, 'first index creates chunks')

const r2 = await mem.indexWorkspace(ws)
ok(r2.skipped === 1 && mem.status().chunks === 1, 'unchanged file skipped (incremental)')

writeFileSync(f1, '第二版内容 beta 完全不同的文本内容')
const r3 = await mem.indexWorkspace(ws)
ok(r3.indexed === 1 && mem.status().chunks === 1, 'changed file re-indexed, stale chunk evicted')
const hits = await mem.search('beta')
ok(hits.length >= 1 && String(hits[0].meta.text).includes('beta'), 'search returns fresh content')
ok(!String(hits[0].meta.text).includes('alpha'), 'stale content no longer in top hits')

unlinkSync(f1)
const r4 = await mem.indexWorkspace(ws)
ok(r4.deleted >= 1 && mem.status().chunks === 0, 'deleted file chunks evicted')

// ---- index path is fail-closed too: sensitive files are skipped, not embedded
const ws2 = mkdtempSync(join(tmpdir(), 'dshws2-'))
const secretFile = join(ws2, 'leak.md')
writeFileSync(secretFile, '普通内容 ' + 'ghp_' + 'C'.repeat(24) + ' 结尾')
const r5 = await mem.indexWorkspace(ws2)
ok(r5.sensitiveSkipped >= 1, 'sensitive file reported as skipped')
ok(mem.status().chunks === 0, 'sensitive file produced no chunks (nothing embedded)')

// ---- cross-root safety: indexing root B must not evict root A
const wsA = mkdtempSync(join(tmpdir(), 'dshwsA-'))
const wsB = mkdtempSync(join(tmpdir(), 'dshwsB-'))
writeFileSync(join(wsA, 'alpha.md'), '这是 A 仓库的内容 alpha 关键字')
writeFileSync(join(wsB, 'beta.md'), '这是 B 仓库的内容 beta 关键字')
await mem.indexWorkspace(wsA)
const afterA = mem.status().chunks
ok(afterA >= 1, 'root A indexed')
await mem.indexWorkspace(wsB)
const afterB = mem.status().chunks
ok(afterB >= afterA + 1, 'indexing root B kept root A chunks (no cross-root wipe)')
const hitA = await mem.search('alpha 关键字')
ok(hitA.some((h) => String(h.meta.file).includes('alpha.md')), 'root A still searchable after indexing root B')

// ---- remember() blocks sensitive values (fail-closed)
throws(() => mem.remember('k', 'token ghp_' + 'B'.repeat(24)), 'remember blocks sensitive value')
mem.remember('k2', 'safe value')
ok(mem.recall('k2') && mem.recall('k2').value === 'safe value', 'remember stores clean value')

rmSync(dataDir, { recursive: true, force: true })
rmSync(ws, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nMEMORY-HYGIENE TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nMEMORY-HYGIENE TEST PASSED')
