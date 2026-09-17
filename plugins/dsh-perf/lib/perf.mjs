/**
 * dsh-perf perf — 卡顿监测 + dump 抓取/分析封装（不依赖 DSH API，可独立单测）。
 */
import { envOr } from '../../../lib/env-fallback.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
// 帧 → 源码「文件:行号」的映射（F-009）。独立成模块以便离线单测。
import { makeSrcMap, simpleName as srcSimpleName } from './srcmap.mjs'
// F-007：宿主不热加载插件代码 —— 让工具自己说出"我跑的可能不是磁盘上那份"。
import { staleCodeInfo, moduleRoots } from '../../../lib/code-freshness.mjs'
import { resolveDumpTools } from '../../../lib/dump-tools.mjs'
import { dirname as dirNameOf } from 'node:path'
import { fileURLToPath as fileUrlToPath } from 'node:url'

const PLUGIN_DIR = dirNameOf(dirNameOf(fileUrlToPath(import.meta.url)))

// 解释器路径是**用户可配**的（机器上 pwsh 位置特殊时）：必须经 env-fallback ——
// 否则用户在用户级环境变量里指了 pwsh，长活宿主读不到 → 静默回落到 Windows PowerShell，
// 而"为什么我的配置没生效"没有任何线索（Codex r15 复核补入清单后拓出）。
const PS = envOr('DSH_PERF_POWERSHELL') || envOr('DSH_UI_POWERSHELL') || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TOOLCHAIN_ROOT = join(homedir(), '.dsh-agent-toolchain')
// 三件套（procdump/DumpStack/DAC）统一解析：只要给出 procdump 的位置，就在它旁边按磁盘实际布局
// 推导出另外两个 —— 否则会出现"抓得到 dump 却分析不了"这种半通不通的状态（本机实测就是：
// MCP 面配了 DSH_PERF_* 能用，DSH 面没配就整个不可用，而报错只说"procdump 缺失"）。
const TOOLS = resolveDumpTools({
  procdumpEnv: ['DSH_PERF_PROCDUMP'],
  dumpstackEnv: ['DSH_PERF_DUMPSTACK'],
  dacEnv: ['DSH_PERF_DAC_DIR'],
  toolsRoot: join(TOOLCHAIN_ROOT, 'tools'),
})
const PROCDUMP = TOOLS.procdump
const DUMPSTACK = TOOLS.dumpstack
const DAC_DIR = TOOLS.dacDir
// HeapRoots（#2 GC root/保留链，ClrMD）：显式 env 优先；否则**从 DumpStack 同目录派生**
// —— 交付时把 HeapRoots.exe 放在 DumpStack.exe 旁边，这样零新增配置、重启即生效（不必改 ~/.claude.json）。
const HEAPROOTS = envOr('DSH_PERF_HEAPROOTS') || (DUMPSTACK ? join(dirNameOf(DUMPSTACK), 'HeapRoots.exe') : '')
// PerfView（真·采集，/threadTime）+ UiFreezeStacks（TraceEvent 提取器，复刻 dotTrace UI Freeze）：
// 显式 env 优先，否则**从 procdump 同目录派生**（交付时把 PerfView.exe / UiFreezeStacks.exe 放 procdump 旁边，零新增配置）。
const PERFVIEW = envOr('DSH_PERF_PERFVIEW') || (PROCDUMP ? join(dirNameOf(PROCDUMP), 'PerfView.exe') : '')
// UiFreezeStacks 是 framework-dependent 发布（apphost 自寻全局 .NET 运行时；`amd64/msdia140.dll` 读 pdb 必需，
// 单文件自包含发布会丢它 → 必须整个发布**文件夹**部署到 `<tools>/uifreeze-bin/`）。
const UIFREEZE_EXE = envOr('DSH_PERF_UIFREEZE') || (PROCDUMP ? join(dirNameOf(PROCDUMP), 'uifreeze-bin', 'UiFreezeStacks.exe') : '')

