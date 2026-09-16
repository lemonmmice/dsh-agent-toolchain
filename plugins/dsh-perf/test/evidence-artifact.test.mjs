// dsh-perf 单测：**证据文件必须装得下它被引用来说明的内容**（F-035，2026-09-12 r33）。
//
// 病（在读真实证据文件时查出，不是推测）：
//   `analyzeDump()` 的 `client.analysis.json` 是 **DumpStack.exe 自己写的原始输出** ——
//   只有 `threads[].frames[].{type,method,module,ip}`，**没有任何源码映射**；
//   而「映射到 `<某>.xaml.cs:58`」由 `summarize()`→`srcMap.mapFrames()` 现算，
//   过去只活在内存与渲染文本里，**从未落盘**。
//
//   于是"给用户的说明"里那句「证据：…\perf-evidence\client.analysis.json」指向一个
//   **装不下这个结论**的文件。实测复核该文件：源码扩展名出现 0 次、`suspectLine` 0 次、
//   顶层键里没有 `uiThread` / `srcMap`（只有 dump/engine/…/threadCount/threads）。
//   同一段落那句"证据：…"甚至**连路径都不存在** —— 真实文件在带时间戳的**子目录**里。
//
// 这条与 debug-checklist 的既有类别同源：**"引用了一个不存在的/不含该内容的证据"**，
//   比"没有证据"更坏 —— 它让人以为已经核过了。
//
// 环境无关性：本文件**不硬编码任何本机路径**（仓库策略禁止），
//   真实数据块通过 `DSH_PERF_REAL_ANALYSIS` 或在"插件默认证据目录 / 与其它证据目录同级的
//   perf-evidence"里发现最新的 `*-dump/client.analysis.json` 来取得；找不到就**显式 SKIP 并计数**。
import { summarizeDump, summaryPathFor, writeSummary, makePerf } from '../lib/perf.mjs'
import { envOr } from '../../../lib/env-fallback.mjs'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
let skipped = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
// 环境缺文件时的显式跳过：**不静默当通过**，且计入 skipped 并在结尾报出。
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' — ' + why) }

const tmp = mkdtempSync(join(tmpdir(), 'perf-evidence-artifact-'))

/** 读配置值 —— 直接走工具链共享的 env-fallback（进程环境 → 用户级注册表 → 机器级）。
 *  刻意**不用** powershell 读 HKCU：PS 的 stdout 是控制台 OEM 码页，
 *  按 UTF-8 解码会把带中文的值弄坏（本文件第一版本就踩了，见 F-036）。 */
function envCfg(name) {
  try { return envOr(name) || '' } catch { return '' }
}

/** 组装可能存放 perf 证据的目录（全部来自配置，不写字面路径）。 */
function candidateEvidenceDirs() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_PERF_EVIDENCE_DIR)
  push(envCfg('DSH_PERF_EVIDENCE_DIR'))
  try { push(makePerf({ procName: 'evidence-artifact-probe', srcRoot: 'x' }).evidenceDir()) } catch { /* ignore */ }
  push(join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'))
  for (const n of ['DSH_UI_EVIDENCE_DIR', 'DSH_HANG_EVIDENCE_DIR']) {
    const v = process.env[n] || envCfg(n)
    if (v) push(join(dirname(v), 'perf-evidence'))
  }
  return out
}

/** 找到最近一次真机 dump 的**原始**分析文件（DumpStack 输出）。 */
function findRawAnalysis() {
  const explicit = process.env.DSH_PERF_REAL_ANALYSIS
  if (explicit) return existsSync(explicit) ? explicit : null
  let best = null
  for (const root of candidateEvidenceDirs()) {
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || !/-dump$/i.test(e.name)) continue
      const p = join(root, e.name, 'client.analysis.json')
      if (!existsSync(p)) continue
      let m = 0
      try { m = Number(readFileSync(p, 'utf8').length) } catch { /* ignore */ }
      if (!best || m > best.m) best = { p, m }
    }
  }
  return best ? best.p : null
}

const SRC_ROOT = process.env.DSH_PERF_SRC_ROOT || envCfg('DSH_PERF_SRC_ROOT') || envCfg('DSH_HANG_SRC_ROOT') || ''
const RAW_ANALYSIS = findRawAnalysis()

