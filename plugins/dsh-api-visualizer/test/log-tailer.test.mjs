// dsh-api-visualizer 单测：LogTailer 的**诚实性**（F-004b 回归）
//
// 真机实测（2026-09-11）：caller 旁路日志的生产者根本不存在（客户端源码里搜不到
// ApiCallerTrace），而 LogTailer 把「文件不存在」和「读失败」塞进同一个 catch 里
// 一起 `errors++` → 每 750ms 涨一次，实测 11 → 57 → 222 → 825 单调增长、无上限，
// 同时 status() 报 running:true。
//
// 「一直在失败」比「明确说没有这个文件」更糟：前者让 agent 以为系统在正常工作、
// 只是偶尔出错；后者才让人知道**依赖它的能力当前不可用**。
// 这个测试钉住三种状态必须可区分：文件在 / 文件不在（稳态） / 真的读失败。
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LogTailer } from '../lib/capture-engine.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TMP = mkdtempSync(join(tmpdir(), 'dsh-av-tailer-'))
const missingPath = join(TMP, 'never-exists.log')

// ------------------------------------------------- 1. 文件不存在 = 稳态，不是错误
{
  const t = new LogTailer({ logPath: missingPath, pollMs: 20, what: '调用方归因旁路日志' })
  t.start()
  await sleep(200) // 约 10 个 tick
  const s = t.status()
  check('F-004b：文件缺失时 errors 保持 0（旧实现每 tick +1）', s.errors === 0, 'errors=' + s.errors)
  check('F-004b：missing=true 明确表达"文件不在"', s.missing === true, JSON.stringify({ m: s.missing, e: s.logExists }))
  check('F-004b：missingSince 记录了等待起点', typeof s.missingSince === 'number' && s.missingSince > 0, JSON.stringify(s.missingSince))
  check('F-004b：note 说清"不影响另一条日志，但该能力不可用"', /不影响/.test(s.note) && /不可用/.test(s.note), s.note)
  check('note 使用了传入的 what 标签（不写死）', /调用方归因旁路日志/.test(s.note), s.note)
  check('running 仍为 true（它确实在跑，只是在等待生产者）', s.running === true, JSON.stringify(s.running))
  t.stop()
  check('stop 后 running=false', t.status().running === false, '')
}

// ------------------------------------------------- 2. 生产者后来出现 → 自动恢复读取
{
  const t = new LogTailer({ logPath: missingPath, pollMs: 20, replay: true, what: '旁路日志' })
  t.start()
  await sleep(60)
  check('恢复前：missing=true', t.status().missing === true, '')
  appendFileSync(missingPath, '{"a":1}\n', 'utf8')
  await sleep(400) // 退避是 8 个 tick，给它足够时间
  let chunks = []
  t.stop()
  const t2 = new LogTailer({ logPath: missingPath, pollMs: 20, replay: true, onChunk: (c) => chunks.push(c) })
  t2.start()
  await sleep(120)
  const s2 = t2.status()
  check('文件出现后 missing=false', s2.missing === false, JSON.stringify({ m: s2.missing }))
  check('文件出现后能读到内容（replay 从头）', chunks.join('').includes('{"a":1}'), JSON.stringify(chunks.join('').slice(0, 80)))
  check('读到内容后 errors 仍为 0', s2.errors === 0, 'errors=' + s2.errors)
  t2.stop()
}

// ------------------------------------------------- 3. 真的读失败 → errors++ 且 lastError 有内容
{
  const p = join(TMP, 'ok.log')
  writeFileSync(p, 'x\n', 'utf8')
  const t = new LogTailer({ logPath: p, pollMs: 20, replay: false, what: '测试日志' })
  // 确定性地让**读**这一步抛：把 offset 设成负值。
  // 为什么不用"拿目录当日志"这类花样：本机实测空目录的 statSync().size 为 0，
  // 于是 `st.size > offset` 为假、**根本不会走到读**，测试会假绿。
  // 这里要验的是"openSync/readSync 抛错时的计数与自述"，所以直接构造那个条件。
  t.start()
  // 必须**在 start() 之后**设：start() 里会把 offset 初始化成当前文件大小（replay=false），
  // 先设会被覆盖掉。设成负值后，下一次 tick 的 `st.size > offset` 成立且读位置非法 → 抛出。
  t.offset = -5
  await sleep(150)
  const s = t.status()
  check('读失败时 errors 增长（这里才是真的错误）', s.errors > 0, 'errors=' + s.errors)
  check('读失败时 lastError 有消息（便于定位）', typeof s.lastError === 'string' && s.lastError.length > 0, JSON.stringify(s.lastError))
  check('读失败时 lastErrorAt 有时间戳', typeof s.lastErrorAt === 'number' && s.lastErrorAt > 0, JSON.stringify(s.lastErrorAt))
  check('读失败时 note 指向那次失败', /最近一次读取失败/.test(s.note), s.note)
  check('读失败与"文件不存在"是两回事（missing=false）', s.missing === false, JSON.stringify({ m: s.missing, e: s.logExists }))
  t.stop()
}

// ------------------------------------------------- 4. 正常读取（对照组）
{
  const p = join(TMP, 'normal.log')
  writeFileSync(p, '', 'utf8')
  const chunks = []
  const t = new LogTailer({ logPath: p, pollMs: 20, replay: false, onChunk: (c) => chunks.push(c), what: '正常日志' })
  t.start()
  appendFileSync(p, 'line-1\nline-2\n', 'utf8')
  await sleep(120)
  const s = t.status()
  check('正常路径：missing=false、errors=0', s.missing === false && s.errors === 0, JSON.stringify({ m: s.missing, e: s.errors }))
  check('正常路径：读到新增两行', chunks.join('') === 'line-1\nline-2\n', JSON.stringify(chunks.join('')))
  check('正常路径：note 说"正在读取"', /正在读取/.test(s.note), s.note)
  t.stop()
}