export function makePerf(cfg) {
  const c = {
    procName: envOr('DSH_UI_PROC_NAME'),
    windowName: envOr('DSH_UI_WINDOW_NAME'),
    scriptsDir: '',
    evidenceDir: join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
    srcRoot: envOr('DSH_PERF_SRC_ROOT'),
    procdump: PROCDUMP,
    dumpstack: DUMPSTACK,
    dacDir: DAC_DIR,
    heapRoots: HEAPROOTS,
    perfView: PERFVIEW,
    uiFreezeStacks: UIFREEZE_EXE,
    ...cfg,
  }
  // 空字符串不是「配置」：调用方习惯写 evidenceDir: process.env.X || ''，
  // 展开后默认目录被清空，证据就落到 cwd 下的相对路径。
  if (!c.evidenceDir) c.evidenceDir = join(homedir(), '.dsh-agent-toolchain', 'perf-evidence')
  if (!c.procdump) c.procdump = PROCDUMP
  if (!c.dumpstack) c.dumpstack = DUMPSTACK
  if (!c.dacDir) c.dacDir = DAC_DIR
  if (!c.heapRoots) c.heapRoots = HEAPROOTS
  if (!c.srcRoot) c.srcRoot = envOr('DSH_PERF_SRC_ROOT')
  // 源根的取值顺序：本插件专用 → 客户端通用（DSH_API_SRC_ROOT 由宿主启动脚本注入）
  // → 构建插件用的客户端根。三者都没有时 srcmap 会如实报 usable=false，
  // 而不是给出一个看起来像证据、其实是空的行号。
  if (!c.srcRoot) c.srcRoot = envOr('DSH_API_SRC_ROOT') || envOr('DSH_BUILD_CLIENT_ROOT')

  // 帧 → 源码「文件:行号」。惰性建表 + 内部缓存，多次 analyzeDump 复用同一个 map。
  const srcMap = makeSrcMap({ srcRoot: c.srcRoot })

  function runPs1(script, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args.map(String)], { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e, timedOut: false })
        return
      }
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: out, stderr: err + '\n' + e, timedOut: false })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: out, stderr: err, timedOut: false })
      })
    })
  }

  function tsDir() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  }

  /** 直接跑原生 exe（DumpStack/procdump），stdout 按 UTF-8/GBK 双解码。 */
  function runExe(exe, args, timeoutMs) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(exe, args.map(String), { windowsHide: true })
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + e, timedOut: false })
        return
      }
      const chunks = []
      let err = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: '', stderr: err + '\n[TIMEOUT]', timedOut: true })
      }, timeoutMs)
      child.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: -1, stdout: '', stderr: err + '\n' + e, timedOut: false })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const buf = Buffer.concat(chunks)
        let text
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
        } catch {
          try { text = new TextDecoder('gbk').decode(buf) } catch { text = buf.toString('utf8') }
        }
        resolve({ code, stdout: text, stderr: err, timedOut: false })
      })
    })
  }

  // ------------------------------------------------------------ 卡顿监测

  /**
   * 测量口径（**数据层**，不只印在文本里）。
   *
   * 为什么必须放进返回值：MCP 面是 `jtext()` 直出原始对象的（render.mjs 的文本在那里根本不存在），
   * 所以"诚实性字段只写在渲染层"= 只修了外壳面（F-021 的形态，本轮已经踩过 6 次）。
   *
   * 数字来自本机标定（bench-runs/dbg-20260911/perf-probe-calibrate.ps1，见
   * perf-probe-calibration.json）：用 C# WinForms 受害者（事件处理器保证在 UI 线程上）
   * 造出**确定时长**的阻塞，再跑真正的 perf-probe.ps1 数命中。
   */
  const MEASUREMENT_SCOPE = {
    what: '只测 UI 线程消息泵响应（SendMessageTimeout 打到客户端主窗口；UI 忙则该调用同步挂起）',
    sees: 'UI 线程被同步阻塞的时长（且是**采样那一刻剩余**的阻塞时长 —— 采样间隔越大，读到的越短）',
    blind: [
      '非 UI 线程的卡顿（GC / IO / worker / 后台线程）**完全测不到**：本机标定里后台线程每 3s 阻塞 2000ms、' +
        '探针 110~191 个样本命中 **0** 次、max 仅 8~9ms（与空闲无异）',
      '阻塞若完全落在两次采样之间会被整段错过：同一个 120ms 阻塞在 100ms 采样下只命中 1/5 次',
      '不区分"谁堵的"：它只测消息泵，定位责任代码要用 perf_trace/perf_hotstacks 或 dump',
    ],
    reliableFloorMs: 500,
    calibratedAt: '2026-09-11 本机标定（bench-runs/dbg-20260911/perf-probe-calibrate.ps1）',
    calibration: 'UI 线程阻塞 2000ms → 4/4 命中（max 2008ms）；500ms → 4/5（100ms 采样，max 492ms）但阈值恰好取 500ms 时只中 1/10；' +
      '300ms → 4/4（max 264ms）；120ms → 1/5；后台线程阻塞 2000ms → 0 命中。**P50 恒为 0ms**（周期性卡顿下多数采样落在空闲期），' +
      '判断卡顿要看 max 与命中数，不是 P50。',
    tuning: '要找 ≥500ms 的卡顿：阈值用 200~300ms（别正好取 500 —— 实测 500ms 阻塞测得 492ms，会被阈值挡掉）、intervalMs 用 100~150ms。' +
      '要抓 300ms 级卡顿：intervalMs 必须 ≤100ms，且结论只对"UI 线程"成立。',
  }

  async function probe({ seconds = 60, thresholdMs = 500, capture = 'log', intervalMs = 300 } = {}) {
    if (!existsSync(join(c.scriptsDir, 'perf-probe.ps1'))) return { ok: false, error: 'perf-probe.ps1 缺失：' + c.scriptsDir }
    const sec = Math.min(Math.max(Math.round(seconds || 60), 5), 3600)
    const th = Math.min(Math.max(Math.round(thresholdMs || 500), 50), 10000)
    const cap = ['log', 'shot', 'dump'].includes(capture) ? capture : 'log'
    // 必须把目标进程/窗口传下去：不传时脚本收到空 ProcName，Get-Process -Name ''
    // 直接抛参数验证错误，probe 永远拿不到报告（历史 bug）。
    const psArgs = ['-Seconds', String(sec), '-ThresholdMs', String(th), '-Capture', cap, '-IntervalMs', String(intervalMs || 300), '-OutDir', c.evidenceDir, '-ProcName', c.procName, '-WindowName', c.windowName]
    const r = await runPs1(join(c.scriptsDir, 'perf-probe.ps1'), psArgs, (sec + 90) * 1000)
    if (r.timedOut) return { ok: false, error: 'probe 超时', stdout: r.stdout.slice(-1000) }
    const dirM = r.stdout.match(/EVIDENCE_DIR=([^\r\n]+)/)
    const dir = dirM ? dirM[1].trim() : null
    const reportPath = dir ? join(dir, 'report.json') : null
    if (reportPath && existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''))
        persistLast(reportPath)
        return { ok: true, ...report, measurementScope: MEASUREMENT_SCOPE }
      } catch (e) {
        return { ok: false, error: 'report.json 解析失败: ' + e, stdout: r.stdout.slice(-800) }
      }
    }
    if (/CLIENT_NOT_RUNNING/.test(r.stdout)) return { ok: false, clientNotRunning: true, error: '客户端未运行（先 ui_launch 启动）' }
    if (/WINDOW_NOT_FOUND/.test(r.stdout)) return { ok: false, error: '未找到主窗口' }
    return { ok: false, error: 'probe 未产出报告', stdout: r.stdout.slice(-800), stderr: r.stderr.slice(-500) }
  }

  function lastProbePath() { return join(c.evidenceDir, 'last-probe.json') }

  function persistLast(reportPath) {
    try { writeFileSync(lastProbePath(), JSON.stringify({ at: new Date().toISOString(), reportPath }, null, 2), 'utf8') } catch { /* ignore */ }
  }

  /**
   * 读最近一次监测报告。
   *
   * F-001（2026-09-11 真机确证）：report.json 是 perf-probe.ps1 的**输出形状**
   * （p50Ms/pid/samples/stutters/…），**没有 ok 字段**。旧实现只补了 hasRun：
   *     return { hasRun: true, ...r }
   * 而渲染层是 `if (!v.ok) return '监测失败：…'` → 于是**只要有历史记录就必然**
   * 被渲染成「监测失败：未知错误」，把一份正常报告谎报成失败，逼 agent 去查不存在的故障。
   *
   * 修法：归一化成与 probe() 相同的形状（补 ok），并附上**新鲜度**——perf_report 读的是
   * 「最近一次」，可能是几小时甚至几天前的一次，调用方有权知道它有多旧（同类问题见 F-005：
   * 陈旧数据不标注年龄会被当成当前状态）。
   *
   * `ok: true` 放在展开之前：report 文件只可能由**成功路径**写入（persistLast 只在
   * report.json 解析成功后调用），但若将来脚本自己回报 ok:false，仍以它为准、不被覆盖。
   */
  function report() {
    // F-030（2026-09-12，r30）：**"读不到报告"被一律当成"没跑过"**。
    //
    // ⚠ 更正一句我自己的初判（本轮真机核对后改的）：我一开始以为"本机此刻正是指针在、报告不在"，
    //   依据是 `dir` 的**非递归**列表只看到 `last-probe.json` —— 而报告其实在**子目录**里，一直都在。
    //   **那个"真机复现"是我的误判**，已撤回；本机 `perf_report` 返回"监测失败：未知错误"的真因是
    //   **宿主在跑旧代码**（磁盘上的代码返回的是完整数据，见 §〇 三版本），与这里的缺陷无关。
    //   本条的真正依据是**读代码**：旧实现把所有异常都吞成 `{hasRun:false}`，而它有四种截然不同的成因；
    //   其中"跑过但报告文件被清理/移动"这一种会被渲染成"还没有监测记录"，让用户以为**自己从没跑过**。
    //   四种状态已在临时证据目录上逐条验证（`test/report-states.test.mjs`，12 条断言）。
    // 现在把四种状态分开说清：
    //   ok / never-ran / pointer-unreadable / report-missing / report-corrupt
    const pointerPath = lastProbePath()
    let meta = null
    if (!existsSync(pointerPath)) {
      return { hasRun: false, ok: false, reason: 'never-ran', pointerPath }
    }
    try {
      meta = JSON.parse(readFileSync(pointerPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (e) {
      return {
        hasRun: false, ok: false, reason: 'pointer-unreadable', pointerPath,
        error: '监测**指针文件**存在但读不出来（文件损坏或不是 JSON）：' + pointerPath
          + '（' + String(e && e.message ? e.message : e) + '）—— 这不等于"没跑过"。',
      }
    }
    const atMs = Date.parse(meta?.at || '')
    const ageMs = Number.isFinite(atMs) ? Date.now() - atMs : null
    const freshness = {
      ranAt: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
      ageMs,
      staleHours: ageMs === null ? null : Math.round((ageMs / 3600000) * 10) / 10,
    }
    const rp = meta?.reportPath
    if (typeof rp !== 'string' || rp === '' || !existsSync(rp)) {
      return {
        hasRun: true, ok: false, reason: 'report-missing', pointerPath, reportPath: rp ?? null, ...freshness,
        error: '**跑过**监测（指针文件里记着这次运行' + (freshness.ranAt ? '，时间是 ' + freshness.ranAt : '')
          + '），但**报告文件已经不在了**：' + (rp ?? '(指针里没记路径)')
          + '。常见原因：证据目录被清理/移动过。'
          + '⚠ 这**不是**"没有跑过监测"，更**不是**"没有卡顿"。要结论请重跑 perf_probe。',
      }
    }
    try {
      const r = JSON.parse(readFileSync(rp, 'utf8').replace(/^\uFEFF/, ''))
      return {
        ok: true,
        ...r,
        hasRun: true,
        ...freshness,
        reportPath: rp,
        pointerPath,
        // Q3：历史报告同样是"只测了 UI 线程"的那一份 —— 口径随报告一起走，别只在刚跑完时说明。
        measurementScope: MEASUREMENT_SCOPE,
        // F-007：这份报告会不会是用**旧代码**读出来的？一并说清（不陈旧时不加字段）。
        ...(staleCodeInfo(moduleRoots(PLUGIN_DIR)) || {}),
      }
    } catch (e) {
      return {
        hasRun: true, ok: false, reason: 'report-corrupt', pointerPath, reportPath: rp, ...freshness,
        error: '报告文件存在但解析不了（损坏）：' + rp + '（' + String(e && e.message ? e.message : e) + '）'
          + ' —— 这不等于"没有卡顿"。要结论请重跑 perf_probe。',
      }
    }
  }

  // ------------------------------------------------------------ dump 抓取

  function clientPid() {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + c.procName + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const m = out.match(/"[^"]*\.exe","(\d+)"/)
      if (m) return Number(m[1])
    } catch { /* ignore */ }
    return null
  }

  async function dump({ note = '' } = {}) {
    const pid = clientPid()
    if (!pid) return { ok: false, error: '客户端未运行，无法抓 dump（进程名由 DSH_UI_PROC_NAME 指定）' }
    if (!existsSync(c.procdump)) return { ok: false, error: 'procdump 不可用：' + (TOOLS.warnings.find((w) => w.startsWith('procdump')) || ('procdump 缺失：' + c.procdump)), toolDiagnostics: { procdump: TOOLS.procdumpExists, dumpstack: TOOLS.dumpstackExists, dacDir: TOOLS.dacDirExists, origins: TOOLS.origins, searched: TOOLS.searched } }
    const dir = join(c.evidenceDir, tsDir() + '-dump')
    mkdirSync(dir, { recursive: true })
    const dumpPath = join(dir, 'client.dmp')
    const label = String(note || '').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30)
    if (label) {
      try { writeFileSync(join(dir, 'note.txt'), note + '\n', 'utf8') } catch { /* ignore */ }
    }
    const startedAt = Date.now()
    const r = await new Promise((resolve) => {
      let child
      try {
        child = spawn(c.procdump, ['-ma', '-accepteula', String(pid), dumpPath], { windowsHide: true })
      } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e) }); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ code: null, stdout: out, stderr: err + '\n[TIMEOUT 180s]' })
      }, 180000)
      child.stdout.on('data', (d) => { out += d.toString('utf8') })
      child.stderr.on('data', (d) => { err += d.toString('utf8') })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }) })
    })
    const durationMs = Date.now() - startedAt
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 未生成', procdumpOut: (r.stdout + '\n' + r.stderr).slice(-800) }
    const size = statSync(dumpPath).size
    const analysis = await analyzeDump(dumpPath)
    return { ok: true, dumpPath, sizeBytes: size, durationMs, dir, analysis }
  }

  // ------------------------------------------------------------ dump 分析

  function findDac(dumpPath) {
    try {
      const info = execFileSync(c.dumpstack, ['dacinfo', dumpPath], { encoding: 'utf8', windowsHide: true }).trim()
      const key = info.split(/\r?\n/)[0]
      if (!key) return null
      const dac = join(c.dacDir, key.replace('|', '_') + '.dll')
      return existsSync(dac) ? dac : null
    } catch {
      return null
    }
  }

  async function analyzeDump(dumpPath) {
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 不存在：' + dumpPath }
    if (!existsSync(c.dumpstack)) return { ok: false, error: 'DumpStack 不可用：' + (TOOLS.warnings.find((w) => w.startsWith('DumpStack')) || ('DumpStack 缺失：' + c.dumpstack)), toolDiagnostics: { procdump: TOOLS.procdumpExists, dumpstack: TOOLS.dumpstackExists, dacDir: TOOLS.dacDirExists, origins: TOOLS.origins, searched: TOOLS.searched } }
    const outPath = dumpPath.replace(/\.dmp$/i, '.analysis.json')
    const args = [dumpPath, outPath]
    const dac = findDac(dumpPath)
    if (dac) args.push(dac)
    const r = await runExe(c.dumpstack, args, 180000)
    if (r.timedOut) return { ok: false, error: 'DumpStack 超时' }
    let data
    try {
      data = JSON.parse(readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      // 输出直接打 stdout 的情况
      try { data = JSON.parse(r.stdout) } catch {
        return { ok: false, error: 'DumpStack 输出解析失败', tail: (r.stdout + r.stderr).slice(-600) }
      }
    }
    const summary = summarize(data)
    // F-035：`client.analysis.json` 是 **DumpStack 的原始输出**（线程/帧，只有 module+method），
    //   **源码映射（`.cs:行号`）根本不在里面** —— 它由 summarize()→srcMap.mapFrames() 现算，
    //   此前只存在于内存与渲染文本里，**从未落盘**。
    //   后果：文档写"证据：…client.analysis.json"来支持「映射到 LaunchPopupWindow.xaml.cs:58」，
    //   而该文件里 `xaml.cs` 出现 **0 次**（复核：20260912-032142-dump/client.analysis.json）。
    //     ⇒ 被引用的证据文件不含它被引用来支持的内容。现在把归纳结果也落盘，两份并列、各司其职：
    //       client.analysis.json        = 原始（谁都能拿别的工具复核）
    //       client.analysis.summary.json= 含 srcMap 的归纳（文档/agent 引用的那份）
    const w = writeSummary(outPath, summary)
    return { ok: true, outPath, summaryPath: w.summaryPath, summaryWriteError: w.error, ...summary }
  }

  /**
   * 把 DumpStack 的原始 JSON 归纳成工具输出。
   * 实现在模块级 summarizeDump()（可离线单测；帧渲染的坑都钉在 tests/srcmap 与 report-shape 里）。
   */
  const summarize = (data) => summarizeDump(data, srcMap)

  async function heapStats(dumpPath, topN = 30) {
    if (!existsSync(dumpPath)) return { ok: false, error: 'dump 不存在：' + dumpPath }
    if (!existsSync(c.dumpstack)) return { ok: false, error: 'DumpStack 不可用：' + (TOOLS.warnings.find((w) => w.startsWith('DumpStack')) || ('DumpStack 缺失：' + c.dumpstack)), toolDiagnostics: { procdump: TOOLS.procdumpExists, dumpstack: TOOLS.dumpstackExists, dacDir: TOOLS.dacDirExists, origins: TOOLS.origins, searched: TOOLS.searched } }
    const args = ['heapstats', dumpPath, String(Math.min(Math.max(topN || 30, 5), 100))]
    const dac = findDac(dumpPath)
    if (dac) args.push(dac)
    const r = await runExe(c.dumpstack, args, 300000)
    if (r.timedOut) return { ok: false, error: 'heapstats 超时' }
    try {
      const data = JSON.parse(r.stdout)
      // **单次快照不能判定泄漏**（2026-09-12「用户可见结论的最坏情况」主题自查）：
      //   工具描述写的是"两次 dump 对比同一类型的对象数增长即泄漏嫌疑"，但**输出里没有任何一句**
      //   提醒"这是一次快照"。agent 拿到一份干净的 Top N，很容易直接下结论"没有泄漏" ——
      //   而内存泄漏的定义恰恰要求**跨时间比较**。这里把口径钉在数据里（两个面都会带出去）。
      const list = Array.isArray(data.top) ? data.top : []
      const totalObjs = Number(data.totalObjects)
      const totalBytes = Number(data.totalSizeBytes)
      const mb = Number.isFinite(totalBytes) ? (Math.round(totalBytes / 1024 / 1024 * 10) / 10) + 'MB' : '?'
      return {
        ok: true,
        ...data,
        snapshot: true,
        listedTypes: list.length,
        truncated: list.length > 0 && Number(topN) > 0 && list.length >= Math.min(Math.max(topN || 30, 5), 100),
        scopeNote: '这是**单次快照**：本次只列了 ' + list.length + ' 个类型' +
          (Number.isFinite(totalObjs) ? '（堆内共 ' + totalObjs + ' 个对象 / ' + mb + '）' : '') +
          (list.length >= Math.min(Math.max(topN || 30, 5), 100) ? '，**列表已按 topN 截断 —— 没列出的类型不代表不存在**' : '') + '。'
          + '**单次快照无法判定"有没有内存泄漏"** —— 泄漏的定义是"同一类型对象数**随时间**增长"，'
          + '必须隔一段时间再抓一份做对比（同一进程、同样的操作路径）。'
          + '本响应里 count/sizeBytes 大的类型只是"当前占用多"，**不等于泄漏**。',
        compareHint: '做法：① 现在抓一份（perf_dump 或已有 dump）；② 让用户复现可疑操作并等待一段时间；③ 再抓一份；④ 对比同一 type 的 count 增长（工具会分别给出两份 Top N，对比由你来做）。',
      }
    } catch {
      return { ok: false, error: 'heapstats 输出解析失败', tail: (r.stdout + r.stderr).slice(-600) }
    }
  }

  // ------------------------------------------------------------ 源码映射

  /**
   * 单点查询：类型（或类型.方法）→ 源码位置。
   *
   * F-009 修正：旧实现是**死代码**（全仓库零调用），而且写的是
   * `git grep -n -l` —— `-l` 只列文件名，**把 `-n` 产出的行号丢掉了**，
   * 即使被调用也拿不到行号。现在统一走 lib/srcmap.mjs，返回结构化位置：
   *   { file, line, where: 'method'|'type', text }
   * 查不到返回 null（不猜）。
   */
  function locateType(typeName, methodName) {
    const simple = srcSimpleName(typeName)
    if (!simple) return null
    // mapFrames 已含缓存与批量解析；给 method 时优先方法声明行，否则回落类型声明行。
    const mapped = srcMap.mapFrames([{ type: simple, method: methodName || null }])
    return (mapped[0] && mapped[0].src) || null
  }

  /**
   * `perf_gcroot` —— 堆 GC root / 保留链（#2，补 PerfView 那条 perf_heap 答不了的「谁 keep 住了对象」）。
   * 走自建的 HeapRoots.exe（ClrMD）：无 type 时给托管堆 Top 类型；给 type 时额外报该类型对象的
   * root → 对象 保留链（root 种类 + 沿途类型名）。DAC 复用 findDac（与 dump 分析同一套）。
   * 口径诚实（渲染层再强化一次）：只看**托管堆**；单次快照 count/bytes 大 ≠ 泄漏（要跨时间对比）。
   */
  async function gcRoots(dumpPath, opts = {}) {
    if (!dumpPath || !existsSync(dumpPath)) return { ok: false, error: 'dump 不存在：' + String(dumpPath) }
    if (!existsSync(c.heapRoots)) {
      return { ok: false, error: 'HeapRoots 不可用：' + c.heapRoots +
        '（ClrMD 分析器；交付时应与 DumpStack.exe 同目录，或用 DSH_PERF_HEAPROOTS 指定）',
        toolDiagnostics: { heapRoots: c.heapRoots, dumpstack: c.dumpstack } }
    }
    const args = [dumpPath, '--top', String(Math.min(Math.max(Number(opts.top) || 30, 5), 100))]
    if (opts.type) { args.push('--type', String(opts.type)); args.push('--paths', String(Math.min(Math.max(Number(opts.paths) || 5, 1), 50))) }
    const dac = findDac(dumpPath)
    if (dac) { args.push('--dac', dac) }
    const r = await runExe(c.heapRoots, args, 300000)
    if (r.timedOut) return { ok: false, error: 'HeapRoots 超时（堆很大时可调小 --top / 只查一个 --type）' }
    let data
    try { data = JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch {
      return { ok: false, error: 'HeapRoots 输出解析失败', tail: (r.stdout + r.stderr).slice(-600) }
    }
    if (!data || data.ok !== true) return { ok: false, error: (data && data.error) || 'HeapRoots 失败', tail: (r.stdout + r.stderr).slice(-400) }
    // 口径钉进数据（与 heapStats 同源）：单次快照不判泄漏；仅托管堆。
    return {
      ...data,
      snapshot: true,
      scopeNote: '**单次快照 + 仅托管堆**：count/bytes 大只表示"当前占用多"，**不等于泄漏**（泄漏要同一类型跨时间增长，隔段时间再抓一份对比）；' +
        '非托管内存（bitmap/字体句柄/COM/native buffer）与工作集（任务管理器那个数）本工具看不到，别用它下"没有泄漏"的结论。',
      queriedType: opts.type || null,
    }
  }

  // ── perf_uifreeze 后端：真 PerfView 采集(/threadTime) + UiFreezeStacks 提取（dotTrace「消息泵间隙>200ms」判据）。
  //    两段式：start 起采集 → 你手动复现卡顿 → stop 停+合并+分析，出「UI 线程冻结 N 次、每次多久、卡在哪条托管调用链」。
  //    UI 线程**自动认**（UiFreezeStacks 取泵消息最多的那条），不再需要 detectUiThread 回调/抓 dump。
  //    符号默认 /symcached（只用本地缓存、不连 msdl，避免本机 msdl 极慢卡死）；托管方法名靠 etl 里的 rundown 不依赖 msdl。
  async function uiFreeze(opts = {}) {
    const action = String(opts.action || '').toLowerCase()
    if (!existsSync(c.perfView)) {
      return { ok: false, error: 'PerfView.exe 不可用：' + c.perfView + '（放到 procdump 同目录，或 DSH_PERF_PERFVIEW 指定）',
        toolDiagnostics: { perfView: c.perfView, uiFreezeStacks: c.uiFreezeStacks } }
    }
    const dir = join(c.evidenceDir, 'uifreeze')
    const etl = join(dir, 'uifreeze.etl')
    const zip = etl + '.zip'
    const sessionFile = join(c.evidenceDir, 'uifreeze-pv-session.json')

    if (action === 'start') {
      try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
      await runExe(c.perfView, ['abort', '/nogui', '/accepteula'], 60000) // 清残留会话（无则忽略）
      const r = await runExe(c.perfView, ['start', '/threadTime', '/nogui', '/accepteula', '/BufferSizeMB:256', '/CircularMB:1024', '/DataFile:' + etl], 120000)
      if (r.code !== 0) return { ok: false, error: 'PerfView start 失败（需管理员权限起 ETW 内核会话）', tail: (r.stdout + r.stderr).slice(-500) }
      try { writeFileSync(sessionFile, JSON.stringify({ dir, etl, zip, startedAt: Date.now(), process: String(opts.process || c.procName || '') }), 'utf8') } catch { /* ignore */ }
      return { ok: true, started: true, dir, etl,
        hint: '已起 PerfView /threadTime 采集。现在去**复现卡顿**（冷启点进那个页面/按钮）；页面一出来就调 perf_uifreeze(action="stop")。窗口越短、解析越快越干净。' }
    }
    if (action !== 'stop') return { ok: false, error: 'action 必须是 start 或 stop' }

    // stop：停 + 合并 + 分析
    let session = null
    try { session = JSON.parse(readFileSync(sessionFile, 'utf8')) } catch { session = null }
    const useDir = (session && session.dir) || dir
    const useEtl = (session && session.etl) || etl
    const useZip = (session && session.zip) || zip
    const proc = String(opts.process || (session && session.process) || c.procName || '').trim()

    const sr = await runExe(c.perfView, ['stop', '/nogui', '/accepteula', '/DataFile:' + useEtl], 300000)
    try { rmSync(sessionFile, { force: true }) } catch { /* ignore */ }
    if (!existsSync(useZip)) return { ok: false, error: 'PerfView stop 没产出 ' + basename(useZip) + '（是否没先 action="start"，或采集被别的会话打断？）', tail: (sr.stdout + sr.stderr).slice(-500) }
    if (!existsSync(c.uiFreezeStacks)) return { ok: false, error: 'UiFreezeStacks.exe 不可用：' + c.uiFreezeStacks + '（放到 procdump 同目录，或 DSH_PERF_UIFREEZE 指定）', etlZip: useZip }

    // pid：UiFreezeStacks 用 /pid 精确过滤（也顺带让 census 只含目标进程）；查不到就用 /process 名字。
    let pid = opts.pid || null
    if (!pid && proc) {
      try { const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + proc + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }); const m = /"[^"]*","(\d+)"/.exec(out); if (m) pid = m[1] } catch { /* ignore */ }
    }

    const jsonOut = join(useDir, 'uifreeze.json')
    const args = [useZip]
    if (pid) args.push('/pid:' + String(pid)); else if (proc) args.push('/process:' + proc)
    if (opts.tid) args.push('/tid:' + String(opts.tid))
    const sym = String(opts.symbols || 'cached').toLowerCase()
    if (sym === 'off') args.push('/nosym'); else if (sym === 'full') { /* 默认白名单+msdl，慢 */ } else args.push('/symcached')
    args.push('/top:' + String(Math.min(Math.max(Number(opts.top) || 15, 3), 50)))
    args.push('/json:' + jsonOut)
    const r = await runExe(c.uiFreezeStacks, args, Number(opts.timeoutMs) || 900000)
    if (r.timedOut) return { ok: false, error: 'UiFreezeStacks 超时（trace 太大 / 采集窗口开太久 / full 符号在下 msdl）', etlZip: useZip }
    let data
    try { data = JSON.parse(readFileSync(jsonOut, 'utf8')) } catch {
      return { ok: false, error: 'UiFreezeStacks 输出解析失败', etlZip: useZip, tail: (r.stdout + r.stderr).slice(-600) }
    }
    if (opts.keepEtl === false) { try { rmSync(useZip, { force: true }) } catch { /* ignore */ } }
    return {
      ...data, // freezeThresholdMs, freezeCount, freezeTotalMs, freezes[], threads[], target{}, sessionMs
      ok: true, etlZip: existsSync(useZip) ? useZip : null, jsonPath: jsonOut,
      process: proc || null, pid: pid || null, symbols: sym,
    }
  }

  function listEvidence(limit = 20) {
    try {
      return readdirSync(c.evidenceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const p = join(c.evidenceDir, d.name)
          const files = readdirSync(p).filter((f) => /\.(json|png|dmp|log|txt)$/.test(f)).slice(0, 30)
          return { id: d.name, ts: statSync(p).mtimeMs, files }
        })
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
    } catch {
      return []
    }
  }

  return { config: c, probe, report, dump, analyzeDump, heapStats, gcRoots, uiFreeze, locateType, listEvidence, evidenceDir: () => c.evidenceDir, srcMap }
}

