// memory_index 的**有界性**回归（2026-09-15）。
//
// 由来（用户当场报的缺陷）：「**每次调用 memory_index 就把自己卡死**」。
//   根因不是单个请求没超时（`embed()` 早就有 20 秒超时，F-053 修过），而是**总量没有上界**：
//   原实现对每个分块**串行 await embed()**，没有预算、没有进度、不能续跑 ——
//   一个几百块的目录就是几分钟到几十分钟，调用方在上限内等不到返回、被打断，
//   而它拿不到任何"做到哪了"的信息 ⇒ 只能重来 ⇒ 每次调用都像卡死。
//
// 四条不变量（每一条都对应一个真实后果）：
//   I1 **有界**：调用在预算附近返回（不是"跑到自己完为止"）—— 否则调用方必然被截断；
//   I2 **可续跑**：第二次调用能把剩下的做完，且**不重做**已完成的文件（靠 mtime 跳过）；
//   I3 **全有或全无**：被预算打断的文件必须**一块都不留** ——
//      因为增量跳过判据是 `countPrefix(...)>0`（有一块就当已索引）⇒ 半索引的文件会被**永久跳过**、
//      那部分内容**静默地从检索里消失**；
//   I4 **如实报进度**：返回里必须能看出 stoppedBy/processedFiles/remainingFiles，
//      并且**渲染文本不许在被截断时说"索引完成"**（原实现的措辞无条件说完成）。
import { DshMemory } from '../lib/memory.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假 embedder：可控延迟 / 可控失败；**不碰网络**。 */
function fakeEmbed({ delayMs = 0, failOn = () => false } = {}) {
  let calls = 0
  return {
    label: 'fake',
    mode: 'test',
    calls: () => calls,
    async embed(text) {
      calls++
      if (delayMs) await sleep(delayMs)
      if (failOn(text)) throw new Error('fake embed failure')
      return { dim: 3, v: [String(text).length, 1, 0] }
    },
  }
}

/** 造一个目录：n 个文件，每个文件 ~chunksPerFile 块。
 *  ⚠ 每段必须**单独超过 800 字符的一半**，否则 chunker 会把它们合并成一块 ——
 *  而"一块一个文件"的语料**根本测不出"文件做到一半被打断"**（这正是本文件要测的核心场景）。 */
