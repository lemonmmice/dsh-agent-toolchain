// dsh-hang-inspector 渲染层单测
//
// 钉住的是"不许撒谎"的三条：
//   1. 没配源码根 / 没命中源码 → 必须明说"这不是代码级证据"，不许拿类型名冒充定位；
//   2. 证据包必须**自曝年龄**（几小时前的 dump 不能拿来解释刚发生的卡死）；
//   3. 识别不出嫌疑线程本身就是结论，不许含糊带过成"没问题"。
import { renderStatus, renderRun, renderStop, renderPacks, renderPack, renderAnalyze, renderDelete } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ------------------------------------------------- 1. 状态
{
  check('未运行时给下一步（怎么启动）', /hang_run|启动监测/.test(renderStatus({ running: false, evidenceDir: 'X' })), '')
  const running = renderStatus({ running: true, pid: 123, logTail: 'watching…', evidenceDir: 'X' })
  check('运行中显示 pid', /pid 123/.test(running), running.slice(0, 80))
  check('运行中带日志尾部', /watching/.test(running), '')
  check('状态为 null 时不炸且出声', /失败/.test(renderStatus(null)), '')
}

// ------------------------------------------------- 2. 启动监测：必须讲清"不会自动点击"
{
  const ok = renderRun({ ok: true, pid: 9 })
  check('启动成功明说"不会自动点击客户端"', /不会自动点击/.test(ok), ok.slice(0, 200))
  check('启动成功给出下一步（hang_status/hang_packs）', /hang_status|hang_packs/.test(ok), '')
  const busy = renderRun({ ok: false, error: '监测已在运行' })
  check('已在运行 → 给"直接让用户复现"的下一步', /复现/.test(busy), busy.slice(0, 200))
  check('启动失败带原因', /监测已在运行/.test(busy), '')
}

// ------------------------------------------------- 3. 证据包列表：年龄是硬要求
{
  const now = Date.now()
  const v = { evidenceDir: 'E', items: [
    { id: 'p2', ts: now - 60 * 1000, hasScreenshot: true, dumpBytes: 637 * 1024 * 1024, analysisStatus: 'done', summaryFirstLine: '主窗口 12000ms 无响应' },
    { id: 'p1', ts: now - 6 * 3600 * 1000, hasDump: true },
  ] }
  const out = renderPacks(v, { now })
  check('列出包 id', /p2/.test(out) && /p1/.test(out), out.slice(0, 200))
  check('1 分钟前显示"刚刚/分钟前"', /刚刚|分钟前/.test(out), out.slice(0, 200))
  check('6 小时前显示"小时前"（不许只给时间戳）', /小时前/.test(out), out.slice(0, 300))
  check('dump 大小以 MB 呈现', /637MB/.test(out), out.slice(0, 200))
  check('列出 summary 首行', /无响应/.test(out), '')
  check('空列表时给下一步（hang_run）', /hang_run/.test(renderPacks({ items: [], evidenceDir: 'E' })), '')
  check('列表为 null 时不炸且出声', /失败/.test(renderPacks(null)), '')
}

// ------------------------------------------------- 4. 分析结果：诚实性是核心
{
  const noSrc = renderAnalyze({ ok: true, status: 'done', diagnosis: 'UI 线程阻塞', suspectThread: { managedId: 1, osId: 9, frames: ['A.dll!X.Y'] }, source: null })
  check('源码未命中 → 明确写"不是代码级证据"', /不是代码级证据/.test(noSrc), noSrc.slice(0, 400))
  check('源码未命中 → 解释两种常见原因', /DSH_HANG_SRC_ROOT/.test(noSrc) && /框架\/系统类型/.test(noSrc), noSrc.slice(0, 500))

  const withSrc = renderAnalyze({ ok: true, status: 'done', suspectThread: { managedId: 1, osId: 9, frames: ['X.dll!A.B'] },
    source: { file: 'src/A.cs', line: 42, method: 'OnTick', snippet: 'public void OnTick() {…}' } })
  check('命中源码 → 文件:行号', /src\/A\.cs:42/.test(withSrc), withSrc.slice(0, 300))
  check('命中源码 → 标注"声明处"而非执行行', /声明处/.test(withSrc) && !/执行的那一行（/.test(withSrc) === false, '')
  check('命中源码 → 附代码片段', /public void OnTick/.test(withSrc), '')

  const noThread = renderAnalyze({ ok: true, status: 'done', suspectThread: null })
  check('识别不出嫌疑线程 → 说明"这本身就是结论"', /这本身就是结论/.test(noThread), noThread.slice(0, 300))
  check('识别不出嫌疑线程 → 不许反推"没问题"', /不要据此反向推断/.test(noThread), '')

  const running = renderAnalyze({ ok: true, status: 'running', startedAt: Date.now() - 5000 })
  check('分析中 → 给"稍后查/再等"的下一步', /下一步/.test(running), running.slice(0, 200))

  const dacErr = renderAnalyze({ ok: false, status: 'error', error: 'no CLR runtime found in dump (DAC mismatch)' })
  check('DAC 不匹配 → 给具体修法', /mscordacwks/.test(dacErr), dacErr.slice(0, 300))
  check('分析失败为 null 时不炸', /失败/.test(renderAnalyze(null)), '')
}

// ------------------------------------------------- 5. 删除：必须挡在 confirm 之外
{
  check('未确认 → 显示被阻止', /已阻止/.test(renderDelete({ blocked: '已阻止：hang_delete 不可恢复。…' })), '')
  check('清空 → 明说不可恢复', /不可恢复/.test(renderDelete({ deleted: 3, all: true })), '')
  check('删单个 → 明说不可恢复', /不可恢复/.test(renderDelete({ deleted: 'p1' })), '')
}

// ------------------------------------------------- 6. 包详情
{
  const out = renderPack({ id: 'p1', dir: 'D', files: ['summary.txt', 'frozen.dmp'], hasScreenshot: true, texts: { summary: '主窗口无响应 12000ms', 'net-trace': 'GET /a 200' } })
  check('包详情输出 summary', /无响应/.test(out), '')
  check('包详情输出 net-trace', /GET \/a 200/.test(out), '')
  check('包详情给出冻结截图路径', /frozen-screen\.png/.test(out), '')
  check('包详情给下一步（hang_analyze）', /hang_analyze/.test(out), '')
  check('空文本包不炸', /没有可读的文本证据/.test(renderPack({ id: 'x', texts: {} })), '')
  check('pack 为 null 不炸', /失败/.test(renderPack(null)), '')
  check('stop 为 null 不炸', /失败/.test(renderStop(null)), '')
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-hang-inspector render（诚实性三条）')
process.exit(failures ? 1 : 0)