// ------------------------------------------------- 5. 轮转（文件被清空）不报错
{
  const p = join(TMP, 'rotate.log')
  writeFileSync(p, 'aaaa\n', 'utf8')
  const chunks = []
  const t = new LogTailer({ logPath: p, pollMs: 20, replay: true, onChunk: (c) => chunks.push(c), what: '轮转日志' })
  t.start()
  await sleep(80)
  writeFileSync(p, 'b\n', 'utf8') // 变小 → 视为轮转，offset 归零
  await sleep(120)
  const s = t.status()
  check('轮转后不报错', s.errors === 0, 'errors=' + s.errors)
  check('轮转后读到新内容', chunks.join('').includes('b'), JSON.stringify(chunks.join('').slice(0, 80)))
  t.stop()
}

// ------------------------------------------------- 6. F-022：`running` 属性必须存在且与 status() 同源
//
// 真机实测（我亲手踩到）：`index.js` 的三处守卫读的是 `engine.tailer.running`，
// 而 LogTailer 只有 `this.timer`、没有 `running` 属性 → 读到 undefined → **守卫永不生效**。
// 后果：捕获运行中改 logPath 返回 200，却把跟踪日志换成不存在的文件，捕获静默失效。
{
  const p = join(TMP, 'f022.log')
  writeFileSync(p, '', 'utf8')
  const t = new LogTailer({ logPath: p, pollMs: 20, what: 'F-022' })
  check('F-022 未启动时 running === false（且不是 undefined）', t.running === false, JSON.stringify(t.running))
  t.start()
  check('F-022 启动后 running === true（守卫才可能生效）', t.running === true, JSON.stringify(t.running))
  check('F-022 running 与 status().running 同源', t.running === t.status().running, JSON.stringify({ a: t.running, b: t.status().running }))
  t.stop()
  check('F-022 停止后 running === false', t.running === false && t.status().running === false, JSON.stringify({ a: t.running, b: t.status().running }))
}

// ------------------------------------------------- 7. AV-07：解析失败不得静默丢流量
//
// 病：`pump()` 先推进 `offset` 再 `onChunk`，解析异常被外层 catch 吞成计数 →
// **已消费的字节永不重放**，那段流量静默不入库，而 status 仍报 running:true。
// 调用方看到的是"没有请求"，不是"有请求但没解析出来" —— 这正是最危险的一类假空。
{
  const p = join(TMP, 'av07.log')
  writeFileSync(p, '', 'utf8')
  let calls = 0
  let failUntil = 3 // 前 3 次调用抛，之后成功
  const chunks = []
  const t = new LogTailer({
    logPath: p, pollMs: 20, replay: false, what: 'AV-07 测试',
    onChunk: (c) => { calls++; if (calls <= failUntil) throw new Error('模拟解析失败'); chunks.push(c) },
  })
  t.start()
  appendFileSync(p, 'line-A\n', 'utf8')
  await sleep(60)
  check('AV-07 解析失败时 offset **不推进**（字节留着重试，不丢）', t.offset === 0, 'offset=' + t.offset)
  check('AV-07 解析失败会被记账到 lastError', /解析失败/.test(String(t.lastError)), String(t.lastError).slice(0, 120))
  check('AV-07 重试期间还没有"丢弃"（droppedBytes=0）', t.droppedBytes === 0, JSON.stringify(t.droppedBytes))
  // 让 onChunk 恢复成功 → 同一段字节应当被成功读出（证明没有被丢掉）
  await sleep(120)
  check('AV-07 恢复后同一段字节终于被读出（未丢失）', chunks.join('').includes('line-A'), JSON.stringify(chunks.join('')))
  check('AV-07 成功后 dataComplete 仍为 true 且无丢弃', t.status().dataComplete === true && t.droppedBytes === 0, JSON.stringify({ d: t.droppedBytes, c: t.status().dataComplete }))
  t.stop()

  // 一直失败 → 到上限后必须**明确记账**，而不是静默跳过
  const p2 = join(TMP, 'av07b.log')
  writeFileSync(p2, '', 'utf8')
  const t2 = new LogTailer({ logPath: p2, pollMs: 10, replay: false, what: 'AV-07 持续失败', onChunk: () => { throw new Error('永久解析失败') } })
  t2.start()
  appendFileSync(p2, 'bad-line-1\n', 'utf8')
  await sleep(400) // 10ms 轮询 × 上限 8 次 ≈ 80ms，给足余量
  const s2 = t2.status()
  check('AV-07 持续失败到上限 → 明确记账 droppedBytes>0', s2.droppedBytes > 0, JSON.stringify({ d: s2.droppedBytes, c: s2.droppedChunks }))
  check('AV-07 持续失败 → droppedChunks>=1', s2.droppedChunks >= 1, JSON.stringify(s2.droppedChunks))
  check('AV-07 持续失败 → dataComplete=false（调用方能自证数据不完整）', s2.dataComplete === false, JSON.stringify(s2.dataComplete))
  check('AV-07 持续失败 → note 明说"没有入库、不要读成没有请求"', /没有入库/.test(s2.note) && /不要把它读成/.test(s2.note), String(s2.note).slice(0, 240))
  check('AV-07 丢弃原因可查', typeof s2.lastParseError === 'string' && s2.lastParseError.length > 0, JSON.stringify(s2.lastParseError))
  t2.stop()
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-api-visualizer LogTailer（F-004b 三种状态可区分）')
process.exit(failures ? 1 : 0)
