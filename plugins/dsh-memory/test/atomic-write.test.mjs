// F-053 回归：**一次中断不能清掉整个索引**。
//
// 真事故（2026-09-14）：`memory_index` 卡死 → 调用被打断 → 向量库从 43.9MB / 2182 块变成 **0 字节**。
// 三个根因，本测试逐条钉住：
//   ① `embed()` 的远程 fetch **没有超时** ⇒ 网络慢就永远挂着；
//   ② 存储用 `writeFileSync` **原地覆盖**（先截断再写）+ **无备份** ⇒ 打断落在中间 = 全清；
//   ③ `upsert` 每插一块就全量重写整个文件（O(n²)）⇒ 慢到必然会被打断。
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { writeJsonlAtomic } from '../lib/atomic-write.mjs'
import { VectorStore } from '../lib/store.mjs'
import { KvMemory } from '../lib/kv.mjs'
import { EmbedProvider } from '../lib/embed-provider.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-mem-atomic-'))
try {
  // ---------------------------------------------------------------- ① 原子写 + 备份
  {
    const f = join(root, 'a.jsonl')
    writeJsonlAtomic(f, [{ id: 1 }, { id: 2 }])
    check('★ 写得进去', JSON.parse(readFileSync(f, 'utf8').trim().split('\n')[0]).id === 1)
    writeJsonlAtomic(f, [{ id: 9 }])
    check('★ 覆盖后是**新内容**（rename 替换生效）', readFileSync(f, 'utf8').trim() === '{"id":9}')
    check('★★ 覆盖时留了 `.bak`，且里面是**上一次**的内容（原来一份备份都没有）',
      existsSync(f + '.bak') && readFileSync(f + '.bak', 'utf8').trim() === '{"id":1}\n{"id":2}')
    check('★ 不残留临时文件', !readdirSync(root).some((n) => n.includes('.tmp-')))
  }

  // ---------------------------------------------------------------- ② 序列化失败时，旧文件**一个字节都不能动**
  {
    const f = join(root, 'b.jsonl')
    writeJsonlAtomic(f, [{ id: 'good' }])
    const before = readFileSync(f, 'utf8')
    let threw = false
    try {
      // 造一个序列化就抛的行：`toJSON` 抛错
      writeJsonlAtomic(f, [{ id: 'x', toJSON() { throw new Error('boom') } }])
    } catch { threw = true }
    check('★ 序列化抛错会往上抛（不吞）', threw)
    check('★★ 抛错时**磁盘上的旧文件一个字节都没被碰过**（这正是"截断后再序列化"最危险的地方）',
      readFileSync(f, 'utf8') === before, JSON.stringify(readFileSync(f, 'utf8')))
  }

  // ---------------------------------------------------------------- ③ 批量模式：写次数从 O(块数) 降到 O(1)
  {
    const dir = join(root, 'vec')
    const s = new VectorStore(dir, 'default')
    let writes = 0
    const origWrite = s._write.bind(s)
    s._write = (rows) => { writes++; return origWrite(rows) }
    s.beginBatch({ flushEvery: 50 })
    for (let i = 0; i < 200; i++) s.upsert('k' + i, [i, 1], { i })
    const duringWrites = writes
    s.endBatch()
    check('★★ 200 块在批量里**只落盘几次**（原来每块一次全量重写 = O(n²)）',
      duringWrites <= 5 && writes === duringWrites + 1, '批量中写入=' + duringWrites + ' 总计=' + writes)
    check('★ 批量结束后数据完整落盘（200 条都在）', s.count() === 200, String(s.count()))
    check('★ 落盘后能正常检索', s.search([0, 1], 1).length === 1)
  }

  // ---------------------------------------------------------------- ④ KV 也走同一条原子写
  {
    const kv = new KvMemory(join(root, 'kv'))
    kv.save('k', 'v1', 'sc')
    kv.save('k', 'v2', 'sc')
    check('★ KV 覆盖写正常', kv.get('k', 'sc').value === 'v2')
    check('★★ KV 也留了备份（原来 kv.mjs 与 store.mjs **同病**，只是文件小、窗口短还没炸）',
      existsSync(join(root, 'kv', 'kv.jsonl.bak')))
  }

  // ---------------------------------------------------------------- ⑤ embedding 必须有超时上界
  {
    const realFetch = globalThis.fetch
    let aborted = false
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      // 永不 resolve；只在 signal 触发时 reject（复刻"网络卡住"）
      const sig = opts && opts.signal
      if (sig) sig.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'TimeoutError'; reject(e) })
    })
    const prevEnv = process.env.DSH_MEMORY_EMBED_TIMEOUT_MS
    process.env.DSH_MEMORY_EMBED_TIMEOUT_MS = '1000'
    try {
      const p = new EmbedProvider({ apiKey: 'fake-key-for-test' })
      const t0 = Date.now()
      let err = null
      try { await p.embed('hello') } catch (e) { err = e }
      const dt = Date.now() - t0
      check('★★ 远程 embedding **卡住时会超时返回**（不是永远挂着 —— 真事故就是挂死在这里）',
        err !== null && dt < 6000 && aborted, '耗时=' + dt + 'ms aborted=' + aborted + ' err=' + (err && err.message ? err.message.slice(0, 60) : err))
      check('★ 错误里给了**可执行的下一步**（换超时 / 走本地降级 / 已落盘的不丢）',
        err && /DSH_MEMORY_EMBED_TIMEOUT_MS/.test(err.message) && /bigram|MINIMAX_CN_API_KEY/.test(err.message) && /原子写|不会因为这次失败丢历史/.test(err.message),
        err ? err.message.slice(0, 200) : '')
    } finally {
      globalThis.fetch = realFetch
      if (prevEnv === undefined) delete process.env.DSH_MEMORY_EMBED_TIMEOUT_MS
      else process.env.DSH_MEMORY_EMBED_TIMEOUT_MS = prevEnv
    }
  }

  // ---------------------------------------------------------------- ⑥ 源码守卫：不许再出现原地覆盖写
  {
    const files = ['lib/store.mjs', 'lib/kv.mjs']
    const bad = files.filter((rel) => /fs\.writeFileSync\(this\.file/.test(readFileSync(join(REPO, 'plugins', 'dsh-memory', rel), 'utf8')))
    check('★★ 两个存储都不再有 `fs.writeFileSync(this.file, …)` 原地覆盖（那是清零的元凶）',
      bad.length === 0, bad.join(', '))
    const embedRaw = readFileSync(join(REPO, 'plugins', 'dsh-memory', 'lib', 'embed-provider.mjs'), 'utf8')
    // ⚠ 断言要对着**代码**，不是注释：解释里就写着 `AbortSignal.timeout()` 这个词，
    //   直接 `.test(全文)` 会把它当代码 —— 第一版就是这么误判的。
    const embed = embedRaw.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    check('★★ embedding 的 fetch 带上了 signal（超时上界）', /signal:\s*ctrl\.signal/.test(embed))
    check('★★ 用的是 **AbortController + ref 的 setTimeout**，不是 `AbortSignal.timeout()` —— ' +
      '后者内部的定时器是 unref 的，在"没有别的活动"的进程里**可能根本不触发**（本仓单测里实测就发生过）',
      /new AbortController\(\)/.test(embed) && /setTimeout\(\(\) => ctrl\.abort/.test(embed) && !/AbortSignal\.timeout/.test(embed),
      '（本条只看代码行，已剔除注释）')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: F-053 —— 原子写 + 备份 + 批量落盘 + embedding 超时（一次中断不能再清掉整个索引）')