/**
 * F-035（2026-09-12 r33 收尾时读真实证据文件查出）：**被引用的证据文件不含它被引用来支持的内容。**
 *
 * `analyzeDump()` 的 `outPath`（`client.analysis.json`）是 **DumpStack.exe 自己写的原始输出**：
 * 只有 `threads[].frames[].{type,method,module,ip}`，**没有源码映射**。
 * 而「映射到 `LaunchPopupWindow.xaml.cs:58`」是 `summarize()` → `srcMap.mapFrames()` 现算出来的，
 * 过去只活在内存与渲染文本里 —— **从未落盘**。
 * 复核（本机真实证据，20260912-032142-dump/client.analysis.json）：`xaml.cs` 出现 **0 次**、
 * `suspectLine` **0 次**、顶层键里没有 `uiThread`/`srcMap`。
 * 也就是说文档"证据：…client.analysis.json"指着一个**装不下这个结论**的文件。
 *
 * 修法：归纳结果**另行落盘**，与原始文件并列（各司其职，不覆盖）：
 *   `client.analysis.json`         = 原始输出（可拿别的工具独立复核）
 *   `client.analysis.summary.json` = 含 srcMap 的归纳（文档 / agent 实际引用的那份）
 */
export function summaryPathFor(outPath) {
  const p = String(outPath)
  const out = p.replace(/\.analysis\.json$/i, '.analysis.summary.json')
  // 兜底：万一传入的路径不以 `.analysis.json` 结尾，replace 会**原样返回** ——
  //   那就等于用归纳结果**覆盖原始证据**。必须保证返回值与入参不同。
  return out === p ? p + '.summary.json' : out
}

