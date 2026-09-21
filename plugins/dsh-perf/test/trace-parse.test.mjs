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

  // ---------------------------------------------------- 未解析比例的**口径**（Claude r12 方向 + 真报告实测确认）
  // 原口径只有 `最热函数 + 蝶形根名`，**不含链上的调用者/被调用者**，而那份列表正是输出里最显眼的部分。
  // 真报告（本 fixture）实测差额：上报 0.2%（1472 项）vs 显示出来 1578 个名字、6 个未解析（0.4%）。
  // 未解析帧偏爱深层，所以低估在符号没配好的报告里会变成"报 0% 但链上全是 unknown"。
  check('★未解析比例的分母覆盖**链上的名字**（否则链里的 unknown 一个都不进分母）',
    !!p.unknownDetail && p.unknownDetail.total === p.hotFunctions.length + p.butterfly.length +
      p.butterfly.reduce((a, b) => a + b.callers.length + b.callees.length, 0),
    JSON.stringify(p.unknownDetail))
  check('★分桶明细给到"链上未解析几个"（能看出未解析是否集中在深层）',
    !!p.unknownDetail && Number.isInteger(p.unknownDetail.inChains) && Number.isInteger(p.unknownDetail.inHot),
    JSON.stringify(p.unknownDetail))
  {
    const s2 = summarize(p, { topN: 10 })
    check('★摘要里把口径写出来（不给光秃秃一个百分数）',
      /口径：/.test(s2.text) && new RegExp(String(p.unknownDetail.total)).test(s2.text),
      s2.text.split('\n').find((l) => l.includes('符号未解析')))
    check('摘要返回结构化 unknownDetail 供程序消费', !!s2.unknownDetail, JSON.stringify(s2.unknownDetail).slice(0, 120))
  }
  {
    // 这两条把"旧口径漏掉链上未解析"钉死，分两半测（各自测自己那一层，不互相遮掩）：
    //   (a) **解析层**：在真报告上核对分母构成 —— 链上的名字必须进分母；且真报告里链上确实有未解析
    //       （本 fixture：链上 2 个、最热 2 个、根 1 个）→ 旧口径算出来的比例必然偏低。
    //   (b) **汇报层**：拿一个"未解析只在链上"的 parsed 对象喂 summarize，要求它把口径写出来并点名链上未解析。
    //       （这半边是构造输入，明确标注：测的是**对外汇报契约**，不是解析。）
    const oldDenom = p.hotFunctions.length + p.butterfly.length
    check('★(a) 真报告：分母已包含链上名字（旧口径缺 ' + (p.unknownDetail.total - oldDenom) + ' 个）',
      p.unknownDetail.total > oldDenom && p.unknownDetail.inChains > 0,
      JSON.stringify({ newTotal: p.unknownDetail.total, oldTotal: oldDenom, chains: p.unknownDetail.inChains }))
    const oldUnknown = p.hotFunctions.filter((f) => /\*\*\*unknown\*\*\*/.test(f.name)).length +
      p.butterfly.filter((b) => /\*\*\*unknown\*\*\*/.test(b.name)).length
    const oldRatio = oldDenom ? oldUnknown / oldDenom : 0
    check('★(a) 旧口径比例**低于**新口径（链上的未解析被漏掉，方向必须一致）',
      oldRatio < p.unknownRatio, 'old=' + oldRatio.toFixed(4) + ' new=' + p.unknownRatio.toFixed(4))

    // (b) 汇报层：未解析只出现在链上（构造输入）
    const chainOnly = {
      __etl: 'X:\\lab\\trace.etl',
      hotFunctions: [{ name: 'good.dll!ResolvedFn()', percent: '50%', exclusive: 1, inclusive: 1 }],
      butterfly: [{ name: 'good.dll!ResolvedFn()', percent: '50%', itself: 1, callers: [{ name: '***unknown***!***unknown***', hits: 9 }], callees: [] }],
      processes: [], modules: [],
      unknownRatio: 1 / 3,
      unknownDetail: { unknown: 1, total: 3, inHot: 0, inRoots: 0, inChains: 1 },
    }
    const cs = summarize(chainOnly, { topN: 5 })
    check('★★(b) 口径写进摘要（不是光秃秃一个百分数；分母是"报告里解析到的"、不是"打印出来的"）',
      /口径：/.test(cs.text) && /3 个名字/.test(cs.text) && /报告里解析到的/.test(cs.text),
      cs.text.split('\n').find((l) => l.includes('符号未解析')))
    check('★★(b) 链上有未解析帧时**点名**，且用 ℹ️ 而非最高级 ⚠️（低比例不该狼来了）',
      /调用链里有 1 个未解析帧/.test(cs.text) && /ℹ️/.test(cs.text) && !/⚠️/.test(cs.text),
      cs.text.split('\n').filter((l) => /未解析/.test(l)).join(' | '))
    check('(b) unknownDetail 透传给程序消费', !!cs.unknownDetail && cs.unknownDetail.inChains === 1, JSON.stringify(cs.unknownDetail))
  }
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
  check('hotstacks 固定 Sampled Profile 事件，避免混入 CSwitch 栈', /const eventScope = 'Sampled Profile'/.test(src) && /'-event', eventScope/.test(src))
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
    // ⚠ r61：本节测的是"**默认组合**出来的符号路径"（缓存目录固定 + 注入缓存 + srv 形态）。
    //   而按本仓语义，**一旦配置了 `DSH_PERF_SYMBOL_PATH`（尤其带 `srv*`）就是整串替换、不再注入缓存目录**
    //   ⇒ 本节所有断言在这个变量存在时会红 —— **红的是机器环境，不是代码**（r61 实测：子进程里塞上真实配置，
    //   `symbolCacheDir 覆盖生效` 当场红出与真凶一模一样的签名；去掉即绿）。
    //   所以这里**显式声明"没有配置符号路径"**，而不是依赖环境干净（测试不许断言/依赖机器全局状态）。
    const t = makeTrace({ evidenceDir: evDir, symbolPath: '' })
    const env = t.symbolEnv(false)

    // 7a. 符号缓存必须落在 evidenceDir 下**固定**的目录，而不是任何带时间戳的运行目录
    check('符号缓存目录不含时间戳运行目录（trace-<stamp>）', !/trace-\d{4}-\d{2}-\d{2}T/.test(String(env._NT_SYMBOL_PATH)), String(env._NT_SYMBOL_PATH))
    check('symcache 目录同样不含时间戳运行目录', !/trace-\d{4}-\d{2}-\d{2}T/.test(String(env._NT_SYMCACHE_PATH)), String(env._NT_SYMCACHE_PATH))

    // 7b. 两次不同 tag 的"运行"必须解析到**同一个**符号缓存目录（这就是"跨运行共享"的定义）
    const a = makeTrace({ evidenceDir: evDir, symbolPath: '' })
    const b = makeTrace({ evidenceDir: evDir, symbolPath: '' })
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
      const t2 = makeTrace({ evidenceDir: evDir, symbolCacheDir: custom, symbolPath: '' })
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