// ---------------------------------------------------------------------------
// 1. 路径推导：归纳结果**绝不能覆盖**原始证据
// ---------------------------------------------------------------------------
{
  const raw = join(tmp, 'client.analysis.json')
  const sp = summaryPathFor(raw)
  check('summaryPathFor 与原路径**不同**（否则就是用归纳覆盖原始证据）', sp !== raw, `${raw} -> ${sp}`)
  check('summaryPathFor 产出并列的 .analysis.summary.json',
    sp.endsWith('.analysis.summary.json') && sp.includes('client.analysis.summary.json'), sp)

  const odd = join(tmp, 'weird-name.json')
  check('非 .analysis.json 结尾时也有兜底后缀（仍然不覆盖）', summaryPathFor(odd) !== odd, summaryPathFor(odd))
  check('大小写不敏感（.ANALYSIS.JSON 同样识别）',
    summaryPathFor(join(tmp, 'x.ANALYSIS.JSON')).endsWith('.analysis.summary.json'),
    summaryPathFor(join(tmp, 'x.ANALYSIS.JSON')))
}

// ---------------------------------------------------------------------------
// 2. ★ 核心：落盘的归纳文件**真的含有** `.cs:行号` 映射（文档拿它当证据时声称的东西）
// ---------------------------------------------------------------------------
{
  const DUMP = {
    dump: 'client.dmp',
    threads: [
      { managedId: 1, osId: 100, uiLikely: true, lockCount: 0, frames: [
        { type: '', method: '', module: '', ip: '7670106C' },                        // 未解析帧
        { type: 'App.MainWindow', method: 'OnLoaded', module: 'Client.dll' },         // 可映射
      ] },
      { managedId: 12, osId: 200, uiLikely: false, lockCount: 3, frames: [
        { type: 'System.Threading.Monitor', method: 'Wait', module: 'mscorlib.dll' },
      ] },
    ],
  }
  const fakeMap = {
    mapFrames: (frames) => frames.map((f) => ({ ...f, src: f.method === 'OnLoaded'
      ? { file: 'App/MainWindow.xaml.cs', line: 42, where: 'method', text: 'public void OnLoaded()', candidates: 1 }
      : null })),
    status: () => ({ usable: true, srcRoot: '(stub)', typesResolved: 1, typesMissed: 2 }),
  }
  const summary = summarizeDump(DUMP, fakeMap)
  check('前置：内存中的归纳结果含 .cs:42 映射（否则后面的断言无意义）',
    JSON.stringify(summary).includes('MainWindow.xaml.cs'), '')

  const w = writeSummary(join(tmp, 'client.analysis.json'), summary)
  check('writeSummary 报告成功且无错误', w.error === null && w.bytes > 0, JSON.stringify(w))
  check('落盘文件确实存在', existsSync(w.summaryPath), w.summaryPath)

  const persisted = readFileSync(w.summaryPath, 'utf8')
  check('★ 落盘文件**含有**源码「文件:行号」映射（这就是文档引用的内容）',
    persisted.includes('MainWindow.xaml.cs') && persisted.includes('"line": 42'), persisted.slice(0, 160))
  check('★ 落盘文件含有 uiThread（原始 DumpStack 输出里没有这个键）', /"uiThread"/.test(persisted), '')
  check('★ 落盘文件含有 srcMap 健康度（可判断"没映射上"的原因）',
    /"srcMap"/.test(persisted) && /framesResolved/.test(persisted), '')
  check('落盘文件是合法 JSON 且可解回同样内容',
    (() => { try { return JSON.parse(persisted).srcMap.framesResolved === 1 } catch { return false } })())
}

// ---------------------------------------------------------------------------
// 3. 写失败必须**报出来**，不能吞（否则又回到"引用了一个不存在的证据文件"）
// ---------------------------------------------------------------------------
{
  const w = writeSummary(join(tmp, 'no-such-dir-xyz', 'client.analysis.json'), { ok: true })
  check('★ 目录不存在时 writeSummary 返回 error（不抛、不静默）',
    typeof w.error === 'string' && w.error.length > 0, JSON.stringify(w))
  check('写失败时 bytes=0（供调用方判断"文件没落成"）', w.bytes === 0, String(w.bytes))
  check('写失败时仍回填 summaryPath（调用方知道本来想写哪儿）',
    typeof w.summaryPath === 'string' && w.summaryPath.length > 0, w.summaryPath)

  // @codex r34 指出：只测了"目录不存在"，四类 OS 注入（只读目录/超长路径/磁盘满/目标已存在目录）未覆盖。
  // 其中"**目标是一个已存在的目录**"是本机**确定性**可复现的那一类，补上；
  // 另三类无法在不做破坏性注入的前提下真机复现 —— **不声称它们已验证**（已如实写进 PROGRESS/文档）。
  {
    const dirCase = join(tmp, 'dircase')
    mkdirSync(dirCase, { recursive: true })
    const target = join(dirCase, 'client.analysis.json')
    // 先把它**要写的那个路径**占成一个目录 ⇒ writeFileSync 必 EISDIR
    mkdirSync(summaryPathFor(target), { recursive: true })
    const w2 = writeSummary(target, { ok: true })
    check('★ 目标是已存在的**目录**时，writeSummary 返回 error 而不是抛出（EISDIR 路径）',
      typeof w2.error === 'string' && w2.error.length > 0, JSON.stringify(w2).slice(0, 200))
    check('★ 并且不抛异常（调用方不会被带崩）', (() => {
      try { writeSummary(target, { ok: true }); return true } catch { return false }
    })(), '')
  }
}

