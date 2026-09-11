// dsh-perf 单测：ETW 调用链（trace/hotstacks）的报告解析与两个"实测踩出来的"硬性细节
//
// 夹具是**真实报告**（xperf `-a stack -butterfly` 的 HTML），不是手写样例：
//   · stack-report-managed.html    —— 启用 CPU+DotNet 预设后，含**真实托管方法名**（我们真正要的形态）
//   · stack-report-symresolved.html —— 只启 CPU 预设，模块能解但**托管函数名解不出**（踩坑形态）
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { makeTrace, parseStackReport, summarize, CAPTURE_SETS } from '../lib/trace.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const managedHtml = readFileSync(join(here, 'fixtures', 'stack-report-managed.html'), 'utf8')
const partialHtml = readFileSync(join(here, 'fixtures', 'stack-report-symresolved.html'), 'utf8')
// ⚠️ 临时文件一律写**系统临时目录**：曾把 .tmp-* 写在测试目录里、被 git 提交进去（已清理）
const TMP = mkdtempSync(join(tmpdir(), 'dsh-perf-trace-'))
// 源码级护栏用（有多处断言直接检查实现写法，因为这些坑只能靠"写法"钉死）
const src = readFileSync(join(here, '..', 'lib', 'trace.mjs'), 'utf8')

