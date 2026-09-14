// dsh-hang-inspector 单测：**渲染层必须与生产层的真实形状对齐**。
//
// 为什么单独成文件（Claude 第十二轮审计，2026-09-11）：
//   卡死是用户报的第一场景，而 DSH 面的 `render.mjs` 是"agent 唯一看得见的契约"。
//   但它读的字段，`hang.mjs` **根本不产出** —— 七处：
//     source.line→实际 suspectLine、source.snippet→实际 code、source.method→不存在、
//     suspectThread.frames→实际 stackText、v.threads→实际 threadsSummary、
//     v.running(布尔)→实际 status 字符串、p.summaryFirstLine→实际 summaryFirst。
//   后果：真机上"哪一行代码卡住了"打成 `:undefined`、代码片段与线程栈丢失、监测明明在跑却显示「未运行」、
//   证据包列表永不显示这个包是关于什么的。
//
//   **而且单测全绿** —— 因为它喂的是**手写的假形状**（running / summaryFirstLine / source.line…），
//   与渲染层互相自洽。这正是 F-001/F-021 的同型病。
//
// 本文件的规矩（防再犯）：**输入必须来自生产函数**（buildAnalysis / listPacks / runStatus），
// 渲染层只允许消费这些真实产出；再出现字段名漂移，这里立刻红。
import { buildAnalysis, makeHangInspector } from '../lib/hang.mjs'
import { renderAnalyze, renderPacks, renderStatus, renderPack, renderRun, renderStop } from '../lib/render.mjs'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 「渲染输出泄漏」的三种标志 —— 全是同一病理：**渲染层假设的形状 ≠ 生产层产出的形状**。
//   undefined      → 读了一个生产层从不产出的字段（本文件存在的原因）；
//   [object Object] → 把对象当成字符串拼进文本（第十处：`files.join(', ')` 而 files 是 {name,bytes}）；
//   NaN            → 对非数字做了算术（大小/线程数之类）。
// 只禁 undefined 是不够的：第十处事故恰好绕过了只禁 undefined 的版本。
const LEAK_RES = [/\bundefined\b/, /\[object Object\]/, /\bNaN\b/]
function leakOf(text) {
  for (const re of LEAK_RES) { const m = re.exec(text); if (m) return m[0] }
  return null
}
function checkClean(name, text) {
  const l = leakOf(text)
  if (l === null) { console.log('  ok   ' + name); return }
  failures++
  const idx = text.indexOf(l)
  console.log('  FAIL ' + name + ' — 泄漏 ' + JSON.stringify(l) + '：…' + text.slice(Math.max(0, idx - 60), idx + 40).replace(/\n/g, ' ⏎ ') + '…')
}