// ---------------------------------------------------------------------------
// 4. 源码顺序守卫：analyzeDump 必须**先落盘再返回**（否则又退回"只在内存里"）
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(HERE, '..', 'lib', 'perf.mjs'), 'utf8')
  const fnStart = src.indexOf('async function analyzeDump(')
  check('找到 analyzeDump 定义', fnStart > 0, String(fnStart))
  if (fnStart > 0) {
    const rest = src.slice(fnStart)
    const fnEnd = rest.indexOf('\n  async function ')
    const body = fnEnd > 0 ? rest.slice(0, fnEnd) : rest.slice(0, 4000)
    const iWrite = body.indexOf('writeSummary(')
    const iRet = body.indexOf('return { ok: true, outPath')
    check('★ analyzeDump 里调用了 writeSummary', iWrite > 0, 'not found')
    check('★ writeSummary 出现在 return 之前（先落盘，再返回）',
      iWrite > 0 && iRet > 0 && iWrite < iRet, `write@${iWrite} return@${iRet}`)
    check('★ 返回值里带上 summaryPath（调用方/文档可引用）',
      /summaryPath/.test(body.slice(iRet, iRet + 200)), body.slice(iRet, iRet + 200))
    check('★ 返回值里带上 summaryWriteError（写失败可被发现）',
      /summaryWriteError/.test(body.slice(iRet, iRet + 200)), body.slice(iRet, iRet + 200))
  }
}

