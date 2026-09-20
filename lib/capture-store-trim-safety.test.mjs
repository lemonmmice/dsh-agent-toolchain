// lib/capture-store 的**裁剪重写安全性**（F-033，2026-09-12 r33 审计）。
//
// 病（旧实现）：裁剪时**先把所有分片 `rmSync` 掉，再逐条写回**。
// 于是"删完之后、写回完成之前"的任何中断（进程被杀 / 崩溃 / 宿主重启 / 断电）都会让
// **整个接口捕获库消失** —— 不是少几条，是**全没了**，而 `trimmed.json` 也还没写，
// 事后连"曾经裁剪过"都看不出来。这个库里存的是**用户的真实接口流量**。
//
// 修法：**写临时文件 → 原子 rename 覆盖 → 最后才删多余分片**，并把"重写失败"如实回报。
// 本文件测两件事：
//   ① 正常裁剪：保新丢旧、行序正确、留下的还是活数据；
//   ② ★ **重写中途失败时，旧数据必须完好**（确定性构造：把临时文件路径占成一个目录，
//      让 `writeFileSync` 必然失败）—— 这正是旧实现会"全丢"的那个场景。
// ⚠ `DSH_API_CAPTURE_MAX_BYTES` 是在**模块加载时**读进 `const MAX_STORE_BYTES` 的，
//   而 ESM 的静态 import 会在模块体之前执行 ⇒ **必须先设环境变量、再动态 import**，
//   否则你设的 cap 根本不生效（我第一版就这么错了：设了 4000，实际还是默认 128MB，于是"裁剪"压根没发生）。
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const store = mkdtempSync(join(tmpdir(), 'cap-trim-'))
process.env.DSH_API_CAPTURE_STORE = store
process.env.DSH_API_CAPTURE_MAX_BYTES = '4000'

const { appendRecords, readAll, storeDir, readRetention, clearRecords, getCaptureStorage } = await import('./capture-store.mjs')

let failures = 0
const ok = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

const shards = () => readdirSync(store).filter((n) => /^records-\d+\.jsonl$/.test(n))
const body = (i) => ({ method: 'GET', url: 'https://example.com/api/' + i, status: 200, resBody: 'x'.repeat(400) })

// ---------- ① 正常裁剪 ----------
{
  for (let i = 0; i < 30; i++) appendRecords([{ ...body(i), ts: Date.now() + i }])
  const all = readAll()
  ok('裁剪后库里仍有记录（不是空的）', all.length > 0, `len=${all.length}`)
  ok('裁剪后总量受字节上限约束（没有无界增长）', all.length < 30, `len=${all.length}`)
  const newest = all.map((r) => r.url).includes('https://example.com/api/29')
  ok('★ 保新丢旧：最新那条还在', newest, JSON.stringify(all.map((r) => r.url).slice(-3)))
  const oldest = all.map((r) => r.url).includes('https://example.com/api/0')
  ok('★ 最旧那条已被裁掉（确实裁剪了）', !oldest, JSON.stringify(all.map((r) => r.url).slice(0, 3)))
  ok('★ 没有残留 .tmp 文件（原子替换做完了）', readdirSync(store).every((n) => !n.endsWith('.tmp')),
    JSON.stringify(readdirSync(store)))
  const lines = shards().flatMap((n) => readFileSync(join(store, n), 'utf8').split('\n').filter(Boolean))
  const tsList = lines.map((l) => JSON.parse(l).ts)
  ok('★ 分片内行序恒为时间正序（读回来的顺序才稳定）',
    tsList.every((v, i) => i === 0 || tsList[i - 1] <= v), JSON.stringify(tsList.slice(0, 6)))
  ok('裁剪痕迹落盘（trimmed.json 有 dropped 计数）',
    existsSync(join(store, 'trimmed.json')) && readRetention().droppedTotal > 0,
    JSON.stringify(readRetention()))
}

// ---------- ② ★ 重写中途失败：旧数据必须完好 ----------
{
  const before = readAll().length
  // 确定性构造失败：把"下一个分片的临时文件路径"占成一个**目录** ⇒ writeFileSync(tmp) 必然 EISDIR。
  // 旧实现此时已经把所有分片删光了；新实现里删除是**最后一步**，所以一条都不该丢。
  const probeTs = Date.now() + 100000
  const d = new Date(probeTs)
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const tmpAsDir = join(store, `records-${stamp}.jsonl.tmp`)
  mkdirSync(tmpAsDir, { recursive: true })
  writeFileSync(join(tmpAsDir, 'blocker'), 'x', 'utf8')

  let threw = null
  let res = null
  try {
    for (let i = 0; i < 20; i++) res = appendRecords([{ ...body(1000 + i), ts: probeTs + i }])
  } catch (e) { threw = e }
  ok('★ 重写失败**不会把异常甩给采集管线**（appendRecords 不抛）', threw === null, String(threw && threw.message))
  const after = readAll()
  ok('★★ 重写失败后，**之前的数据一条都没丢**（旧实现这里会全丢）', after.length >= before,
    `before=${before} after=${after.length}`)
  ok('★ 失败被如实回报（trimError / trimFailed）',
    res === null || res.trimFailed === true || res.trimError !== undefined,
    JSON.stringify(res && { trimFailed: res.trimFailed, trimError: String(res.trimError).slice(0, 120) }))
  rmSync(tmpAsDir, { recursive: true, force: true })
}

// ---------- ③ 第二个分片暂存失败时，第一个分片也不能被提前替换 ----------
// 通过真实 I/O 失败验证提交顺序，不依赖 JS/Rust 源码的具体写法。
{
  clearRecords()
  appendRecords([
    { ...body('first'), id: 'first', ts: new Date(2026, 0, 1, 12).getTime() },
    { ...body('second'), id: 'second', ts: new Date(2026, 0, 2, 12).getTime() },
  ])
  const names = shards().sort()
  const before = names.map(n => readFileSync(join(store, n), 'utf8'))
  const rows = readAll().map(r => ({ ...r, note: 'must not be committed' }))
  const blocker = join(store, names[1] + '.tmp')
  mkdirSync(blocker)
  let failure = null
  try { getCaptureStorage().replace(rows) } catch (error) { failure = error }
  ok('第二个分片暂存失败被回报', failure !== null)
  ok('第一个分片没有提前发布修改', readFileSync(join(store, names[0]), 'utf8') === before[0])
  ok('第二个分片原内容完整保留', readFileSync(join(store, names[1]), 'utf8') === before[1])
  ok('失败后读回原始数据', readAll().every(r => r.note === undefined))
  rmSync(blocker, { recursive: true, force: true })
}

delete process.env.DSH_API_CAPTURE_STORE
delete process.env.DSH_API_CAPTURE_MAX_BYTES
rmSync(store, { recursive: true, force: true })
void storeDir

if (failures > 0) {
  console.error(`\nCAPTURE-TRIM SAFETY TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nCAPTURE-TRIM SAFETY TEST PASSED')