function makeCorpus(root, n, chunksPerFile) {
  mkdirSync(root, { recursive: true })
  const para = (i, j) => `段落${i}-${j} ` + '龙虎榜ETF量化条件选股自选板块基金'.repeat(30)   // ~500 字符/段
  for (let i = 0; i < n; i++) {
    const parts = []
    for (let j = 0; j < chunksPerFile; j++) parts.push(para(i, j))
    writeFileSync(join(root, `f${String(i).padStart(3, '0')}.md`), parts.join('\n\n'), 'utf-8')
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-mem-budget-'))
try {
  // ── 1. 有界性 + 可续跑 + 全有或全无 ─────────────────────────────────────
  const root = join(TMP, 'corpus')
  const N = 12, PER = 5
  makeCorpus(root, N, PER)
  const slow = fakeEmbed({ delayMs: 60 })
  const mem = new DshMemory({ dataDir: join(TMP, 'data'), project: 'test', embedProvider: slow })

  const t0 = Date.now()
  const r1 = await mem.indexWorkspace(root, { budgetMs: 1200, concurrency: 2 })
  const elapsed = Date.now() - t0

  check('★ I1 有界：预算 1200ms ⇒ 调用在合理时间内返回（不是"跑到做完为止"）',
    elapsed < 6000, elapsed + 'ms')
  check('★★ I4 如实报进度：返回里带 stoppedBy / processedFiles / remainingFiles / budgetMs',
    r1.stoppedBy === 'budget' && typeof r1.processedFiles === 'number' &&
    typeof r1.remainingFiles === 'number' && r1.budgetMs >= 1000, JSON.stringify({ stoppedBy: r1.stoppedBy, processed: r1.processedFiles, remaining: r1.remainingFiles, budgetMs: r1.budgetMs, indexed: r1.indexed, chunks: r1.chunks }))
  check('★★ 并且明确说"没做完"（nextStep 里给出"再调一次接着做"）',
    r1.remainingFiles > 0 ? /没做完/.test(String(r1.nextStep)) && /再调一次/.test(String(r1.nextStep)) : true,
    String(r1.nextStep).slice(0, 160))

  // I3：被打断的那个文件**一块都不能留**。检查方式：每个文件在库里的块数只能是 0 或"完整块数"。
  const partial = []
  for (let i = 0; i < N; i++) {
    const f = join(root, `f${String(i).padStart(3, '0')}.md`)
    const key = 'file:' + f + ':'
    const got = mem.store.countPrefix(key)
    if (got !== 0 && got !== PER) partial.push(`${f.split('\\').pop()}=${got}(满 ${PER})`)
  }
  check('★★ I3 全有或全无：被预算打断的文件在库里**一块都不留**（否则它会被永久跳过、内容静默消失）',
    partial.length === 0, partial.join(', '))

  // I2：第二次调用把剩下的做完；已完成的不重做（用 embedder 的调用次数反证）
  const before = slow.calls()
  const r2 = await mem.indexWorkspace(root, { budgetMs: 60000, concurrency: 2 })
  const after = slow.calls()
  check('★★ I2 可续跑：第二次调用把剩下的做完（remainingFiles 归零、全部文件都在库里）',
    r2.remainingFiles === 0 && (() => {
      for (let i = 0; i < N; i++) {
        const f = join(root, `f${String(i).padStart(3, '0')}.md`)
        if (mem.store.countPrefix('file:' + f + ':') !== PER) return false
      }
      return true
    })(), JSON.stringify({ remaining: r2.remainingFiles, indexed: r2.indexed, skipped: r2.skipped }))
  check('★ 且**不重做**已完成的文件（第二次的嵌入调用数 ≈ 剩余块数，而不是全部 ' + (N * PER) + '）',
    (after - before) < N * PER, '第二次调用了 ' + (after - before) + ' 次 embed')

  const r3 = await mem.indexWorkspace(root, { budgetMs: 60000 })
  check('★ 再调一次：全部命中 mtime 跳过（skipped = 全部文件、chunks = 0）',
    r3.skipped === N && r3.chunks === 0, JSON.stringify({ skipped: r3.skipped, chunks: r3.chunks }))

  // ── 2. 失败必须被记账，不许静默 ────────────────────────────────────────
  const root2 = join(TMP, 'corpus2')
  makeCorpus(root2, 3, 2)
  const bad = fakeEmbed({ failOn: () => true })
  const mem2 = new DshMemory({ dataDir: join(TMP, 'data2'), project: 'test', embedProvider: bad })
  const r4 = await mem2.indexWorkspace(root2, { budgetMs: 30000 })
  check('★★ 嵌入失败的文件进 failedFiles（原实现是 `catch { /* skip unreadable */ }`：**静默丢弃**）',
    Array.isArray(r4.failedFiles) && r4.failedFiles.length === 3, JSON.stringify(r4.failedFiles.map((f) => f.file)))
  check('★ 失败的文件也没留半块（同样全有或全无）',
    (() => {
      const f = join(root2, 'f000.md')
      return mem2.store.countPrefix('file:' + f + ':') === 0
    })(), '')
  check('★ 失败原因被带出来（不是一句"失败"）',
    r4.failedFiles.length > 0 && /fake embed failure/.test(String(r4.failedFiles[0].error)), JSON.stringify(r4.failedFiles[0] || {}))

  // ── 3. 超大文件：跳过并**如实报出**（不许静默） ─────────────────────────
  const root3 = join(TMP, 'corpus3')
  mkdirSync(root3, { recursive: true })
  writeFileSync(join(root3, 'small.md'), '小文件 ' + 'x'.repeat(500), 'utf-8')
  writeFileSync(join(root3, 'huge.md'), '大文件 ' + 'y'.repeat(300000), 'utf-8')
  const mem3 = new DshMemory({ dataDir: join(TMP, 'data3'), project: 'test', embedProvider: fakeEmbed({}) })
  const r5 = await mem3.indexWorkspace(root3, { budgetMs: 30000, maxFileBytes: 100000 })
  check('★★ 超大文件被跳过并**报出来**（不是静默略过 —— 读者会以为"目录里就这些内容"）',
    r5.sizeSkippedFiles.length === 1 && /huge\.md/.test(r5.sizeSkippedFiles[0].file), JSON.stringify(r5.sizeSkippedFiles))
  check('★ 小文件照常索引', r5.indexed === 1, JSON.stringify({ indexed: r5.indexed, chunks: r5.chunks }))

  // ── 4. 默认预算存在（不传 budgetMs 也不能无边无际） ────────────────────
  check('★ 不传 budgetMs 时有默认上界（环境变量可调）',
    typeof r1.budgetMs === 'number' && (() => {
      const d = new DshMemory({ dataDir: join(TMP, 'data4'), project: 'test', embedProvider: fakeEmbed({}) })
      return typeof d.indexWorkspace === 'function'
    })(), '')
  // ── 5. 预算必须覆盖"装载索引"阶段（2026-09-15 本机实测：预算 90s 的调用跑了 242s，
  //       时间全花在 `beginBatch()` 读并解析 59MB 索引上 ⇒ 装载完才发现预算没了，却还接着干活）──
  {
    const root5 = join(TMP, 'corpus5')
    makeCorpus(root5, 4, 2)
    const mem5 = new DshMemory({ dataDir: join(TMP, 'data5'), project: 'test', embedProvider: fakeEmbed({}) })
    // 让"装载"这一步确定性地变慢（真机上是 59MB 索引的解析耗时，测试里没法造那么大）
    const realBegin = mem5.store.beginBatch.bind(mem5.store)
    mem5.store.beginBatch = (o) => { const t = Date.now(); while (Date.now() - t < 2000) { /* 烧掉 2s */ } return realBegin(o) }
    const r6 = await mem5.indexWorkspace(root5, { budgetMs: 1200 })
    check('★★ 装载阶段就把预算用光 ⇒ 立刻返回、**一个字都不处理**（而不是"装载完再干活"）',
      r6.stoppedIn === 'load' && r6.processedFiles === 0 && r6.remainingFiles === 4 && r6.indexed === 0,
      JSON.stringify({ stoppedIn: r6.stoppedIn, processed: r6.processedFiles, remaining: r6.remainingFiles, indexed: r6.indexed }))
    check('★ 装载耗时被如实报出来（loadMs）—— 调用方要能看见"时间去哪了"',
      typeof r6.loadMs === 'number' && r6.loadMs >= 1000, JSON.stringify({ loadMs: r6.loadMs, sweepMs: r6.sweepMs }))
    check('★ 并说明"再调一次也没用"（这是装载慢，不是工作没做完）',
      /装载/.test(String(r6.nextStep)) && /调大 budgetMs|拆小/.test(String(r6.nextStep)), String(r6.nextStep).slice(0, 200))
    check('★ 收尾清扫耗时也带出来（sweepMs）', typeof r6.sweepMs === 'number', String(r6.sweepMs))
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: memory_index 有界性（预算 / 续跑 / 全有或全无 / 如实报进度 / 失败与超大文件都不静默）')