// ---------------------------------------------------------------------------
// 5. 拿**真实的** DumpStack 原始输出复核这条历史缺陷（若有该文件）
// ---------------------------------------------------------------------------
{
  if (!RAW_ANALYSIS) {
    skip('真机原始分析复原检查（5 + 6）',
      '未找到 *-dump/client.analysis.json；候选目录=' + candidateEvidenceDirs().join(' ; '))
  } else {
    console.log('  —— 真实原始分析：' + RAW_ANALYSIS)
    const raw = JSON.parse(readFileSync(RAW_ANALYSIS, 'utf8').replace(/^\uFEFF/, ''))
    const rawText = JSON.stringify(raw)

    check('★ 复核 F-035 的病：原始 client.analysis.json 里**没有**任何 .cs 源码路径',
      !/\.xaml\.cs|\.cs"/.test(rawText), rawText.slice(0, 120))
    check('原始文件顶层**没有** uiThread / srcMap（它们是归纳阶段才产生的）',
      !('uiThread' in raw) && !('srcMap' in raw), Object.keys(raw).join(','))
    check('原始文件里有 threads 与帧（所以 dump→线程栈这半截是有的）',
      Array.isArray(raw.threads) && raw.threads.length > 10, String(raw.threads && raw.threads.length))

    const stub = {
      mapFrames: (frames) => frames.map((f) => ({ ...f, src: frames.length && /LaunchPopup|Window|ViewModel|Main/i.test(String(f.type))
        ? { file: 'Presentation/Views/ProbeWindow.xaml.cs', line: 58, where: 'method', text: 'private void ShowCore()', candidates: 3 }
        : null })),
      status: () => ({ usable: true, srcRoot: '(stub)', typesResolved: 1, typesMissed: 0 }),
    }
    const summary = summarizeDump(raw, stub)
    const w = writeSummary(join(tmp, 'real.analysis.json'), summary)
    const persisted = readFileSync(w.summaryPath, 'utf8')
    check('★ 用真机原始数据落盘的归纳文件里，出现了源码「文件:行号」',
      persisted.includes('ProbeWindow.xaml.cs') && persisted.includes('"line": 58'), persisted.slice(0, 160))
    check('归纳后 uiThread 非空（真机 UI 线程解得出）',
      !!summary.uiThread && summary.uiThread.frames.length > 0,
      JSON.stringify(summary.uiThread && summary.uiThread.frames.length))
    // ⚠ 2026-09-15：这条原来写成 `…includes('未解析帧 ip=7670106C')` —— **把某个具体帧 IP 写死了**，
    //   而夹具是"本机**最近一次**真机 dump 的分析"（`findRawAnalysis()` 按文件名长度挑最大的那个）。
    //   于是**只要这台机器上再抓一次 dump**（本次就是这么红的：T1 抓了一份新 dump ⇒ 未解析帧变成 758C106C），
    //   闸就红 —— 那是夹具易变，不是产品缺陷。**改成断言性质**（不变量），并顺手把它变得更强：
    //   ① 每一条"模块为空"的帧都必须被标注成 `未解析帧 ip=…`；② 标注条数 == raw 里真正的未解析帧条数。
    const uiFrames = (raw.threads.find((t) => t && t.isUI) || {}).frames || []
    const unresolvedInRaw = uiFrames.filter((f) => !f || !f.module).length
    const labeled = (summary.uiThread.stack || []).filter((l) => /未解析帧 ip=[0-9A-F]+/i.test(String(l)))
    check('未解析帧被显式标注（性质：每条无模块的帧都带 `未解析帧 ip=…`，不写死具体 IP）',
      labeled.length > 0 && labeled.length >= unresolvedInRaw,
      JSON.stringify({ labeled: labeled.length, unresolvedInRaw, sample: summary.uiThread.stack.slice(0, 2) }))
    check('★ 而**有模块**的帧不许被误标成"未解析"（否则标注等于噪音）',
      !(summary.uiThread.stack || []).some((l) => /未解析帧/.test(String(l)) && /\.dll!|\.exe!/.test(String(l))),
      JSON.stringify((summary.uiThread.stack || []).filter((l) => /未解析帧/.test(String(l))).slice(0, 2)))
  }
}

// ---------------------------------------------------------------------------
// 6. 真 srcMap + 真原始数据：归纳文件里落到的是**真实存在的源文件**
//    （并打印工具实际产出的字符串 —— 文档引用必须逐字对齐，不能靠手写）
// ---------------------------------------------------------------------------
{
  if (!RAW_ANALYSIS || !SRC_ROOT) {
    skip('真 srcMap 落盘核对', RAW_ANALYSIS ? 'DSH_PERF_SRC_ROOT / DSH_HANG_SRC_ROOT 均未配置' : '缺真机原始分析文件')
  } else {
    const { makeSrcMap } = await import('../lib/srcmap.mjs')
    const sm = makeSrcMap({ srcRoot: SRC_ROOT })
    const raw = JSON.parse(readFileSync(RAW_ANALYSIS, 'utf8').replace(/^\uFEFF/, ''))
    const summary = summarizeDump(raw, sm)
    const w = writeSummary(join(tmp, 'real-srcmap.analysis.json'), summary)
    const persisted = readFileSync(w.summaryPath, 'utf8')

    // 注意：断言必须写**结构化**形状（`"file": "….cs"` + `"line": N`），
    //   不能只写 `\.(cs|vb|fs)":` 这种"看起来像"的正则 —— 我第一版就是这么写的，
    //   而漂亮的 JSON 里 `"file": "….cs",` 的下一个字符是逗号，于是**永远匹配不上**，
    //   一条真命中的事实被判成 FAIL（本轮第 5 次"形状靠猜"）。这里两种形状都要求。
    check('★ 真 srcMap 下归纳文件里出现了源码「文件:行号」',
      /"file":\s*"[^"]+\.(?:cs|vb|fs)"/.test(persisted) && /"line":\s*\d+/.test(persisted),
      persisted.slice(0, 200))
    check('真 srcMap 自报健康度（能区分"没符号"与"没源文件"）',
      typeof summary.srcMap === 'object' && Number.isFinite(summary.srcMap.framesResolved),
      JSON.stringify(summary.srcMap).slice(0, 200))
    check('★ 凡是映射上的源文件都**真实存在**（相对源码根解析，不是拼出来的路径）',
      [...persisted.matchAll(/"file":\s*"([^"]+\.(?:cs|vb|fs))"/g)]
        .every((m) => existsSync(join(SRC_ROOT, m[1])) || existsSync(m[1])),
      JSON.stringify([...persisted.matchAll(/"file":\s*"([^"]+\.(?:cs|vb|fs))"/g)].map((m) => m[1]).slice(0, 3)))

    console.log('  —— 真机实际映射结果（文档引用需逐字对齐）——')
    const hits = [...JSON.stringify(summary).matchAll(/"file":\s*"([^"]+\.(?:cs|vb|fs))"[^}]*?"line":\s*(\d+)/g)]
    for (const h of hits.slice(0, 6)) {
      console.log(`     ${h[1]}:${h[2]}   ${existsSync(join(SRC_ROOT, h[1])) ? '[源文件存在 ✓]' : '[源文件不存在 ✗]'}`)
    }
    console.log(`     srcMap 健康度: ${JSON.stringify(summary.srcMap)}`)
  }
}

// ---------------------------------------------------------------------------
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }

const tail = skipped ? `（跳过 ${skipped} 项：环境缺文件/未配置，已如实计数，**未当作通过**）` : ''
console.log(failures
  ? `\nFAILED: ${failures} 项 ${tail}`
  : `\nPASS: dsh-perf evidence-artifact（F-035：证据文件必须装得下它被引用的内容）${tail}`)
process.exit(failures ? 1 : 0)