// ------------------------------------------------- 8. F-043/F-044：符号路径的语义 + "未知"里剩下的那层信息
//
// 现场（2026-09-11，真机三连测）：
//   ① 客户端自己的 pdb **就在磁盘上**（产物目录，16 个），把它接进符号路径后，
//      系统 DLL（mscorlib / WindowsBase / PresentationFramework）全出名字，
//      **客户端自己的托管帧依然一条都不出**（unknownRatio 0.129，unknown=700/5416，
//      其中最热列表里 159 条是 ***unknown***）。
//   ② 探针里那条"看 xperf 符号日志提到哪个客户端模块"的检查**恒为空** ——
//      因为 `hotstacks()` 只在失败路径回带 `raw`，成功路径没有这个字段 ⇒ **空洞检查**。
//   ③ 探针里那条"客户端的模块在不在 trace 里"用的是 `hs.modules` ——
//      `parseStackReport` 一直在解析模块表，但 `summarize` **把它丢了** ⇒ 同样恒为 undefined。
// 也就是：**两次都查了答不上来的字段，而能答上来的那个字段根本到不了调用方手里。**
{
  const { composeSymbolPath, trimXperfRaw, moduleKey, SILENT_MODULE_MIN_HITS } = await import('../lib/trace.mjs')
  const DFLT = 'srv*C:\\cache\\symbols*https://msdl.microsoft.com/download/symbols'

  // 8a. 符号路径是**整串替换**：只写一个目录就会把系统符号全丢掉 —— 必须被接上，且必须**如实上报**
  const empty = composeSymbolPath('', DFLT)
  check('未配置 → 用默认公网链，composed=false', empty.value === DFLT && empty.composed === false, JSON.stringify(empty))
  const plain = composeSymbolPath('C:\\client\\Product\\Bin', DFLT)
  check('只写目录 → **接上**默认链（不是替换掉）', plain.value === 'C:\\client\\Product\\Bin;' + DFLT, plain.value)
  check('只写目录 → composed=true（调用方必须转达给用户）', plain.composed === true)
  const srv = composeSymbolPath('srv*C:\\c*https://msdl.microsoft.com/download/symbols;C:\\bin', DFLT)
  check('自己写了 srv* → 原样使用（尊重"只用本地符号"的意图）', srv.value === 'srv*C:\\c*https://msdl.microsoft.com/download/symbols;C:\\bin' && srv.composed === false, JSON.stringify(srv))
  const multi = composeSymbolPath('C:\\a;D:\\b;; ', DFLT)
  check('多目录 + 结尾分号/空白 → 规范化后再接', multi.value === 'C:\\a;D:\\b;' + DFLT, multi.value)
  check('接上后的串再进来不会重复接（幂等）', composeSymbolPath(plain.value, DFLT).value === plain.value)

  // 8b. 成功路径也要能看见 xperf 原话（F-044）
  const rawText = 'line1\nDBGHELP: ntdll.dll symbol loaded\nline3'
  const shortRaw = trimXperfRaw(rawText)
  check('raw 回带原文（成功路径也必须有）', /DBGHELP/.test(shortRaw.raw), shortRaw.raw)
  check('rawBytes 是**真实总字节**（不是截断后的长度）', shortRaw.rawBytes === rawText.length, String(shortRaw.rawBytes))
  check('未截断时 rawTruncated=false', shortRaw.rawTruncated === false)
  const longRaw = trimXperfRaw('x'.repeat(9000), { maxChars: 100 })
  check('超长被截断且有截断标记（不假装完整）', longRaw.raw.length === 100 && longRaw.rawTruncated === true, String(longRaw.raw.length))
  check('截断后 rawBytes 仍是真实大小', longRaw.rawBytes === 9000, String(longRaw.rawBytes))
  const filtered = trimXperfRaw('progress bar\nSYMCHK: foo.pdb matched\nother noise', { symbolOnly: true })
  check('debugSymbols → 只留符号相关行（过滤说清楚）', /SYMCHK/.test(filtered.raw) && !/progress/.test(filtered.raw) && filtered.rawFiltered === true, filtered.raw)
  const noSymLine = trimXperfRaw('a\nb', { symbolOnly: true })
  check('没有符号行时**不强过滤**（否则 raw 会变成空的假象）', noSymLine.raw === 'a\nb', noSymLine.raw)

  // 8c. 模块表 + "有命中却没函数名"的模块，必须**透到调用方**（F-043）
  //     用真报告做变换：把模块表里 clr.dll 的名字换成一个**函数表里不存在**的模块名 ⇒
  //     "该模块有独占命中却没有一条函数名"这个形态就出现了。
  const renamed = managedHtml.replace(/(<a id='ME[0-9a-f]+' href='#MI[0-9a-f]+'>)clr\.dll(<\/a>)/i, '$1Acme.Trader.Presentation.ViewModels.dll$2')
  check('夹具变换生效（确实换了模块名）', renamed !== managedHtml)
  const p2 = parseStackReport(renamed)
  check('模块名比较忽略 .dll/.ni 扩展名（否则永远匹配不上）',
    moduleKey('mscorlib.dll') === moduleKey('mscorlib') && moduleKey('Foo.ni.dll') === moduleKey('foo'))
  check('识别出"有独占命中却没有函数名"的模块', (p2.silentModules || []).some((m) => /Acme.Trader\.Presentation\.ViewModels/.test(m.module)),
    JSON.stringify((p2.silentModules || []).map((m) => m.module)))
  check('门槛必须真的按 hits/percent 过滤（噪声模块不入表）',
    (p2.silentModules || []).every((m) => m.hits >= SILENT_MODULE_MIN_HITS && parseFloat(String(m.percent)) >= 1),
    JSON.stringify(p2.silentModules))
  const s2 = summarize(p2, { topN: 5 })
  check('summarize 透出 modules（此前被丢掉 ⇒ 调用方拿不到模块表）', Array.isArray(s2.modules) && s2.modules.length > 0, 'count=' + (s2.modules || []).length)
  check('summarize 透出 silentModules', Array.isArray(s2.silentModules), typeof s2.silentModules)
  check('渲染文本里点名了那个"只有模块级线索"的模块', /Acme.Trader\.Presentation\.ViewModels\.dll/.test(s2.text), s2.text.slice(0, 200))
  check('渲染文本同时给出"别当成没有热点"的告诫', /没有热点/.test(s2.text))
  check('渲染文本指出 DSH_PERF_SYMBOL_PATH 是整串替换（把踩过的坑写进下一次的提示里）', /整串替换/.test(s2.text))

  // 8d. 渲染层：agent 只看得见这段文本 —— 对象字段里的东西等于没说
  const { renderHotstacks } = await import('../lib/render.mjs')
  const rendered = renderHotstacks({
    ok: true, text: 'T', reportPath: 'C:\\r.html', reportBytes: 1024, elapsedMs: 1000, symbols: true,
    xperfRaw: 'DBGHELP: loaded Acme.Trader.Presentation.ViewModels.pdb', xperfRawBytes: 41666,
    symbolPath: 'srv*C:\\c*https://msdl.microsoft.com/download/symbols;C:\\bin', symbolPathComposed: true,
    symbolPathNote: '已接上默认公网链',
  })
  check('渲染里出现 xperfRaw 内容（否则 debugSymbols 对 agent 等于不存在）', /Acme.Trader\.Presentation\.ViewModels\.pdb/.test(rendered))
  check('渲染里说明 raw 是截断的且给真实字节数', /41666/.test(rendered), rendered.slice(-200))
  check('渲染里出现生效符号路径', /生效符号路径/.test(rendered))
  check('渲染里出现"已接上默认公网链"这条事实', /已接上默认公网链/.test(rendered))
  const rendered2 = renderHotstacks({ ok: true, text: 'T', reportPath: 'r', reportBytes: 1, elapsedMs: 1, symbols: true })
  check('没有 raw / symbolPathNote 时不硬塞空块（不制造噪声）', !/xperf 原话/.test(rendered2) && !/符号路径/.test(rendered2), rendered2)
  const scoped = renderHotstacks({ ok: true, text: 'T', reportPath: 'r', reportBytes: 1, elapsedMs: 1, symbols: false, eventScope: 'Sampled Profile', metric: 'stack-sample-count' })
  check('渲染公开 hotstacks 事件范围和指标', /Sampled Profile/.test(scoped) && /stack-sample-count/.test(scoped), scoped)

  // 8e. 未解析帧"还剩多少信息"必须分桶（F-043 的核心可操作结论）
  //     实测：客户端那次 871 个未解析帧**全部**是 `***unknown***!***unknown***`（连模块名都没有）。
  //     两种形态的价值完全不同，混成一个数字就会被读成"unknown 里也许藏着客户端模块"。
  const p3 = parseStackReport(managedHtml)
  check('unknownDetail 拆分 withModule / withoutModule（两种形态价值不同）',
    typeof p3.unknownDetail.withModule === 'number' && typeof p3.unknownDetail.withoutModule === 'number',
    JSON.stringify(p3.unknownDetail))
  check('两桶之和 = unknown 总数（不能漏账）',
    p3.unknownDetail.withModule + p3.unknownDetail.withoutModule === p3.unknownDetail.unknown,
    JSON.stringify(p3.unknownDetail))
  const s3 = summarize(p3, { topN: 5 })
  check('unknownDetail 带 byModule（"未知集中在谁身上"必须可算，而不是只能靠印象）',
    Array.isArray(p3.unknownDetail.byModule), JSON.stringify(p3.unknownDetail.byModule))
  check('渲染里出现最热模块表（独占命中 —— 真金白银的落点）', /最热模块/.test(s3.text), s3.text.slice(0, 200))
  check('最热模块段自带"独占 ≠ 包含"的提醒（防止按链上名字多少下结论）', /独占 ≠ 包含/.test(s3.text))
  if (p3.unknownDetail.unknown > 0) {
    check('渲染文本说出"多少个连模块名都没有"', /连模块名都没有/.test(s3.text), s3.text.slice(0, 300))
    check('渲染文本说出"多少个至少知道模块"（可归因的那部分）', /至少知道模块/.test(s3.text))
    check('渲染文本警示"早就启动的 .NET 应用方法名可能整批点不出来"', /早就启动|整批/.test(s3.text))
  } else {
    check('（本夹具没有未解析帧，跳过该分支的文本断言）', true)
  }

  // 8f. 「这段窗口是空闲形态」必须由工具说出来（F-043 现场：我拿一段空闲采样去解释"慢在哪"）
  const { waitingWindowHint } = await import('../lib/trace.mjs')
  const idleReport = {
    hotFunctions: [
      { name: 'ntdll.dll!_RtlUserThreadStart', percent: '99.90%', exclusive: 0, inclusive: 100 },
      { name: 'WindowsBase.dll!System.Windows.Threading.Dispatcher.PushFrameImpl(...)', percent: '20.00%', exclusive: 0, inclusive: 20 },
      { name: 'WindowsBase.dll!DomainBoundILStubClass.IL_STUB_PInvoke(System.Windows.Interop.MSG ByRef)', percent: '48.00%', exclusive: 1, inclusive: 48 },
      { name: 'user32.dll!GetMessageW', percent: '55.00%', exclusive: 2, inclusive: 55 },
    ],
    butterfly: [],
  }
  const hint = waitingWindowHint(idleReport)
  check('识别出"空闲消息泵"窗口并给出百分比', hint && /GetMessage/.test(hint.frame) && hint.percent === '55.00%', JSON.stringify(hint))
  check('提示里给出下一步（在卡顿窗口内重采）', hint && /perf_probe/.test(hint.note) && /窗口内/.test(hint.note))
  check('提示里说清"这只否掉整体在烧 CPU，不能说一切正常"（旧写法"是**正常**读数"已删）',
    hint && /不能\*\*断定/.test(hint.note) && !/是\*\*正常\*\*读数/.test(hint.note), hint && hint.note)
  // 反向：卡死现场那种"在等锁/在 Invoke"**不该**触发这条提示（狼来了比漏报更坏）
  const stallReport = {
    hotFunctions: [
      { name: 'mscorlib.dll!System.Threading.Monitor.Wait(System.Object, Int32)', percent: '88.00%', exclusive: 5, inclusive: 88 },
      { name: 'System!System.Net.Sockets.Socket.Receive(...)', percent: '91.00%', exclusive: 3, inclusive: 91 },
    ],
    butterfly: [],
  }
  check('泛化的"等待/锁/IO"**不**触发空闲提示（否则真需要它时会乱响）', waitingWindowHint(stallReport) === null)
  check('未达到阈值（30%）的消息泵帧也不触发', waitingWindowHint({ hotFunctions: [{ name: 'user32.dll!PeekMessageW', percent: '12.00%' }], butterfly: [] }) === null)
  const s4 = summarize(idleReport, { topN: 4 })
  check('渲染文本里出现空闲形态告警（新措辞：只描述"大部分时间在等消息"）',
    /消息泵等待/.test(s4.text) && /GetMessage/.test(s4.text), s4.text.slice(0, 220))
  check('结构化结果也带 waitingWindow（机器可读，不只是文本）',
    s4.waitingWindow && /GetMessage/.test(s4.waitingWindow.frame), JSON.stringify(s4.waitingWindow))

  // 8g. 真机那一段：**独占采样 91% 落在内核**，而第一版判定**没触发**
  //     （消息泵帧只在链上深层出现、没有百分比）⇒ "工具不说"就等于让 agent
  //     把"内核占比高"读成"内核有瓶颈"。这条分支就是为它加的。
  const kernelReport = {
    hotFunctions: [
      { name: 'ntdll.dll!_RtlUserThreadStart', percent: '99.90%', exclusive: 0, inclusive: 100 },
      { name: 'ntkrnlmp.exe!KiSystemServiceCopyEnd', percent: '91.21%', exclusive: 0, inclusive: 91 },
    ],
    butterfly: [],
    modules: [{ module: 'ntkrnlmp.exe', hits: 26507, percent: '91.20%' }, { module: 'ntdll.dll', hits: 2373, percent: '8.16%' }],
  }
  const kw = waitingWindowHint(kernelReport)
  check('内核独占占比高 → 必须出声（kind=kernel-dominant）', kw && kw.kind === 'kernel-dominant', JSON.stringify(kw))
  check('内核分支**必须同时摆出"空闲等待"与"被阻塞"两种可能**（不许替读者选一个）',
    kw && /空闲等待/.test(kw.note) && /被阻塞/.test(kw.note), kw && kw.note)
  check('内核分支给出区分办法（perf_probe 定窗口 + perf_dump 看栈）',
    kw && /perf_probe/.test(kw.note) && /perf_dump/.test(kw.note), kw && kw.note)
  check('内核占比不到门槛（<60%）不触发',
    waitingWindowHint({ hotFunctions: [], butterfly: [], modules: [{ module: 'ntkrnlmp.exe', hits: 5, percent: '12.00%' }] }) === null)
  const s5 = summarize(kernelReport, { topN: 2 })
  check('渲染文本里出现内核形态告警', /内核\/系统调用路径/.test(s5.text), s5.text.slice(0, 200))

  // ------------------------------------------------ 8h. F-050：Codex r37 对抗性复核抓出的 12 条（逐条钉住）
  // 每条都用复核报告里给的**可复现输入**当断言素材 —— 它们不是"可能有问题"，是"这些输入必然出错"。
  const { isKernelSideModule, sortModulesByHits, isUnknownBucket } = await import('../lib/trace.mjs')

  // ① P1：`GetMessageDigest` 不是消息泵（子串匹配把结论反过来过）
  const digest = waitingWindowHint({
    hotFunctions: [
      { name: 'Client.dll!GetMessageDigest', percent: '30.00%', exclusive: 30, inclusive: 30 },
      { name: 'Client.dll!BusyWork', percent: '70.00%', exclusive: 70, inclusive: 70 },
    ], butterfly: [], modules: [],
  })
  check('★ `Client.dll!GetMessageDigest` **不**触发"空闲消息泵"（子串误判会让结论反过来）', digest === null, JSON.stringify(digest))
  const realPump = waitingWindowHint({ hotFunctions: [{ name: 'user32.dll!GetMessageW', percent: '55.00%', exclusive: 0, inclusive: 55 }], butterfly: [], modules: [] })
  check('真的消息泵 API（user32.dll!GetMessageW，55%）仍然触发', realPump && realPump.kind === 'idle-message-pump', JSON.stringify(realPump))
  check('消息泵分支不再替读者下判语（旧写法"是**正常**读数"必须消失）',
    realPump && !/是\*\*正常\*\*读数/.test(realPump.note) && /不能\*\*断定/.test(realPump.note), realPump && realPump.note)
  check('消息泵分支要求**过半**（30% 不算主角）',
    waitingWindowHint({ hotFunctions: [{ name: 'user32.dll!GetMessageW', percent: '30.00%' }], butterfly: [], modules: [] }) === null)

  // ② P2：内核侧模块 —— 驱动要认出来，前缀猜测要禁掉（`nvlddmkm.sys` 反例 / `ntkrnlmp-helper.dll` 反例）
  check('驱动 .sys 算内核侧（Codex 反例：nvlddmkm.sys 91% 原先什么都不报）', isKernelSideModule('nvlddmkm.sys'))
  check('内核镜像精确匹配', isKernelSideModule('ntkrnlmp.exe') && isKernelSideModule('ntdll.dll'))
  check('★ 前缀猜测被禁掉：`ntkrnlmp-helper.dll` **不算**内核镜像', !isKernelSideModule('ntkrnlmp-helper.dll'))
  check('`ntdll.exe` 也不算（精确匹配而不是正则前缀）', !isKernelSideModule('ntdll.exe'))
  const drv = waitingWindowHint({ hotFunctions: [], butterfly: [], modules: [{ module: 'nvlddmkm.sys', hits: 9120, percent: '91.20%' }, { module: 'Client.dll', hits: 880, percent: '8.80%' }] })
  check('驱动占 91% 时必须出声', drv && drv.kind === 'kernel-dominant', JSON.stringify(drv))
  check('内核分支摆出三种可能（空闲/被阻塞/内核自己在忙），不替读者选', drv && /空闲等待/.test(drv.note) && /被阻塞/.test(drv.note) && /内核自己在忙/.test(drv.note))

  // ③ P2：模块表按命中排序（不能信报告行序）
  check('★ 模块表按命中排序（Codex 反例：10 个 1 命中的模块排在前面会挤掉真正的第一名）',
    sortModulesByHits([{ module: 'm1.dll', hits: 1, percent: '1%' }, { module: 'ntkrnlmp.exe', hits: 90, percent: '90%' }])[0].module === 'ntkrnlmp.exe')
  const unsorted = { hotFunctions: [], butterfly: [], modules: [{ module: 'Client.dll', hits: 8, percent: '8.00%' }, { module: 'ntkrnlmp.exe', hits: 92, percent: '92.00%' }] }
  check('未排序输入下内核判定仍然正确（不再依赖行序）', waitingWindowHint(unsorted) !== null)

  // ④ P2：模块表被截断必须说明（"没列出"≠"不在报告里"）
  const manyMods = { hotFunctions: [], butterfly: [], modules: Array.from({ length: 40 }, (_, i) => ({ module: 'm' + i + '.dll', hits: 40 - i, percent: '2%' })) }
  const sMany = summarize(manyMods, { topN: 1 })
  check('★ 模块表截断时给出总数与截断标记（Codex 反例：第 31 个模块"看起来不存在"）',
    sMany.modules.length === 30 && sMany.modulesTotal === 40 && sMany.modulesTruncated === true,
    JSON.stringify({ n: sMany.modules.length, total: sMany.modulesTotal, trunc: sMany.modulesTruncated }))

  // ⑤ P2：`***unknown***` 是一个**未归因的桶**，不是模块身份
  check('`***unknown***` 被识别为"桶"而不是模块名', isUnknownBucket('***unknown***') && !isUnknownBucket('Client.dll'))
  const unknownRow = parseStackReport("<h2>Modules by Exclusive Hits</h2><table><tr><td>***unknown***</td><td>754</td><td>8.59%</td><td>0</td><td>0</td></tr></table><h2>Functions by UniInclusive Hits</h2><table><tr><td>***unknown***!***unknown***</td><td>754</td><td>8.59%</td><td>754</td></tr></table>")
  check('★ `***unknown***` **不**进"有命中却没函数名的模块"（那是编出来的身份）',
    !(unknownRow.silentModules || []).some((m) => isUnknownBucket(m.module)), JSON.stringify(unknownRow.silentModules))
  check('但它作为"未归因桶"被单独带出来（信息不丢）',
    unknownRow.unassignedModuleBucket && unknownRow.unassignedModuleBucket.hits === 754, JSON.stringify(unknownRow.unassignedModuleBucket))

  // ⑥ P2：未解析比例的口径 —— 分母是"报告里解析到的"，不是"打印出来的"
  const denom = summarize(parseStackReport("<h2>Functions by UniInclusive Hits</h2><table><tr><td>Client.dll!Run</td><td>99</td><td>99%</td><td>99</td></tr><tr><td>foo!***unknown***</td><td>1</td><td>1%</td><td>1</td></tr></table>"), { topN: 1 })
  check('★ 口径不说"本次打印的 N 个"（topN 会让分母与眼前所见不一致）',
    /报告里解析到的/.test(denom.text) && !/本次打印的/.test(denom.text), denom.text.slice(0, 160))

  // ⑦ P3：`!***unknown***`（空前缀）不能既算"模块已知"又被 byModule 归到"(模块未知)"
  const bareUnknown = parseStackReport("<h2>Functions by UniInclusive Hits</h2><table><tr><td>!***unknown***</td><td>1</td><td>100%</td><td>1</td></tr></table>")
  check('★ 空前缀不会被算成"已知模块"（两个字段不许互相矛盾）',
    bareUnknown.unknownDetail.withModule === 0 && bareUnknown.unknownDetail.withoutModule === 1,
    JSON.stringify(bareUnknown.unknownDetail))

  // ⑧ P3：rawBytes 必须是**字节**（不是 UTF-16 码元数）
  const cn = trimXperfRaw('符号')
  check('★ rawBytes 按 UTF-8 字节算（Codex 反例：`符号` 原报 2"字节"，真值 6）', cn.rawBytes === 6 && cn.rawChars === 2,
    JSON.stringify({ rawBytes: cn.rawBytes, rawChars: cn.rawChars }))

  // ⑨ P2：符号行过滤必须**保留续行/失败原因**（反例：Access is denied. / HTTP 403 被丢掉）
  const ctx = trimXperfRaw('DBGHELP: loading Client.pdb\n  Access is denied.\n  HTTP status: 403', { symbolOnly: true })
  check('★ 过滤后仍保留失败原因（缩进续行）', /Access is denied/.test(ctx.raw) && /403/.test(ctx.raw), ctx.raw)
  const lost = trimXperfRaw('DBGHELP: ok\n6728 Events were lost in this trace.', { symbolOnly: true })
  check('★ 过滤后仍保留"丢事件"这类关键行', /Events were lost/.test(lost.raw), lost.raw)

  // ⑩ P1：渲染层不得把"超时"直接说成"卡在符号解码"
  const toRender = renderHotstacks({ ok: false, timedOut: true, error: 'xperf 出报告超时', hint: '若症状是 ~0% CPU 且报告 0 字节，才更像卡在符号解码' })
  check('★ 超时不再被断言为"卡在符号解码"（只说"到点了 + 生产者给的**可能性**"）',
    /可能性不是诊断/.test(toRender) && !/卡在符号解码。别调小/.test(toRender), toRender.slice(0, 240))
  const toRender2 = renderHotstacks({ ok: false, timedOut: true, error: 'xperf 出报告超时' })
  check('生产者没给 hint 时也不自己编诊断', !/卡在符号解码$/.test(toRender2) && /先别急着调小 timeoutMs/.test(toRender2), toRender2.slice(0, 200))
}