/** 落盘归纳结果。失败时把原因**返回**而不是吞掉 —— 否则又回到"引用了一个不存在的证据文件"。 */
export function writeSummary(outPath, summary) {
  const summaryPath = summaryPathFor(outPath)
  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    return { summaryPath, error: null, bytes: statSync(summaryPath).size }
  } catch (e) {
    return { summaryPath, error: String(e && e.message ? e.message : e), bytes: 0 }
  }
}

/**
 * 把 DumpStack 的原始 JSON 归纳成工具输出（模块级：可离线单测）。
 *
 * F-009（2026-09-11 真机实测确证）：这里过去只产出 `模块!类型.方法`——**类型级**线索，
 * 不是"哪个文件第几行"。用户的原始要求是"拿到实质性的代码证据"，所以现在对每一帧
 * 再跑一次源码映射（见 lib/srcmap.mjs），把 `← 相对路径:行号 (方法声明)` 附上去。
 *
 * 效率：先把两条线程的帧合并，**一次性**批量定位所有类型（1 次 git grep + 每文件 1 次读盘），
 * 而不是逐帧起进程（几十帧会退化到十几秒）。
 *
 * 诚实：映射不到就只给 `模块!类型.方法` 并说明原因；行号是**声明处**，不是执行中的那一行 ——
 * 渲染层必须原样转述这个限定词，绝不能让调用方以为拿到了精确执行位置。
 */
