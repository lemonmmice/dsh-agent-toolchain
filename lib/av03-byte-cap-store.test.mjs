// lib/av03-byte-cap-store.test.mjs — **端到端**验证「按字节裁剪保留集」（AV-03 剩余缺口）
//
// 为什么必须是子进程：
//   `MAX_STORE_BYTES` 是在模块**加载时**从 `DSH_API_CAPTURE_MAX_BYTES` 求值的常量，
//   在同一个进程里 import 之后再改 env 已经太晚 —— 那样写出来的测试会变成"永远为真"
//   （我第一版就是这么写的：断言"未超上限时不裁剪"，而那一刻上限其实是默认的 128MB，
//   无论实现有没有按字节裁剪，测试都绿）。所以这里起子进程，带上小上限，读它真实落盘的结果。
//
// 验证的是**真实写盘路径**：appendRecords → 超上限 → 删分片 → 按裁剪结果重写 → readAll。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'cap-byte-'))
const MAX_BYTES = 64 * 1024

// 子进程：写 40 条 ×4KB body（≈160KB，远超 64KB 上限），把结果打成 JSON。
const child = `
import { appendRecords, readAll } from ${JSON.stringify(new URL('./capture-store.mjs', import.meta.url).href)}
const body = 'x'.repeat(4000)
const batch = Array.from({ length: 40 }, (_, i) => ({
  id: 'b' + i, ts: Date.now() + i, method: 'GET', url: 'https://big.example.com/' + i, resBody: body,
}))
appendRecords(batch)
const all = readAll()
const bytes = all.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), 'utf8') + 1, 0)
const ordered = all.every((r, i) => i === 0 || Number(all[i - 1].ts) <= Number(r.ts))
// 裁剪后再追加一条：它的 ts 最大，应该落在**文件末尾**（行序=时间序的不变量）
appendRecords([{ id: 'b99', ts: Date.now() + 999, method: 'GET', url: 'https://big.example.com/newest' }])
const after = readAll()
console.log(JSON.stringify({
  count: all.length, bytes, ids: all.map((r) => r.id),
  chronological: ordered,
  newestInFile: after[after.length - 1]?.id, lastAppendAtEnd: after[after.length - 1]?.id === 'b99',
}))
`
let out
try {
  out = execFileSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    env: { ...process.env, DSH_API_CAPTURE_STORE: dir, DSH_API_CAPTURE_MAX_BYTES: String(MAX_BYTES) },
  }).trim()
} catch (e) {
  console.log('  FAIL 子进程执行失败 — ' + String(e.stdout || e.message).slice(0, 400))
  failures++
}

if (out) {
  const r = JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop())
  check('AV-03 上限被真正读取（env 覆盖生效，不是默认 128MB）', r.bytes < 128 * 1024 * 1024 && r.count < 40, JSON.stringify({ count: r.count, bytes: r.bytes }))
  check('AV-03 按字节裁掉了最旧的记录（不是 40 条全留）', r.count > 0 && r.count < 40, JSON.stringify({ count: r.count }))
  check('AV-03 裁剪后总量 ≤ 0.9×上限（这就是"永不自愈"被终结的判据）', r.bytes <= MAX_BYTES * 0.9, JSON.stringify({ bytes: r.bytes, limit: MAX_BYTES * 0.9 }))
  check('AV-03 回收是真实数量级：从 ≈160KB 降到 ≤58KB', r.bytes < 60 * 1024, JSON.stringify(r.bytes))
  check('AV-03 保留的是**连续尾部**（最旧优先丢，没有中间挖洞）', (() => {
    const nums = r.ids.map((i) => Number(String(i).slice(1))).sort((a, b) => a - b)
    return nums.length > 0 && nums[nums.length - 1] === 39 && nums.every((n, k) => n === nums[0] + k)
  })(), JSON.stringify(r.ids))
  check('AV-03 重写后文件行序 = 时间序（跨面测试抓到的顺序不一致，已统一为正序）', r.chronological === true, String(r.chronological))
  check('AV-03 裁剪后再追加，最新那条落在文件末尾（行序不变量保持）', r.lastAppendAtEnd === true, JSON.stringify({ newestInFile: r.newestInFile }))

  // 落盘侧独立复核：文件真实大小也必须落到上限以下（不能只信内存里的数）
  const files = readdirSync(dir).filter((n) => /^records-\d{8}\.jsonl$/.test(n))
  check('AV-03 重写后只剩一个分片文件', files.length === 1, JSON.stringify(files))
  if (files.length === 1) {
    const physical = readFileSync(join(dir, files[0]), 'utf8')
    const physicalBytes = Buffer.byteLength(physical, 'utf8')
    check('AV-03 磁盘上的真实字节也 ≤ 0.9×上限（与内存口径一致）', physicalBytes <= MAX_BYTES * 0.9, JSON.stringify({ physicalBytes, limit: MAX_BYTES * 0.9 }))
    check('AV-03 落盘行数与保留集一致（+1 = 裁剪后追加的那条）', physical.trim().split('\n').length === r.count + 1, JSON.stringify({ lines: physical.trim().split('\n').length, count: r.count }))
  }
}

rmSync(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nPASS: capture-store AV-03 按字节裁剪（端到端，子进程 + 真实写盘）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