// ------------------------------------------------- 1. 解析真实报告（含托管符号）
{
  const p = parseStackReport(managedHtml)
  check('解析出进程', Array.isArray(p.processes) && p.processes.length > 0, JSON.stringify(p.processes.slice(0, 2)))
  check('解析出模块排行', Array.isArray(p.modules) && p.modules.length > 0, JSON.stringify(p.modules.slice(0, 3)))
  check('解析出最热函数排行', Array.isArray(p.hotFunctions) && p.hotFunctions.length > 0, 'count=' + p.hotFunctions.length)
  check('最热函数名是 module!Function 形式', p.hotFunctions.every((f) => /!/.test(f.name)), JSON.stringify(p.hotFunctions[0]))
  check('解析出蝶形视图（调用链）', Array.isArray(p.butterfly) && p.butterfly.length > 0, 'count=' + p.butterfly.length)

  const withCallers = p.butterfly.filter((b) => b.callers.length > 0)
  const withCallees = p.butterfly.filter((b) => b.callees.length > 0)
  check('蝶形：解析出调用者（<--）', withCallers.length > 0, 'count=' + withCallers.length)
  check('蝶形：解析出被调用者（-->）', withCallees.length > 0, 'count=' + withCallees.length)

  // 关键判据：**托管方法名**能解出来（这是我们做这件事的全部意义）
  const managed = p.hotFunctions.concat(p.butterfly.map((b) => ({ name: b.name }))).filter((f) => /System\.|mscorlib|\.ni\.dll/.test(f.name))
  check('解出真实托管方法名（.NET 场景的核心价值）', managed.length > 0, JSON.stringify(managed.slice(0, 3).map((m) => m.name)))
  check('托管方法名带签名（含括号/泛型）', managed.some((m) => /\(/.test(m.name)), JSON.stringify(managed.slice(0, 2).map((m) => m.name)))

  check('未解析比例可计算且 < 1', p.unknownRatio >= 0 && p.unknownRatio < 1, String(p.unknownRatio))
}

// ------------------------------------------------- 2. summarize：压缩成可读调用链，且**绝不回吐原始 HTML**
{
  const p = parseStackReport(managedHtml)
  p.__etl = 'X:\\lab\\trace.etl'
  const s = summarize(p, { topN: 10 })
  check('摘要含"最热函数"段', /最热函数/.test(s.text))
  check('摘要含"调用链"段', /调用链/.test(s.text))
  check('摘要含调用者/被调用者标注', /调用者:|调用了:/.test(s.text))
  check('摘要**不含**原始 HTML 标签（几 MB 的 HTML 对模型无价值）',
    !/<table|<a href|<\/td>|<tbody/.test(s.text), s.text.slice(0, 120))
  check('摘要长度受控（topN 生效）', s.text.length < 12000, 'len=' + s.text.length)
  check('返回结构化字段供程序消费（热函数/链/进程）',
    Array.isArray(s.hotFunctions) && Array.isArray(s.chains) && Array.isArray(s.processes))
  check('摘要把 etl 路径写进去（可追溯）', /trace\.etl/.test(s.text))
}

// ------------------------------------------------- 3. 符号未解析时必须**显式告警**（B-1 同源）
{
  const p = parseStackReport(partialHtml)
  check('踩坑形态：未解析比例高（只开 CPU 预设时托管函数名解不出）', p.unknownRatio > 0.5, String(p.unknownRatio))
  const s = summarize(p, { topN: 5 })
  check('高未解析比例 → 摘要里必须出现告警', /符号未解析比例/.test(s.text) && /⚠️/.test(s.text), s.text.split('\n').slice(0, 3).join(' | '))
  // 对照组：解析良好的报告不该误报
  const ok = summarize(parseStackReport(managedHtml), { topN: 5 })
  check('解析良好时不出现告警（避免狼来了）', !/⚠️/.test(ok.text))
}

// ------------------------------------------------- 4. 两个实测踩出来的硬性细节（回归护栏）
{
  // 4a. 采集必须同时开 CPU 与 DotNet，否则托管函数名解不出来
  check('CAPTURE_SETS.cpu 同时含 CPU 与 DotNet（少一个就只剩模块名）',
    CAPTURE_SETS.cpu.includes('CPU') && CAPTURE_SETS.cpu.includes('DotNet'), JSON.stringify(CAPTURE_SETS.cpu))
  check('CAPTURE_SETS.dotnet 同样带上 CPU（栈采样来源）',
    CAPTURE_SETS.dotnet.includes('DotNet') && CAPTURE_SETS.dotnet.includes('CPU'), JSON.stringify(CAPTURE_SETS.dotnet))

  // 4b. 报告命令必须显式带 -symbols（xperf 帮助：不指定则**符号解码被禁用**）
  check('hotstacks 的命令里显式带 -symbols', /cmd\.push\('-symbols'\)/.test(src))
  check('-symbols 受 offline 开关控制（离线可跳过）', /if \(!args\.offline\) \{\s*\n\s*cmd\.push\('-symbols'\)/.test(src))
  check('符号路径默认指向微软公网符号 + 本地缓存', /msdl\.microsoft\.com\/download\/symbols/.test(src))
  check('设置 _NT_SYMCACHE_PATH（第二次出报告才快）', /_NT_SYMCACHE_PATH/.test(src))
}

// ------------------------------------------------- 5. 边界与错误路径
{
  const t = makeTrace({ evidenceDir: join(TMP, 'evidence') })
  const noEtl = await t.hotstacks({ etlPath: join(here, 'nope.etl') })
  check('etlPath 不存在 → 明确报错（不是静默空结果）', noEtl.ok === false && /不存在/.test(String(noEtl.error)), JSON.stringify(noEtl))
  const badProfile = await t.trace({ profile: 'nonsense' })
  check('未知 profile → 明确报错', badProfile.ok === false && /未知 profile/.test(String(badProfile.error)), JSON.stringify(badProfile))
  check('空报告不会崩', (() => { try { const r = parseStackReport(''); return r && Array.isArray(r.hotFunctions) && r.hotFunctions.length === 0 } catch { return false } })())
}

// ------------------------------------------------- 6. 端到端实测抓到的三个"假成功"回归
// 实测现场：xperf 被 900s 超时杀掉 → 留下**空报告文件** → 原实现只看"文件存在"就报 ok:true，
// 返回一个空结果并显示 "符号未解析比例: 0%" —— 读起来像"符号全解析了"，实际一个函数都没有。
{
  const { writeFileSync, rmSync, existsSync } = await import('node:fs')

  // 6a. 空报告：summarize 必须说清"没有任何条目"，**不得**显示 0% 未解析
  const emptyText = summarize(parseStackReport(''), { topN: 5 }).text
  check('空报告：明确写"没有任何可解析的函数条目"', /没有任何可解析的函数条目/.test(emptyText), emptyText.split('\n').slice(0, 3).join(' | '))
  check('空报告：**不出现**"0%"这种误导性读数', !/符号未解析比例: 0%/.test(emptyText), emptyText.split('\n')[1])
  check('空报告：明说"不等于没有热点"', /不等于["“]?没有热点/.test(emptyText))

  // 6b. 空报告 → hotstacks 必须返回 ok:false（不是假成功）
  const fakeEtl = join(TMP, 'fake.etl')
  const fakeReport = join(TMP, 'fake-report.html')
  writeFileSync(fakeEtl, 'not a real etl', 'utf8')
  writeFileSync(fakeReport, '', 'utf8')   // 预先放一个空报告，模拟"xperf 留下空文件"
  try {
    const t = makeTrace({ evidenceDir: join(TMP, 'evidence'), xperf: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') })
    const r = await t.hotstacks({ etlPath: fakeEtl, outPath: fakeReport, timeoutMs: 30000 })
    check('空报告 → ok:false（不当成"没有热点"）', r.ok === false, JSON.stringify({ ok: r.ok, error: String(r.error).slice(0, 80) }))
    check('空报告 → 错误信息给出排查方向', /符号|focus|为空/.test(String(r.error)), String(r.error).slice(0, 120))
  } finally {
    try { rmSync(fakeEtl, { force: true }); rmSync(fakeReport, { force: true }) } catch { /* ignore */ }
  }

  // 6c. xperf 超时 → 必须 timedOut:true 且 ok:false，并给出"加 process 过滤"的建议
  {
    writeFileSync(fakeEtl, 'not a real etl', 'utf8')
    try {
      const xp = existsSync('C:\\Program Files (x86)\\Windows Kits\\10\\Windows Performance Toolkit\\xperf.exe')
        ? undefined : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'timeout.exe')
      const t = makeTrace({ evidenceDir: join(TMP, 'evidence'), ...(xp ? { xperf: xp } : {}) })
      // timeoutMs=1：任何真实 xperf 都会被立刻杀掉 —— 走的就是"超时"分支
      const r = await t.hotstacks({ etlPath: fakeEtl, timeoutMs: 1, outPath: join(TMP, 'to.html') })
      check('xperf 超时 → ok:false 且 timedOut:true', r.ok === false && r.timedOut === true, JSON.stringify({ ok: r.ok, timedOut: r.timedOut }))
      check('超时 → 建议里含"加 process 过滤"/调大 timeoutMs', /process 过滤|timeoutMs/.test(String(r.error)), String(r.error).slice(0, 140))
    } finally { try { rmSync(fakeEtl, { force: true }) } catch { /* ignore */ } }
  }
}

// ------------------------------------------------- 7. 符号缓存必须**跨运行共享**（端到端实测的第四个坑）
// 实测现场：第一次运行把 1.15 GB 符号存进 .../e2e/symbols，第二次运行却开在
// .../e2e2/symbols 从零再下一遍，xperf 长时间 0% CPU 卡在公网符号服务器上。
// 根因：符号缓存挂在 runDir()（带时间戳）下面，而 runDir 每次运行都是新的。
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const evDir = mkdtempSync(join(tmpdir(), 'dsh-perf-sym-'))
  try {
    const t = makeTrace({ evidenceDir: evDir })
    const env = t.symbolEnv(false)

    // 7a. 符号缓存必须落在 evidenceDir 下**固定**的目录，而不是任何带时间戳的运行目录
    check('符号缓存目录不含时间戳运行目录（trace-<stamp>）', !/trace-\d{4}-\d{2}-\d{2}T/.test(String(env._NT_SYMBOL_PATH)), String(env._NT_SYMBOL_PATH))
    check('symcache 目录同样不含时间戳运行目录', !/trace-\d{4}-\d{2}-\d{2}T/.test(String(env._NT_SYMCACHE_PATH)), String(env._NT_SYMCACHE_PATH))

    // 7b. 两次不同 tag 的"运行"必须解析到**同一个**符号缓存目录（这就是"跨运行共享"的定义）
    const a = makeTrace({ evidenceDir: evDir })
    const b = makeTrace({ evidenceDir: evDir })
    const envA = a.symbolEnv(false)
    const envB = b.symbolEnv(false)
    check('同一个 evidenceDir 下，两次运行解析到同一个符号缓存', envA._NT_SYMBOL_PATH === envB._NT_SYMBOL_PATH, envA._NT_SYMBOL_PATH + ' vs ' + envB._NT_SYMBOL_PATH)
    check('符号缓存与 symcache 是两个不同目录（不能互相覆盖）', envA._NT_SYMBOL_PATH !== envA._NT_SYMCACHE_PATH)

    // 7c. 缓存目录必须真的被建出来（否则 xperf 会当成不可写而回退）
    const { existsSync } = await import('node:fs')
    const symDir = String(envA._NT_SYMBOL_PATH).split('*')[1]
    check('符号缓存目录已创建', existsSync(symDir), symDir)
    check('symcache 目录已创建', existsSync(String(envA._NT_SYMCACHE_PATH)), String(envA._NT_SYMCACHE_PATH))

    // 7d. DSH_PERF_SYMBOL_CACHE 生效（可把缓存指到大盘上）
    const custom = mkdtempSync(join(tmpdir(), 'dsh-perf-symcustom-'))
    try {
      const t2 = makeTrace({ evidenceDir: evDir, symbolCacheDir: custom })
      const e2 = t2.symbolEnv(false)
      check('symbolCacheDir 覆盖生效', String(e2._NT_SYMBOL_PATH).includes(custom), String(e2._NT_SYMBOL_PATH))
    } finally { try { rmSync(custom, { recursive: true, force: true }) } catch { /* ignore */ } }

    // 7e. offline 时不得注入任何符号环境（保持既有语义）
    const eo = t.symbolEnv(true)
    check('offline → 不注入 _NT_SYMBOL_PATH', !eo._NT_SYMBOL_PATH || eo._NT_SYMBOL_PATH === process.env._NT_SYMBOL_PATH)
  } finally {
    try { rmSync(evDir, { recursive: true, force: true }) } catch { /* ignore */ }
    // 7f. 清理失败用例留下的临时报告（历史上 .tmp-to.html 被落进 test/ 且没进 .gitignore）
    try { rmSync(join(TMP, 'to.html'), { force: true }) } catch { /* ignore */ }
  }

  // 7g. 符号卡住时必须能诊断：debugSymbols 打开 verbose，且 -symbols 仍单独成 push
  check('debugSymbols → 追加 -symbols verbose', /if \(args\.debugSymbols\) cmd\.push\('verbose'\)/.test(src))
  check('-symbols 仍是独立整串 push（verbose 不破坏既有护栏）', /cmd\.push\('-symbols'\)/.test(src))
  check('超时后会删掉 0 字节报告（不留"有报告"的假象）', /leftoverBytes === 0\) rmSync\(outHtml/.test(src))
  check('超时返回里带符号缓存目录（给出下一步）', /symbolCacheDir: !args\.offline \? join\(c\.symbolCacheDir/.test(src))
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-perf ETW trace/hotstacks test')