const srcRoot = mkdtempSync(join(tmpdir(), 'hang-align-src-'))
const packsRoot = mkdtempSync(join(tmpdir(), 'hang-align-packs-'))
try {
  // ---------------------------------------------------------------- 1. buildAnalysis → renderAnalyze
  writeFileSync(join(srcRoot, 'MyViewModel.cs'),
    'namespace App {\n  public class MyViewModel {\n    public void DoWork() {\n      while (true) { /* 死循环：UI 线程卡这里 */ }\n    }\n  }\n}\n', 'utf8')
  const data = {
    dump: 'x.dmp',
    threads: [
      { managedId: 7, osId: 4321, frames: [
        { type: 'System.Windows.Threading.Dispatcher', method: 'PushFrame', module: 'WindowsBase.dll' },
        { type: 'App.MyViewModel', method: 'DoWork', module: 'App.dll' },
      ] },
      { managedId: 9, osId: 5000, frames: [{ type: 'System.Threading.Thread', method: 'Sleep', module: 'mscorlib.dll' }] },
    ],
  }
  const report = buildAnalysis(data, srcRoot)
  const analyzeReturn = { ok: true, status: 'done', ...report }
  const text = renderAnalyze(analyzeReturn)
  console.log('\n[renderAnalyze 输出]\n' + text + '\n')

  check('生产层给的是 suspectLine（真行号）', typeof (report.source && report.source.suspectLine) === 'number', JSON.stringify(report.source && report.source.suspectLine))
  check('渲染层印出"文件:真行号"（不是 undefined）', /源码定位：MyViewModel\.cs:3/.test(text), text.split('\n').find((l) => l.includes('源码定位')))
  check('★ 渲染输出里**不出现字面 undefined**', !/undefined/.test(text), text.match(/.{0,40}undefined.{0,40}/)?.[0] || '')
  check('渲染层印出方法体行号区间（startLine-endLine）', /方法体 1-7/.test(text), text.split('\n').find((l) => l.includes('方法体')))
  check('渲染层印出**代码片段**（生产层字段叫 code）', /while \(true\)/.test(text) && /3:\s+public void DoWork/.test(text), '片段缺失')
  check('渲染层印出**托管栈**（生产层字段叫 stackText）', /at System\.Windows\.Threading\.Dispatcher\.PushFrame\(\)/.test(text) && /at App\.MyViewModel\.DoWork\(\)/.test(text), '栈缺失')
  check('渲染层印出线程数（生产层字段叫 threadsSummary）', /线程数：2/.test(text), text.split('\n').find((l) => l.includes('线程数')))
  check('诊断串原样保留（含 mid/os）', /托管 ID 7，OS 线程 4321/.test(text), text.split('\n')[0])

  // 没配源码根时：必须明说"不是代码级证据"，且同样不许出现 undefined
  const noSrc = buildAnalysis(data, '')
  const noSrcText = renderAnalyze({ ok: true, status: 'done', ...noSrc })
  check('未配源码根：明说"不是代码级证据"', /不是代码级证据/.test(noSrcText), noSrcText.split('\n').slice(-3).join(' | '))
  check('未配源码根：仍不出现字面 undefined', !/undefined/.test(noSrcText), noSrcText.match(/.{0,30}undefined.{0,30}/)?.[0] || '')

  // 没识别出线程：同样是结论，不许含糊
  const empty = renderAnalyze({ ok: true, status: 'done', ...buildAnalysis({ threads: [] }, srcRoot) })
  check('无托管线程：明说"这本身就是结论"且无 undefined', /这本身就是结论/.test(empty) && !/undefined/.test(empty), empty.slice(0, 120))

  // ---------------------------------------------------------------- 1b. 未解析帧 ≠ 框架代码
  // 真机来源（2026-09-12）：真 WPF 受害者卡死，栈顶是 `at ?.?()` / `at ?.IL_STUB_CLRtoCOM()`
  // —— **模块与符号都拿不到**。而旧措辞写成"停留在 系统/框架代码（可能是同步等待）"，
  // 把"我们看不见"说成了"我们看见了框架代码"，等于暗示"你的业务代码没问题"。
  // 用户问的是"卡在哪一行"，这两句话的下一步完全不同。
  {
    const wpfData = {
      dump: 'wpf.dmp',
      threads: [{
        managedId: 17, osId: 27616, frames: [
          { type: '', method: '' },                                  // 栈顶：真机就是 ?.?()
          { type: '', method: 'IL_STUB_CLRtoCOM' },                   // 真机里的第二帧
          { type: 'System.Windows.Threading.Dispatcher', method: 'GetMessage', module: 'WindowsBase.dll' },
          { type: 'System.Windows.Threading.Dispatcher', method: 'PushFrame', module: 'WindowsBase.dll' },
        ],
      }],
    }
    const wr = buildAnalysis(wpfData, srcRoot)
    check('未解析帧被统计（count/top5 都对）', wr.unresolved && wr.unresolved.count === 2 && wr.unresolved.top5 === 2, JSON.stringify(wr.unresolved))
    check('★ 栈顶未解析时，诊断必须说"未能解析"，**不得**写成"停留在系统/框架代码"',
      /未能解析/.test(wr.diagnosis) && !/系统\/框架代码/.test(wr.diagnosis), wr.diagnosis)
    check('★ 诊断里带上"不要据此认为卡在框架里"的警告（防止反向推断）', /不要据此认为/.test(wr.diagnosis), wr.diagnosis)
    const wt = renderAnalyze({ ok: true, status: 'done', ...wr })
    check('★ 渲染层的"没有命中"要说清**是看不见，不是匹配不到**，并给出可执行下一步',
      /不是"匹配不到源码"，而是\*\*在最关键的位置看不见\*\*/.test(wt) && /DSH_PERF_SYMBOL_PATH/.test(wt) && /PDB/.test(wt),
      wt.split('\n').filter((l) => /源码定位|下一步/.test(l)).join(' | ').slice(0, 220))
    checkClean('未解析场景渲染无泄漏', wt)

    // 定位命中了、但**上方还有未解析帧**：必须提示，否则"定位到的那一行"会被当成堵塞点
    const mixedData = {
      dump: 'x.dmp',
      threads: [{
        managedId: 7, osId: 4321, frames: [
          { type: '', method: '' },                                     // 未解析（在业务帧**上方**）
          { type: 'App.MyViewModel', method: 'DoWork', module: 'App.dll' },
        ],
      }],
    }
    const mr = buildAnalysis(mixedData, srcRoot)
    check('★ 业务帧上方有未解析帧时如实计数（aboveUser）', mr.unresolved.aboveUser === 1 && !!mr.source, JSON.stringify(mr.unresolved))
    const mt = renderAnalyze({ ok: true, status: 'done', ...mr })
    check('★ 命中源码时也要提示"上方还有 N 个未解析帧"', /上方还有 1 个未解析帧/.test(mt),
      mt.split('\n').filter((l) => /未解析/.test(l)).join(' | ').slice(0, 200))
    checkClean('混合场景渲染无泄漏', mt)
  }

  // ---------------------------------------------------------------- 1c. 占位符帧 ≠ 业务帧（潜伏型）
  // 我构造"中段未解析"样例时抓到的：`{type:'?',method:'?'}` 这种占位帧**不是**用户代码，
  // 而 isUserFrame 只排除空串 → 它被当成业务帧 → 诊断写成
  // 「停留在 ?.?() —— **该方法疑似死循环或长时间阻塞**」：
  // 把一帧没解析出来的东西，断言成"你的某个方法有问题"。
  // 真机那份 WPF dump 里未解析帧的 type 恰好是**空串**，所以真机上没触发 —— 属潜伏缺陷。
  {
    const placeholder = {
      dump: 'x.dmp',
      threads: [{
        managedId: 9, osId: 111, frames: [
          { type: '?', method: '?' },
          { type: '***unknown***', method: '***unknown***' },
          { type: 'System.Windows.Threading.Dispatcher', method: 'PushFrame' },
        ],
      }],
    }
    const pr = buildAnalysis(placeholder, srcRoot)
    check('★ 占位帧被计入未解析（count=2）', pr.unresolved && pr.unresolved.count === 2, JSON.stringify(pr.unresolved))
    check('★ 占位帧**不得**被当成业务帧 → 诊断不许出现"该方法疑似死循环"',
      !/该方法疑似死循环/.test(pr.diagnosis), pr.diagnosis)
    check('★ 诊断改口为"未能解析"并警示不要反向推断', /未能解析/.test(pr.diagnosis) && /不要据此认为/.test(pr.diagnosis), pr.diagnosis)
    check('占位帧不产生源码定位（不许拿 ? 去映射源码）', pr.source === null, JSON.stringify(pr.source))
    checkClean('占位帧场景无泄漏', renderAnalyze({ ok: true, status: 'done', ...pr }))

    // 中段未解析：栈顶解析良好、未解析在深处、且**没有**业务帧 → 总况也必须印出来
    const midFrames = [
      { type: 'System.Windows.Threading.Dispatcher', method: 'GetMessage' },
      { type: 'System.Windows.Threading.Dispatcher', method: 'PushFrame' },
      ...Array.from({ length: 12 }, () => ({ type: '', method: '' })),
    ]
    const mr2 = buildAnalysis({ dump: 'x.dmp', threads: [{ managedId: 3, osId: 5, frames: midFrames }] }, srcRoot)
    check('中段未解析：top5 里有未解析（前 5 帧含空帧）→ aboveUser/top5 语义仍自洽',
      mr2.unresolved.count === 12 && mr2.unresolved.total === 14, JSON.stringify(mr2.unresolved))
    const midText = renderAnalyze({ ok: true, status: 'done', ...mr2 })
    check('★ 不论未解析在哪儿，"帧解析总况"都要印（否则中段的盲区会整段消失）',
      /帧解析：2\/14 帧解析出名字，12 帧无模块\/符号信息/.test(midText),
      midText.split('\n').find((l) => l.includes('帧解析')))
    checkClean('中段未解析渲染无泄漏', midText)
  }

  // ---------------------------------------------------------------- 1c. 分析器元数据（置信度/告警）不许被丢
  // 真机来源（2026-09-12）：`dumpstack.json` 本来就带 engine / clrVersion / 三个架构 / confidence /
  // warnings / elapsedMs / dacPath，而 `buildAnalysis` **只读了 threads** —— 于是"低置信度分析"
  // 和"干净的高置信度分析"在 agent 眼里长得一模一样。
  {
    const real = {
      dump: 'x.dmp', engine: 'ClrMD-Minidump', clrVersion: '4.8.9310.0',
      hostArchitecture: 'X86', dumpArchitecture: 'X86', clrArchitecture: 'X86',
      threadCount: 2, confidence: 'low', elapsedMs: 401, warnings: ['DAC 与 dump 内 CLR 版本不匹配，可能解析不全'],
      threads: [{ managedId: 7, osId: 4321, frames: [{ type: 'App.MyViewModel', method: 'DoWork', module: 'App.dll' }] }],
    }
    const r = buildAnalysis(real, srcRoot)
    check('★ 分析器元数据被带出（engine/clr/arch/confidence/warnings/elapsed）',
      r.engine === 'ClrMD-Minidump' && r.clrVersion === '4.8.9310.0' && r.confidence === 'low' &&
      r.arch && r.arch.dump === 'X86' && Array.isArray(r.analyzerWarnings) && r.analyzerWarnings.length === 1 && r.analyzerElapsedMs === 401,
      JSON.stringify({ e: r.engine, c: r.confidence, w: r.analyzerWarnings, a: r.arch }))
    const t = renderAnalyze({ ok: true, status: 'done', ...r })
    console.log('\n[renderAnalyze 含分析器元数据]\n' + t.split('\n').slice(0, 5).join('\n') + '\n')
    check('★ 渲染层印出分析器出处与置信度', /分析器：ClrMD-Minidump/.test(t) && /置信度 low/.test(t), t.split('\n')[0])
    check('★ 非 high 置信度**必须**明确警示（否则结论会被当确定证据用）', /置信度 \*\*low\*\*/.test(t) && /只能当线索/.test(t),
      t.split('\n').find((l) => l.includes('置信度 **')))
    check('★ 分析器自己的告警原文带出（DAC 不匹配这类事不能吞）', /分析器告警（1 条/.test(t) && /DAC 与 dump 内 CLR 版本不匹配/.test(t),
      t.split('\n').find((l) => l.includes('分析器告警')))
    checkClean('分析器元数据渲染无泄漏', t)
    // 高置信度 + 无告警时**不该刷噪音**（避免"狼来了"）
    const cleanT = renderAnalyze({ ok: true, status: 'done', ...buildAnalysis({ ...real, confidence: 'high', warnings: [] }, srcRoot) })
    check('置信度 high 且无告警时不出现警示', !/⚠/.test(cleanT.split('\n').slice(0, 2).join('\n')), cleanT.split('\n').slice(0, 2).join(' | '))
  }

  // ---------------------------------------------------------------- 1d. 缓存 / 源码根出处（真机：重算覆盖了好结果）
  // 真机教训（2026-09-12）：`analyze()` 原先**无条件重跑**，而重跑用当前 srcRoot →
  // 先前配好源码根时得到的 `源码定位：…:3` 被我后一次没配源码根的调用**静默覆盖**。
  // 现在：缓存优先 + 显式 refresh；且渲染必须说清"这份结论是复用的还是新算的、用的是哪套配置"。
  {
    const cached = renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', confidence: 'high', cached: true, analyzedAt: '2026-09-12T00:00:00.000Z', srcRoot: '', srcRootConfigured: false })
    check('★ 复用缓存时必须说明、并给出 refresh=true 的做法',
      /复用\*\*的已缓存分析/.test(cached) && /refresh=true/.test(cached) && /未配源码根/.test(cached),
      cached.split('\n').find((l) => l.includes('复用')))
    const fresh = renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', confidence: 'high', analyzedAt: '2026-09-12T00:00:00.000Z', srcRoot: 'X:\\src', srcRootConfigured: true })
    check('★ 新算时印出源码根出处（配了就写路径）', /新算\*\*/.test(fresh) && /X:\\src/.test(fresh), fresh.split('\n').find((l) => l.includes('新算')))
    checkClean('缓存/出处渲染无泄漏', cached + '\n' + fresh)

    // 缓存变"steadily wrong"的两条路（自查发现的缺口）：
    const changed = renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', confidence: 'high', dumpChanged: true, analyzedAt: '2026-09-12T01:00:00.000Z' })
    check('★ dump 被更换 → 渲染明确说"缓存作废、本次为新算"', /检测到 frozen\.dmp 已更换/.test(changed), changed.split('\n')[0])
    const upgrade = renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', confidence: 'high', cached: true, srcRoot: '', srcRootConfigured: false, srcRootUpgradeAvailable: true })
    check('★ 缓存是"未配源码根"算的、而现在配了 → 提示重算可得源码行号',
      /未配源码根\*\*时算的，而你\*\*现在配了\*\*/.test(upgrade) && /文件:行号/.test(upgrade),
      upgrade.split('\n').find((l) => l.includes('缓存是')))
    const unknownFp = renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', confidence: 'high', cached: true, fingerprintUnknown: true })
    check('★ 老分析没记指纹 → 如实说"无法判断"，不假装确定', /没有记 dump 指纹/.test(unknownFp), unknownFp.split('\n').find((l) => l.includes('指纹')))
    checkClean('三条缓存路径渲染无泄漏', changed + '\n' + upgrade + '\n' + unknownFp)
  }

  // ---------------------------------------------------------------- 2. listPacks → renderPacks
  const pack = join(packsRoot, '20260911-235959')
  mkdirSync(pack, { recursive: true })
  writeFileSync(join(pack, 'summary.txt'), '主窗口 12000ms 无响应（traceback 时间线随后）\n第二行\n', 'utf8')
  writeFileSync(join(pack, 'process-info.txt'), 'Name=client\nResponding=False\n', 'utf8')
  const hng = makeHangInspector({ packs: packsRoot })
  // 渲染层的真实输入是**工具包装后的对象**（两个面都是 `{total, evidenceDir, items}`）——
  // listPacks() 本身返回**裸数组**，直接喂给 renderPacks 会得到"还没有任何证据包"（我第一版就写错了）。
  // 所以这里按工具的真实形状构造，并额外用源码守卫钉住两个面都这么包（防漂移）。
  const items = hng.listPacks()
  const listed = { total: items.length, evidenceDir: hng.packsDir(), items }
  const packsText = renderPacks(listed, { now: Date.now() })
  console.log('\n[renderPacks 输出]\n' + packsText + '\n')
  check('生产层 item 带 summaryFirst', typeof (items[0] && items[0].summaryFirst) === 'string', String(JSON.stringify(items[0] && items[0].summaryFirst)).slice(0, 90))
  check('渲染层印出证据包**首行摘要**（"无响应"必须出现）', /无响应/.test(packsText), packsText.split('\n').filter((l) => l.includes('20260911')).join(' | '))
  check('渲染层印出文件明细', /process-info\.txt|summary\.txt/.test(packsText), packsText.split('\n').filter((l) => l.includes('20260911')).join(' | '))
  checkClean('renderPacks 输出无泄漏', packsText)

  // ---------------------------------------------------------------- 2b. packDetail → renderPack
  // （第十处形状漂移：生产层给 `files: [{name,bytes}]` **对象**数组，旧渲染 `files.join(', ')`
  //   打出一排 `[object Object]` —— 文件名和大小全丢，而"包里到底有什么"是判断真卡死的第一步。）
  const detail = hng.packDetail('20260911-235959')
  check('生产层 packDetail().files 是**对象**数组 {name,bytes}', Array.isArray(detail.files) && detail.files.length > 0 && typeof detail.files[0] === 'object', JSON.stringify(detail.files[0]))
  const packText = renderPack(detail)
  console.log('\n[renderPack 输出头 3 行]\n' + packText.split('\n').slice(0, 3).join('\n') + '\n')
  check('★ 渲染层印出**真实文件名与数量**（旧实现是 [object Object]）',
    /文件（\d+）：.*summary\.txt/.test(packText) && /process-info\.txt/.test(packText), packText.split('\n')[1])
  check('渲染层带上文件大小（B/KB/MB —— 判断 dump 是否真抓到了）', /\(\d+(\.\d+)?(B|KB|MB)\)/.test(packText), packText.split('\n')[1])
  check('证据原文照旧印出（texts.summary）', /无响应/.test(packText), packText.split('\n').slice(2, 5).join(' | ').slice(0, 160))
  checkClean('renderPack 输出无泄漏', packText)

  // ---------------------------------------------------------------- 3. runStatus → renderStatus
  const running = renderStatus({ status: 'running', pid: 321, evidenceDir: packsRoot })
  const exited = renderStatus({ status: 'exited', pid: null, exitCode: 0, evidenceDir: packsRoot })
  console.log('\n[renderStatus running]\n' + running + '\n')
  check('监测在跑：显示"运行中"（旧实现读 v.running 布尔 → 永远"未运行"）', /监测进程：运行中（pid 321）/.test(running), running.split('\n')[0])
  check('监测已退出：显示"未运行"', /监测进程：未运行/.test(exited), exited.split('\n')[0])
  check('状态字符串原样带出（status=…，可机器核对）', /status=running/.test(running) && /status=exited/.test(exited), running.split('\n')[0])
  checkClean('renderStatus 输出无泄漏', running + '\n' + exited)

  // ---------------------------------------------------------------- 3c. 只读预检块（Claude 第十二轮 + 实测）
  // 生产层早就算出了目标进程/取证工具/警告，渲染层却一个都不印 → agent 只能先启动监测、等用户复现、
  // 拿到一个没有 dump 的包，才知道本机抓不了 dump。源码根连生产层都没放进状态（现已补）。
  {
    const real = { ...hng.runStatus(), evidenceDir: packsRoot }      // ← 真实产出，不是手写形状
    const rt = renderStatus(real)
    console.log('\n[renderStatus 真实产出]\n' + rt + '\n')
    check('生产层状态里有 monitor 预检字段（procName/toolWarnings/srcRoot…）',
      !!real.monitor && 'procNameConfigured' in real.monitor && 'srcRootConfigured' in real.monitor,
      JSON.stringify(Object.keys((real && real.monitor) || {})))
    check('★ 只读状态就报出**目标进程是否配置**（没配就没有监视对象）', /目标进程：/.test(rt), rt.split('\n').find((l) => l.includes('目标进程')))
    check('★ 只读状态就报出**取证三件套**可用性', /取证工具：.*procdump.*DumpStack.*dac/.test(rt), rt.split('\n').find((l) => l.includes('取证工具')))
    check('★ 只读状态就报出**源码根是否配置**，并说清没配的后果（不是代码级证据）',
      /源码根：/.test(rt) && (/不是代码级证据/.test(rt) || /可映射到 文件:行号/.test(rt)),
      rt.split('\n').find((l) => l.includes('源码根')))
    checkClean('预检块无泄漏', rt)
    // 缺件时必须明说"抓不到/分析不了 dump"（而不是留个 ✗ 让人自己猜）
    const missing = renderStatus({ status: 'idle', evidenceDir: packsRoot, monitor: { procNameConfigured: true, procdump: 'x', procdumpExists: false, dumpStack: 'y', dumpStackExists: false, dacDir: 'z', dacDirExists: false, toolWarnings: ['procdump 不可用（x）：抓不了 dump'] } })
    check('★ 三件套缺失时明说后果 + 带出 toolWarnings 原文',
      /抓不到\/分析不了 dump/.test(missing) && /procdump 不可用/.test(missing), missing.split('\n').filter((l) => /取证工具|⚠️/.test(l)).join(' | '))
    checkClean('缺件预检无泄漏', missing)
  }

  // ---------------------------------------------------------------- 3b. startRun/stopRun → renderRun/renderStop
  // （第十一、十二处形状漂移：`startRun()` 把 pid 放在 `run.pid` 里、成功返回根本没有顶层 `pid`/`maxSeconds`，
  //   于是"启动了监测"却看不到 pid 与自动停止时间；`stopRun()` 只给 `{stopping:true}`，
  //   于是"监测本来就没在跑"这种情形被打成「已停止监测」—— 把"无事可做"说成了"我把它停了"。）
  // 这两个生产者**不能在这里执行**（会真的起监测脚本去挂客户端），所以形状取自：
  //   ① 渲染行为检查用**生产层现在真实返回的字面量**；② 键名用源码抠取（见 §6 兜底）钉住不许再漂。
  const runText = renderRun({ ok: true, started: true, pid: 4242, status: 'running', maxSeconds: 60, run: { pid: 4242, maxSeconds: 60 } })
  console.log('\n[renderRun 输出]\n' + runText + '\n')
  check('★ hang_run 输出带 pid（否则 agent 无法与 hang_status 核对进程）', /已启动卡死监测（pid 4242）/.test(runText), runText.split('\n')[0])
  check('★ hang_run 输出带自动停止秒数（生产者已把它落进 runState）', /将在 60s 后自动停止/.test(runText), runText.split('\n').slice(-1)[0])
  check('只给 run.pid（没有顶层 pid）时也要认——两个形状都读', /pid 777/.test(renderRun({ ok: true, started: true, run: { pid: 777 } })))
  checkClean('renderRun 输出无泄漏', runText)

  const stopNoop = renderStop({ ok: true, stopped: false, reason: 'not-running' })
  const stopDone = renderStop({ ok: true, stopping: true, stopped: true, pid: 4242 })
  console.log('\n[renderStop 未在跑]\n' + stopNoop + '\n[renderStop 已停止]\n' + stopDone + '\n')
  check('★ 本来就没在跑：如实说"没有需要停止的监测"，不谎称"已停止监测"',
    /没有需要停止的监测/.test(stopNoop) && !/^已停止监测/.test(stopNoop), stopNoop)
  check('真停止时印出结束的进程树 pid', /结束进程树 4242/.test(stopDone), stopDone)
  checkClean('renderStop 输出无泄漏', stopNoop + '\n' + stopDone)

  // ---------------------------------------------------------------- 4. 形状漂移的兜底：生产者新增字段不该让渲染崩
  check('生产者缺 source 时渲染不炸', typeof renderAnalyze({ ok: true, status: 'done', diagnosis: 'x', suspectThread: { managedId: 1 } }) === 'string')
  check('生产者缺 summaryFirst 时渲染不炸', typeof renderPacks({ items: [{ id: 'a', ts: Date.now() }] }) === 'string')

  // ---------------------------------------------------------------- 6. 字段契约扫描（系统性兜底，防第 13 次）
  // 前面每条断言都是"针对已知的漂移"。这一节反过来：把渲染层**读的所有字段名**扫出来，
  // 逐个要求生产层**真的产出**（跑出来的键并集），否则红。等于把"渲染层假设的形状"钉在生产层的真实形状上。
  {
    const renderSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'render.mjs'), 'utf8')
    const hangSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'hang.mjs'), 'utf8')
    // 注释要剔掉：本文件大量在注释里引用字段名做说明，不剔会把说明当成"读了该字段"
    const code = renderSrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const topFields = new Set([...code.matchAll(/\bv\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    const itemFields = new Set([...code.matchAll(/\bp\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))

    // 生产层的真实键并集：**全部来自刚跑出来的对象**，没有一个是手写的
    const producer = new Set([
      ...Object.keys(hng.runStatus()),
      ...Object.keys(detail),
      ...Object.keys(report),
      ...Object.keys(report.source || {}),
      ...Object.keys(report.suspectThread || {}),
      ...items.flatMap((it) => Object.keys(it)),
      'total', 'evidenceDir', 'items',
    ])
    // 显式允许的名字（每条都要有理由，否则就成了藏 bug 的垃圾桶）：
    //  ① 渲染层刻意支持的**旧字段名回退**（换名字时为了兼容旧装机数据）；
    //  ② 只在**失败分支**才出现的字段（脚本不在、分析失败…）—— 成功路径跑不出来；
    //  ③ 工具包装层补的字段。
    const ALLOW = new Set([
      'running', 'line', 'snippet', 'frames', 'threads', 'text', 'summaryFirstLine', 'hasDump', 'screenshotPath', // ①
      'packsDir', 'mtimeMs', // ①（旧的目录/时间字段名；现走 evidenceDir / ts —— 保留回退不影响诚实性）
      'ok', 'error', 'killed', 'stopped', 'stopping', 'reason', 'deleted', 'all', 'blocked', // ②
      'pid', 'status', 'startedAt', 'logPath', 'logTail', 'note', 'exitCode', 'maxSeconds', // ②（run/stop 分支）
    ])
    const missingTop = [...topFields].filter((f) => !producer.has(f) && !ALLOW.has(f))
    const missingItem = [...itemFields].filter((f) => !producer.has(f) && !ALLOW.has(f))
    // **扫描器自身必须有效**：万一正则写废了，上面两个 missing 会恒为空 → 假绿。所以先钉住扫到的量级。
    check('扫描器有效（确实扫到了足够的字段名，否则本节的通过没有意义）',
      topFields.size >= 15 && itemFields.size >= 5, 'top=' + topFields.size + ' item=' + itemFields.size + ' → ' + JSON.stringify([...topFields].sort()))

    // 跑不了的生产者（startRun 会真的起监测）→ 从源码里抠**返回字面量**的键名。
    // 抠不到就**失败**（不能静默放过）：extractKeys 返回 null 时下面几条会红。
    //
    // 实现要点（第一版抠错过，值得记下）：
    //  · 只抠 `return {…}` 那一段，不抠整个函数体 —— 否则 `spawn(..., { windowsHide: true })`
    //    这种**嵌套**对象里的键会被当成返回键（第一版就把 windowsHide 算了进来）；
    //  · 支持**简写属性**（`return { pid }` 里没有冒号）——第一版只认 `key:`，于是 stopRun 的
    //    `pid` 被漏掉，测试报了个"假红"。
    const sliceReturnLiterals = (body) => {
      const out = []
      const re = /return\s*\{/g
      let m
      while ((m = re.exec(body)) !== null) {
        const open = body.indexOf('{', m.index)
        let depth = 0
        for (let i = open; i < body.length; i++) {
          const ch = body[i]
          if ('{[('.includes(ch)) depth++
          else if ('}])'.includes(ch)) { depth--; if (depth === 0) { out.push(body.slice(open, i + 1)); break } }
        }
      }
      return out
    }
    const keysOfLiteral = (lit) => {
      const keys = new Set()
      let depth = 0
      let entry = ''
      const add = (e) => {
        const s = e.trim()
        if (!s || s.startsWith('...')) return
        const named = /^([A-Za-z_$][\w$]*)\s*:/.exec(s)
        if (named) { keys.add(named[1]); return }
        const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(s)
        if (shorthand) keys.add(shorthand[1])
      }
      for (let i = 0; i < lit.length; i++) {
        const ch = lit[i]
        if ('{[('.includes(ch)) { depth++; if (depth === 1) continue }
        if ('}])'.includes(ch)) { depth--; if (depth === 0) { add(entry); break } }
        if (depth === 1 && ch === ',') { add(entry); entry = ''; continue }
        if (depth === 1) entry += ch
      }
      return keys
    }
    const extractKeys = (fn) => {
      const i = hangSrc.indexOf('function ' + fn + '(')
      if (i < 0) return null
      const body = hangSrc.slice(i, hangSrc.indexOf('\n  }', i) + 1)
      const keys = new Set()
      for (const lit of sliceReturnLiterals(body)) for (const k of keysOfLiteral(lit)) keys.add(k)
      return keys.size ? keys : null
    }
    const startKeys = extractKeys('startRun')
    const stopKeys = extractKeys('stopRun')
    // `analyzePack()` 的产物字段：它靠 `writeState({...})` 落盘（不是 `return {`），而且需要**真 dump**
    // 才能执行 —— 所以这里用**源码断言**把它钉住（字段名必须在写盘处真实出现），再并入并集。
    // 不这么做的话，渲染层新加的 `cached/srcRoot/...` 会被判成"凭空读"（本轮就是这么被拓出来的）。
    for (const [name, re] of [
      ['status', /report\.status = 'done'/],
      ['analyzedAt', /report\.analyzedAt = /],
      ['srcRoot', /report\.srcRoot = srcRoot/],
      ['srcRootConfigured', /report\.srcRootConfigured = /],
      ['cached', /cached: true/],
      ['dumpChanged', /dumpChanged: true/],
      ['srcRootUpgradeAvailable', /srcRootUpgradeAvailable = true/],
      ['fingerprintUnknown', /fingerprintUnknown = true/],
      ['dumpFingerprint', /report\.dumpFingerprint = dumpFingerprint\(dump\)/],
      ['srcRootRegression', /srcRootRegression: true/],
    ]) {
      check('分析产物字段 ' + name + ' 在写盘处真实存在（源码断言）', re.test(hangSrc), String(re))
      producer.add(name)
    }
    // 这两个跑不了的生产者的键，也要进"生产层真实键"并集（否则 `v.run` 会被误判成凭空读）
    for (const k of [...(startKeys || []), ...(stopKeys || []), ...(extractKeys('deletePacks') || [])]) producer.add(k)
    check('扫描器有效（抠到了 startRun/stopRun 的返回键，且没抠进嵌套对象的键）', !!startKeys && startKeys.size >= 4 && !!stopKeys && stopKeys.size >= 3 && !startKeys.has('windowsHide'),
      'start=' + JSON.stringify(startKeys && [...startKeys]) + ' stop=' + JSON.stringify(stopKeys && [...stopKeys]))
    check('★ hang_run 渲染层读的 pid/maxSeconds，生产层确实返回（否则 agent 看不到 pid / 自动停止时间）',
      !!startKeys && startKeys.has('pid') && startKeys.has('maxSeconds'), JSON.stringify(startKeys && [...startKeys]))
    check('★ hang_stop 渲染层读的 stopped/reason/pid，生产层确实返回（否则"没在跑"被说成"已停止监测"）',
      !!stopKeys && stopKeys.has('stopped') && stopKeys.has('reason') && stopKeys.has('pid'), JSON.stringify(stopKeys && [...stopKeys]))

    // **本节的两个结论**（跑得动的生产者 + 源码抠出来的键，合成一个"生产层真实键"并集后再判）
    const missingTop2 = [...topFields].filter((f) => !producer.has(f) && !ALLOW.has(f))
    const missingItem2 = [...itemFields].filter((f) => !producer.has(f) && !ALLOW.has(f))
    check('★ 渲染层读的**顶层**字段，生产层全都产出（或显式允许）', missingTop2.length === 0,
      '凭空读的字段（渲染层假设有、生产层从不产出）：' + JSON.stringify(missingTop2))
    check('★ 渲染层读的**证据包条目**字段，生产层全都产出（或显式允许）', missingItem2.length === 0,
      '凭空读的字段：' + JSON.stringify(missingItem2))
  }

  // ---------------------------------------------------------------- 5. 跨面守卫：两个面都要按渲染层期望的形状包装
  {
    const dsh = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
    const mcp = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'server.mjs'), 'utf8')
    check('DSH 面：hang_packs 用 renderPacks 渲染', /render: \(_a, v\) => \[\{ type: 'text', text: renderPacks\(v/.test(dsh))
    check('DSH 面：包装成 {total,evidenceDir,items}（listPacks 返回裸数组，直接喂渲染会得到"还没有任何证据包"）',
      /return \{ total: items\.length, evidenceDir: hang\.packsDir\(\), items \}/.test(dsh), '包装形状变了')
    check('MCP 面：同样包装', /jtext\(\{ total: items\.length, evidenceDir: hng\(\)\.packsDir\(\), items \}\)/.test(mcp), '包装形状变了')
    check('渲染层读的是 summaryFirst（生产层字段），不是 summaryFirstLine',
      /p\.summaryFirst \?\? p\.summaryFirstLine/.test(readFileSync(join(import.meta.dirname, '..', 'lib', 'render.mjs'), 'utf8')))
  }
} finally {
  rmSync(srcRoot, { recursive: true, force: true })
  rmSync(packsRoot, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: dsh-hang-inspector 渲染层与生产层形状对齐（用真实产出喂渲染）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