export function summarizeDump(data, srcMap) {
  const threads = (data && data.threads) || []
  const ui = threads.filter((t) => t.uiLikely)
  const uiMid = ui.length > 0 ? ui[0].managedId : null
  // F-013（2026-09-11 单测抓出）：锁热点线程必须与**渲染层口径一致**——
  // 渲染层 `if (!t.lockCount) continue` 会跳过零锁线程，而这里过去仍把零锁线程
  // （以及本来就是 UI 线程的那条）算进 busy，于是：
  //   ① UI 线程的帧被 uiFrames 与 lockFrames 各取一次 → framesTotal 虚高、计数重复；
  //   ② 算了却渲染不出来的帧，白跑源码映射。
  // 现在与渲染层对齐：只要**有锁**且**不是 UI 线程**（UI 线程的栈已单独完整展示）。
  const busy = [...threads]
    .filter((t) => (t.lockCount || 0) > 0 && t.managedId !== uiMid)
    .sort((a, b) => (b.lockCount || 0) - (a.lockCount || 0))
    .slice(0, 5)

  // F-011（2026-09-11 实测）：DumpStack 会吐出 type/method/module **全为空**、只有 ip 的帧
  // （原生/未解析帧）。旧写法把它们拼成空字符串，于是在栈里留下一行莫名奇妙的空白 ——
  // 看起来像渲染故障，实际是"这一帧没解出来"。现在显式标注。
  const frameLine = (f) => {
    const mod = f.module ? basename(f.module) + '!' : ''
    const body = (f.type ? f.type + '.' : '') + (f.method || '')
    if (!mod && !body) return '[未解析帧' + (f.ip ? ' ip=' + f.ip : '') + ']'
    return mod + body
  }
  const isUnresolved = (f) => !f.module && !f.type && !f.method

  const uiFrames = ui.length > 0 ? (ui[0].frames || []).slice(0, 20) : []
  const lockFrames = busy.map((t) => (t.frames || []).slice(0, 12))
  const allFrames = [...uiFrames, ...lockFrames.flat()]
  const mapped = (srcMap && srcMap.mapFrames) ? srcMap.mapFrames(allFrames) : allFrames.map((f) => ({ ...f, src: null }))
  let cursor = 0
  const take = (n) => { const s = mapped.slice(cursor, cursor + n); cursor += n; return s }
  // UD-01（Claude 第三轮实测）：同名类跨文件 / partial class 时必须**如实呈现歧义**。
  // 旧渲染只在"类型声明"路径提 duplicates，方法路径什么都没说 →
  // agent 拿到一个满分自信的 file:line，却不知道还有别的候选文件，
  // 真凶在另一个文件时被静默送错（实测客户端里 ResourceHelper.GetColor 在 3 个策略文件里逐字节相同）。
  const withSrc = (f) => frameLine(f) + (f.src
    ? '\n      ← ' + f.src.file + ':' + f.src.line + ' (' + (f.src.where === 'method' ? '方法声明' : '类型声明') +
      (f.src.candidates > 1 ? '，该文件内 ' + f.src.candidates + ' 处同名' : '') + ')' +
      (f.src.duplicates > 0
        ? '\n      ⚠ 该类型名在源码里有 ' + (f.src.duplicates + 1) + ' 处声明（可能是同名类，或 partial class 的多个片段）——' +
          '上面取的是**首个**，不保证是运行时真正执行的那一个。全部候选：\n        ' +
          (Array.isArray(f.src.typeFiles) ? f.src.typeFiles.join('\n        ') : '(未回报)')
        : '')
    : '')

  const uiMapped = take(uiFrames.length)
  const lockMapped = lockFrames.map((fr) => take(fr.length))
  const resolved = mapped.filter((f) => f.src).length
  const unresolved = mapped.filter((f) => isUnresolved(f)).length
  const srcStatus = (srcMap && srcMap.status) ? srcMap.status() : { usable: false, srcRoot: '', typesResolved: 0, typesMissed: 0 }
  // 如实解释"为什么有些帧没有源码"：框架/系统类型本来就不在客户端源码树里，
  // 把它们和"我们没查到"混为一谈，会让调用方误以为映射整体失败了。
  const srcNote = !srcStatus.usable
    ? '未配置可用的客户端源码根（DSH_PERF_SRC_ROOT / DSH_API_SRC_ROOT），只给到「模块!类型.方法」——要文件:行号请先配置源根。'
    : '源根 ' + srcStatus.srcRoot + '：命中 ' + srcStatus.typesResolved + ' 个类型，' +
      srcStatus.typesMissed + ' 个未命中（**框架/系统类型本就不在客户端源码树里**，未命中多为正常；' +
      '只有客户端自有类型未命中才值得追）。本次另有 ' + unresolved + ' 帧连模块/方法都没解析出来（原生帧）。'

  return {
    dump: data && data.dump,
    threadCount: threads.length,
    uiThread: ui.length > 0
      ? { managedId: ui[0].managedId, osId: ui[0].osId, stack: uiMapped.map(withSrc), frames: uiMapped }
      : null,
    topLockThreads: busy.map((t, i) => ({
      managedId: t.managedId, osId: t.osId, lockCount: t.lockCount || 0, uiLikely: !!t.uiLikely,
      stack: (lockMapped[i] || []).map(withSrc), frames: lockMapped[i] || [],
    })),
    // 证据链健康度：多少帧真落到了源码上。为 0 时调用方必须知道"这不是代码证据"。
    srcMap: {
      framesTotal: allFrames.length, framesResolved: resolved, framesUnresolved: unresolved,
      srcRoot: srcStatus.srcRoot || null, usable: srcStatus.usable, note: srcNote,
    },
  }
}