// ------------------------------------------------- 9. R1-03 / R1-05：会话标记的位置契约 + 清理器真的看得见证据
//
// 现场（2026-09-14 夜，真机完整复现）：
//   `perf_trace(action="start")` 返回成功后**立刻**查 `action="status"`，它说
//   「没有进行中的采样（按标记），也没有找到 etl」—— 而此刻 `logman query -ets` 里
//   `WPR_initiated_WprApp_WPR System Collector` 正 Running、etl 也正在写。
//   根因：标记写在下一次调用**重新生成**的时间戳目录里（`runDir()` 每次取 `new Date()`），
//   于是 status 去 `trace-<T2>/` 找 `start` 写在 `trace-<T1>/` 的标记 ⇒ 恒找不到。
//   同一根因还让 `stop/cancel` 删不掉真标记、并让 `evidence-clean.mjs`（按证据目录根读）
//   的"采样进行中不删 etl"保护从未生效。R1-05 则是同一处布局的另一半：
//   `perf_clean` 只扫证据目录**顶层文件**，而 etl 在 `trace-<stamp>/` 子目录里 ⇒
//   盘上躺着 6.71 GB 时它报「0 个文件命中，共 0 字节」。
//
// ⚠ 这一段刻意用**真实调用**（`trace({action:'status'})` + `cleanEvidence(...)`），
//   而不是只做文本断言 —— 因为这两个缺陷的本质都是"**读写两端对同一个契约各写各的**"，
//   文本断言抓不到，只有让两侧真的对上才抓得到。
{
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { traceSessionFile } = await import('../lib/trace.mjs')
  const { cleanEvidence } = await import('../lib/evidence-clean.mjs')

  const evDir = mkdtempSync(join(tmpdir(), 'dsh-perf-session-'))
  try {
    const marker = traceSessionFile(evDir)
    check('★ 标记文件必须是证据目录的**直接子文件**（不许落在 trace-<stamp> 运行目录里）',
      dirname(marker).toLowerCase() === evDir.toLowerCase(), marker)

    // 9a. 行为：status 必须看得见"上一次调用写下的"标记（两次调用的时间戳必然不同）
    const runEtl = join(evDir, 'trace-2026-01-01T00-00-00', 'trace.etl')
    writeFileSync(marker, JSON.stringify({ etlPath: runEtl, startedAt: Date.now() - 5000, profile: 'cpu' }), 'utf8')
    const t = makeTrace({ evidenceDir: evDir })
    const s1 = await t.trace({ action: 'status', tag: 'aaa' })
    const s2 = await t.trace({ action: 'status' })
    check('★★ status 看得见这份标记（running:true）—— 原实现去新时间戳目录里找 ⇒ 恒 false',
      s1.running === true && s2.running === true, JSON.stringify({ s1: s1.running, s2: s2.running }))
    check('★ 并据此报出 etlPath 与已跑时长（不是 null）',
      String(s1.etlPath).toLowerCase() === runEtl.toLowerCase() && Number(s1.elapsedMs) >= 4000,
      JSON.stringify({ etlPath: s1.etlPath, elapsedMs: s1.elapsedMs }))
    check('★ 提示语据此给出 stop 的正确 etlPath（不要再让人去 start 第二次）',
      /采样进行中/.test(String(s1.hint)) && String(s1.hint).includes(runEtl), String(s1.hint).slice(0, 160))

    // 9b. 跨组件：perf_clean 必须看得见运行子目录里的 etl，并在采样进行中**跳过**它
    //     ⚠ "看得见"的证据在 `skipped` 里，不在 `candidates` 里 —— 被有理由跳过的文件
    //       是不能删的候选，两种清单本来就不同（不要把 skipped 读成"没扫到"）。
    mkdirSync(join(evDir, 'trace-2026-01-01T00-00-00'), { recursive: true })
    writeFileSync(runEtl, 'x'.repeat(2048), 'utf8')
    const dry = cleanEvidence({ dir: evDir, confirm: false })
    check('★★ R1-05：perf_clean 看得见子目录里的 etl（出现在 skipped 且理由是"采样进行中"）',
      dry.skipped.some((s) => s.path.toLowerCase() === runEtl.toLowerCase() && /采样进行中/.test(s.reason)),
      JSON.stringify({ skipped: dry.skipped, candidates: dry.candidates.map((c) => c.path) }))
    const cleaned = cleanEvidence({ dir: evDir, confirm: true })
    check('★★ 采样进行中：etl 必须被"跳过"而不是删掉（写者与读者的标记位置对齐了）',
      cleaned.deleted.length === 0 && cleaned.skipped.some((s) => /采样进行中/.test(s.reason)),
      JSON.stringify({ deleted: cleaned.deleted, skipped: cleaned.skipped.map((s) => s.reason) }))
    check('★ 文件确实还在盘上（"跳过"不能只是嘴上说说）', existsSync(runEtl), runEtl)

    // 9c. 反证：标记拿掉后，同一份 etl 必须**正面落进 candidates** 并真的被删掉
    //     （前者正是 R1-05 的靶心：原实现只扫顶层 ⇒ 这里恒为空；后者证明 9b 的"跳过"是定点生效的）
    rmSync(marker, { force: true })
    const dry2 = cleanEvidence({ dir: evDir, confirm: false })
    check('★★ R1-05（正面）：标记不在时，子目录里的 etl 必须落进 candidates（原实现这里恒为空）',
      dry2.candidates.some((c) => c.path.toLowerCase() === runEtl.toLowerCase() && c.bytes === 2048),
      JSON.stringify({ candidates: dry2.candidates }))
    const cleaned2 = cleanEvidence({ dir: evDir, confirm: true })
    check('★ 标记移除后同一份 etl 被删掉', cleaned2.deleted.length === 1 && !existsSync(runEtl), JSON.stringify(cleaned2.deleted))

    // 9d. 符号缓存**永远不碰**（跨运行共享的 srv* 缓存，几百 MB 到 GB 级，删了就要重新下）
    mkdirSync(join(evDir, 'symbol-cache', 'symbols'), { recursive: true })
    const cached = join(evDir, 'symbol-cache', 'symbols', 'some.pdb.dmp')
    writeFileSync(cached, 'y'.repeat(64), 'utf8')
    const c3 = cleanEvidence({ dir: evDir, confirm: false })
    check('★ symbol-cache 子树不出现在候选里（删它 = 下次出报告重新下 GB 级符号）',
      !c3.candidates.some((c) => c.path.toLowerCase().includes('symbol-cache')), JSON.stringify(c3.candidates.map((c) => c.path)))
    check('★ 也不删目录本身（只列文件）', c3.ok === true && existsSync(join(evDir, 'symbol-cache')))

    // 9e. **边界**：不是"我们自己建的运行目录"的子目录一律**不进**。
    //     为什么必须有这条：R1-05 的第一版写成"任意子目录都下潜一层"，于是把工具指向 `%TEMP%`
    //     这类父目录时，它会钻进**别人的**子目录里去删 .dmp/.etl —— 正是本文件第 3 条设计原则
    //     （只在自己管的目录里动）要防的事。测试套当时就把它抓下来了（evidence-clean.test.mjs 的红）。
    mkdirSync(join(evDir, 'someone-elses-folder'), { recursive: true })
    writeFileSync(join(evDir, 'someone-elses-folder', 'other.dmp'), 'z'.repeat(64), 'utf8')
    const c4 = cleanEvidence({ dir: evDir, confirm: false })
    check('★★ 非运行目录命名的子目录**不进**（不越界动别处的文件）',
      !c4.candidates.some((c) => c.path.includes('someone-elses-folder')) &&
      !c4.skipped.some((s) => String(s.path).includes('someone-elses-folder')),
      JSON.stringify({ cand: c4.candidates.map((c) => c.path), skip: c4.skipped.map((s) => s.path) }))
    check('★ 而 `trace-<stamp>` 这种**我们自己的**运行目录仍然进（下潜不是被一刀砍掉）',
      cleanEvidence({ dir: evDir, confirm: false, what: 'dumps' }).totalBytes >= 0 &&
      // 用一份新的 run 目录反证下潜仍在工作
      (() => {
        mkdirSync(join(evDir, 'trace-2026-02-02T00-00-00'), { recursive: true })
        writeFileSync(join(evDir, 'trace-2026-02-02T00-00-00', 'probe.dmp'), 'q'.repeat(128), 'utf8')
        const c5 = cleanEvidence({ dir: evDir, confirm: false })
        return c5.candidates.some((c) => c.path.endsWith('probe.dmp'))
      })(), '')
  } finally { try { rmSync(evDir, { recursive: true, force: true }) } catch { /* ignore */ } }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: dsh-perf ETW trace/hotstacks test')
