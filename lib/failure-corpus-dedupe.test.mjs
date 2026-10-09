// 失败库：指纹 / 去重窗口 / recurrence 旁路文件 / producer 的离线自测。
// node lib/failure-corpus-dedupe.test.mjs
//
// 背景（2026-10 真库复盘）：811 条 tool-error 里约 94% 是三种重复报错，248 组「3 条 / 2 秒」的突发，
// 基本由一个测试反复写入。去重 + 来源字段的目的：重复发生**计数不丢**，但不再冒充成几百条独立失败；
// 并且"是谁写的"在记录本身里就能查到。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFailureCorpus, fingerprintOf, normalizeForFingerprint } from './failure-corpus.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }
const tmp = mkdtempSync(join(tmpdir(), 'fc-dedupe-'))
const fresh = (name, opts = {}) => makeFailureCorpus({ dir: join(tmp, name), ...opts })
const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [])

try {
  // ---- 归一化与指纹
  ok(normalizeForFingerprint('timeout after 1500ms') === normalizeForFingerprint('timeout after 30000ms'), '数字被抹平：不同超时值同一指纹')
  ok(normalizeForFingerprint('read C:\\a\\b.log failed') === normalizeForFingerprint('read D:/x/y/z.log failed'), 'Windows 路径被抹平')
  ok(normalizeForFingerprint('id 0123abcd4567ef89 gone') === normalizeForFingerprint('id deadbeefcafebabe gone'), '长 hex 被抹平')
  const base = { failureClass: 'tool-error', task: 'http_request', description: 'request could not be made: timeout after 1500ms' }
  ok(fingerprintOf(base) === fingerprintOf({ ...base, description: 'request could not be made: timeout after 9000ms' }), '同类失败指纹相同')
  ok(fingerprintOf(base) !== fingerprintOf({ ...base, failureClass: 'flaky' }), '不同 class 指纹不同')
  ok(fingerprintOf(base) !== fingerprintOf({ ...base, task: 'ui_drive' }), '不同 task 指纹不同')
  ok(/^[0-9a-f]{16}$/.test(fingerprintOf(base)), '指纹是 16 位 hex')

  // ---- 去重：同指纹窗口内第二次 → recurrence 事件，计数不丢
  {
    const c = fresh('dedupe', { dedupeWindowMs: 3600000 })
    const producer = { runtime: 'mcp', client: { name: 'unit-test' }, test: true }
    const a = c.record({ ...base, tags: ['auto'], dedupe: true, producer })
    const b = c.record({ ...base, description: 'request could not be made: timeout after 2000ms', tags: ['auto'], dedupe: true, producer })
    ok(typeof a.id === 'string' && a.fingerprint === fingerprintOf(base), '第一次：全量记录，带 fingerprint')
    ok(a.producer?.client?.name === 'unit-test', '全量记录带 producer')
    ok(b.recurrence === true && b.of === a.id && b.ofTs === a.ts, '第二次：recurrence 事件，指向第一条（id + ts）')
    ok(lines(join(c.dir, 'records.jsonl')).length === 1, 'records.jsonl 只有 1 行（旧读取器看到的与以前一致）')
    ok(lines(join(c.dir, 'recurrences.jsonl')).length === 1, 'recurrences.jsonl 记了 1 次重复')
    const s = c.stats()
    ok(s.total === 1 && s.recurrences === 1, 'stats：total=1、recurrences=1（重复不计入 total）')
    ok(s.topRecurring.length === 1 && s.topRecurring[0].occurrences === 2 && s.topRecurring[0].records === 1, 'topRecurring：一行 ×2')
    const q = c.query({})
    ok(q.rows[0].recurrences === 1 && typeof q.rows[0].lastSeenAt === 'string', 'query：记录上挂着 recurrences / lastSeenAt')
  }

  // ---- 不带 dedupe（手工记录、verify 的 agent-misjudge）永不折叠
  {
    const c = fresh('manual', { dedupeWindowMs: 3600000 })
    c.record({ ...base })
    c.record({ ...base })
    ok(lines(join(c.dir, 'records.jsonl')).length === 2 && !existsSync(join(c.dir, 'recurrences.jsonl')), '未带 dedupe：两条全量记录，没有旁路文件')
  }

  // ---- 窗口关闭（0）→ 不折叠
  {
    const c = fresh('off', { dedupeWindowMs: 0 })
    c.record({ ...base, dedupe: true })
    c.record({ ...base, dedupe: true })
    ok(lines(join(c.dir, 'records.jsonl')).length === 2, 'dedupeWindowMs=0：不去重')
  }

  // ---- 窗口外的旧记录不吸收新的发生；没有 fingerprint 字段的老记录按现算指纹参与
  {
    const c = fresh('window', { dedupeWindowMs: 3600000 })
    c.record({ ...base, dedupe: true }) // 先建目录
    const old = { id: 'fc-20260901-000000000001', ts: new Date(Date.now() - 2 * 3600000).toISOString(), ...base }
    writeFileSync(join(c.dir, 'records.jsonl'), JSON.stringify(old) + '\n', 'utf8') // 只留一条 2 小时前、无 fingerprint 的老记录
    const r1 = c.record({ ...base, dedupe: true })
    ok(r1.recurrence !== true && typeof r1.id === 'string', '窗口（1h）外的老记录不吸收：写新全量记录')
    const r2 = c.record({ ...base, dedupe: true })
    ok(r2.recurrence === true && r2.of === r1.id, '窗口内的下一次折叠到新记录上')
    const legacy = { id: 'fc-20261009-000000000002', ts: new Date().toISOString(), failureClass: 'flaky', task: 't', description: 'legacy 7' }
    writeFileSync(join(c.dir, 'records.jsonl'), readFileSync(join(c.dir, 'records.jsonl'), 'utf8') + JSON.stringify(legacy) + '\n', 'utf8')
    const r3 = c.record({ failureClass: 'flaky', task: 't', description: 'legacy 8', dedupe: true })
    ok(r3.recurrence === true && r3.of === legacy.id, '没有 fingerprint 字段的老记录：读侧现算指纹，照样折叠')
  }

  // ---- 被撤回的记录不吸收新的发生（否则新失败会被"藏"进一条已知记错的记录里）
  {
    const c = fresh('retracted', { dedupeWindowMs: 3600000 })
    const first = c.record({ ...base, dedupe: true })
    ok(c.retract({ id: first.id, reason: '单测：记错了' }).ok === true, '撤回第一条')
    const next = c.record({ ...base, dedupe: true })
    ok(next.recurrence !== true && next.id !== first.id, '撤回后的同指纹失败写新全量记录')
  }

  // ---- 校验
  {
    const c = fresh('validate')
    let threw = false
    try { c.record({ ...base, producer: 'x' }) } catch { threw = true }
    ok(threw, 'producer 必须是对象')
    threw = false
    try { c.record({ ...base, dedupe: 'yes' }) } catch { threw = true }
    ok(threw, 'dedupe 必须是布尔')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: 失败库指纹 / 去重 / recurrence / producer' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
