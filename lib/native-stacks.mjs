/**
 * 原生栈 unwind —— 补 `DumpStack`（只出**托管**栈）之外的那一半。
 *
 * 为什么需要（2026-09-20 实测，一次 32 位 WPF 客户端卡死排查）：
 *   `DumpStack` 能回答"哪个**托管**方法在等"，但答不了"原生侧是谁在等、有没有卡在图形驱动里"。
 *   没有这一半，所有 agent 都会停在同一个地方：报告写"底层渲染为何未完成仍需原生线程栈"，
 *   然后只能靠猜（另一个 AI 的独立分析就正好停在这里，措辞是"这不代表未解析原生帧已得到验证"）。
 *   而**原生帧这一步是能自动化的** —— 本模块把它做成了可复跑的一条命令。
 *
 * 关键事实（都是踩出来的，别再花时间重踩）：
 *   ① **x64 格式的 WOW64 dump（64 位宿主抓 32 位进程）必须用 64 位调试器**才能解 32 位栈；
 *      32 位 dbgeng 上 `.effmach x86` / `SetEffectiveProcessorType` 返回 `E_INVALIDARG`。
 *   ② **商店版 WinDbg 自带的 cdb.exe 在 `…\WindowsApps\…` 下不能直接执行**（实测"拒绝访问"），
 *      必须先把它拷到可写目录再跑 —— 本模块自动做这一步（也支持 Windows SDK 的调试器）。
 *   ③ `!wow64exts.sw` 是**切换**（toggle）、不是"设为 32 位"：**只在开头切一次**，之后 `~*k`
 *      全是 32 位栈；每条线程都切会把后一半线程切回 64 位视图（第一版就这么白干了一轮）。
 *   ④ WinDbg 表达式默认按**十六进制**解析数字，按 tid 选线程要写 `~~[0n<十进制>]s`，
 *      写 `~~[15188]s` 会被当成 0x15188 → `Illegal thread error`。
 *   ⑤ 符号：微软的（wpfgfx/d3d9/dxgi/user32/ntdll）能从符号服务器下到；
 *      **显卡厂商驱动没有 pdb** → 只能给到 `igc32+0x1a2b3`；NGEN 过的托管程序集
 *      （`*_ni.dll`）在原生栈上**没有方法名**（只有 `PresentationCore_ni+0x…`），
 *      托管方法名要回 `DumpStack` 那份取。
 *
 * 口径（本仓最硬的一条）：解析结果**三态**，绝不把"没解析到"写成"没有" ——
 *   · 解析到帧、且没有厂商驱动帧 → "抓取那一刻没有线程在驱动里"（**不等于**驱动无问题）；
 *   · 有厂商驱动帧 → 点名哪几条线程、在哪一帧；
 *   · 一帧都没解析出来 → "**未解析到任何原生栈**（未知，不是'没有'）"。
 *
 * 纯 Node，无宿主依赖，可离线单测（`--from-log` 走解析路径，不需要 cdb）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 默认从这几个环境变量取 cdb.exe（依次尝试）。 */
export const DEFAULT_CDB_ENV = ['DSH_NATIVE_CDB', 'DSH_PERF_CDB', 'DSH_HANG_CDB']

/** 默认从这几个环境变量取符号路径（已经是 `srv*…` 串的，原样使用）。 */
export const DEFAULT_SYMBOL_ENV = ['DSH_NATIVE_SYMBOL_PATH', 'DSH_PERF_SYMBOL_PATH', 'DSH_HANG_SYMBOL_PATH']

/** WPF / D3D / DWM 这一层：栈上出现这些模块 = 在渲染栈里（仍是用户态框架代码，不是驱动）。 */
const GRAPHICS_STACK_PREFIXES = [
  'wpfgfx', 'presentationcore', 'presentationframework', 'windowsbase', 'milcore',
  'd3d9', 'd3d10', 'd3d11', 'd3d12', 'dxgi', 'dwmapi', 'dcomp', 'd3d10warp', 'd3dcompiler',
]

/** 显卡厂商驱动模块前缀：**在这里面 = 真的在执行驱动代码**。 */
const VENDOR_DRIVER_PREFIXES = [
  'igc', 'igd', 'igfx', 'igdlh', 'nvwgf2um', 'nvlddmkm', 'nvoglv', 'nvcuda',
  'atio', 'atiogl', 'amdvlk', 'amdxc', 'amdgfx', 'amdwddm',
]

const THREAD_HEADER_RE = /^\s*[.#]?\s*(\d+)\s+Id:\s+([0-9a-f]+)\.([0-9a-f]+)\s/
const FRAME_LINE_RE = /^(?:\d{2}\s+)?([0-9a-f`]{8,20})\s+([0-9a-f`?]{8,20})\s+(\S.*)$/
const SKIP_LINE_RE = /(WARNING:|DBGHELP:|Unable to|^\*\*\*|^\s*$)/

/**
 * 解析一行帧文本，抽出模块名 / 符号 / 偏移。
 * 形态实测有四种：`ntdll_77e30000!NtWaitForSingleObject+0xc`、`WindowsBase_ni+0xc88d1`、
 * `0x11ad08e`、以及未解析时的空串。
 * @param {string} text
 * @returns {{module:string, symbol:string, offset:string, resolved:boolean, text:string}}
 */
export function parseFrame(text) {
  const t = String(text || '').trim()
  const bang = t.indexOf('!')
  if (bang > 0) {
    const module = t.slice(0, bang)
    const rest = t.slice(bang + 1)
    const plus = rest.lastIndexOf('+')
    return {
      module,
      symbol: plus > 0 ? rest.slice(0, plus) : rest,
      offset: plus > 0 ? rest.slice(plus + 1) : '',
      resolved: true,
      text: t,
    }
  }
  const plus = t.lastIndexOf('+')
  if (plus > 0 && /^[\w.\-]+$/.test(t.slice(0, plus))) {
    return { module: t.slice(0, plus), symbol: '', offset: t.slice(plus + 1), resolved: false, text: t }
  }
  return { module: '', symbol: '', offset: '', resolved: false, text: t }
}

const startsWithAny = (s, list) => {
  const low = String(s || '').toLowerCase()
  return list.some((p) => low.startsWith(p))
}

/** 这一帧是不是在**显卡厂商驱动**里执行。 */
export function isVendorDriverFrame(frame) {
  const f = typeof frame === 'string' ? parseFrame(frame) : frame
  return !!f.module && startsWithAny(f.module, VENDOR_DRIVER_PREFIXES)
}

/** 这一帧是不是在 WPF / D3D / DWM 这一层。 */
export function isGraphicsStackFrame(frame) {
  const f = typeof frame === 'string' ? parseFrame(frame) : frame
  return !!f.module && startsWithAny(f.module, GRAPHICS_STACK_PREFIXES)
}

/**
 * 把 `~*k` 的原始输出解析成"每条线程一段栈"。
 * 兼容 32 位（`ChildEBP RetAddr`）与 64 位（`Child-SP RetAddr Call Site`）两种排版，
 * 以及 WinDbg 在线程列表 `~` 里输出的那种"只有 Id、没有帧"的表头（会被丢掉）。
 * @param {string} text
 * @returns {{threads:Array<{index:number,pid:string,tid:number,mode:string,frames:string[]}>, frameLines:number, skippedHeaders:number}}
 */
export function parseNativeStacks(text) {
  const lines = String(text || '').split(/\r?\n/)
  const threads = []
  let cur = null
  let frameLines = 0
  let skippedHeaders = 0

  const flush = () => {
    if (cur) {
      // 帧表头（ChildEBP/Child-SP）在线程头**之后**才出现，拿不到时用首帧地址宽度兜底：
      // 64 位地址带反引号（`00000000`18bbee98`）或去掉反引号后超过 8 位十六进制。
      if (!cur.mode) {
        const a = cur.addr || ''
        cur.mode = a.indexOf('`') >= 0 || a.replace(/`/g, '').length > 8 ? 'x64' : 'x86'
      }
      if (cur.frames.length) threads.push(cur)
      else skippedHeaders++
    }
    cur = null
  }

  for (const line of lines) {
    if (/^\s*ChildEBP\s+RetAddr/.test(line)) { if (cur) cur.mode = 'x86'; continue }
    if (/^\s*Child-SP\s+RetAddr/.test(line)) { if (cur) cur.mode = 'x64'; continue }
    const hdr = THREAD_HEADER_RE.exec(line)
    if (hdr) {
      flush()
      cur = { index: Number(hdr[1]), pid: hdr[2], tid: parseInt(hdr[3], 16), mode: '', addr: '', frames: [] }
      continue
    }
    if (!cur) continue
    if (SKIP_LINE_RE.test(line)) continue
    const fr = FRAME_LINE_RE.exec(line)
    if (fr) {
      if (!cur.addr) cur.addr = String(fr[1])
      cur.frames.push(String(fr[3]).trim())
      frameLines++
    }
  }
  flush()
  return { threads, frameLines, skippedHeaders }
}

/**
 * 汇总：谁在驱动里、谁在渲染栈上，以及**三态口径**的结论。
 * @param {Array} threads parseNativeStacks().threads
 * @param {{partial?:boolean, reason?:string}} [o] `partial` = 本次运行没跑完（超时/失败），结论必须自曝只覆盖一部分
 * @returns {{threadCount:number, framesTotal:number, resolvedFrames:number, unresolvedFrames:number,
 *            runningInVendorDriver:Array, graphicsStackThreads:Array, partial:boolean, verdict:string}}
 */
export function summarizeNativeStacks(threads, o = {}) {
  const list = Array.isArray(threads) ? threads : []
  let framesTotal = 0
  let resolvedFrames = 0
  const runningInVendorDriver = []
  const graphicsStackThreads = []

  for (const t of list) {
    framesTotal += t.frames.length
    let graphicsHit = null
    for (let i = 0; i < t.frames.length; i++) {
      const f = parseFrame(t.frames[i])
      if (f.resolved) resolvedFrames++
      if (!graphicsHit && isGraphicsStackFrame(f)) graphicsHit = { frame: t.frames[i], index: i }
      if (isVendorDriverFrame(f)) runningInVendorDriver.push({ tid: t.tid, frameIndex: i, frame: t.frames[i] })
    }
    if (graphicsHit) {
      graphicsStackThreads.push({ tid: t.tid, top: t.frames[0], hitIndex: graphicsHit.index, hit: graphicsHit.frame })
    }
  }

  const unresolvedFrames = framesTotal - resolvedFrames
  // x86 的栈回溯要 **PDB**（FPO/展开信息在 pdb 里，不在 PE 里；x64 才有 RUNTIME_FUNCTION）。
  // 没有符号时 dbghelp 直接放弃：实测同一份 32 位 dump，无符号档每条线程只剩 1 帧
  // （`wow64cpu!TurboDispatchJumpAddressEnd+0x515`，RetAddr=00000000），有符号档 1099 帧。
  // ⇒ 这种形态**不是"栈很浅"，是没回溯出来**，必须喊出来，否则 1 帧的栈会被读成"没人在驱动里"。
  // 判据用**中位数**而不是平均值：实测那份"没回溯出来"的日志平均 2.61 帧/线程（少数线程帧多把均值拉起来了），
  // 平均值会被糊弄过去；中位数是 1（对比有符号档：中位数 10、只有 ≤1 帧的线程占 0%）。
  const counts = list.map((t) => t.frames.length).sort((a, b) => a - b)
  const medianFrames = counts.length ? counts[Math.floor(counts.length / 2)] : 0
  const shareLe1 = counts.length ? counts.filter((c) => c <= 1).length / counts.length : 0
  const avgFrames = list.length ? framesTotal / list.length : 0
  const walkLooksBroken = list.length >= 5 && (medianFrames < 2 || shareLe1 >= 0.6)
  let base
  if (list.length === 0) {
    base = '未解析到任何原生栈（未知，不是"没有"）：检查 dump 能否被这个 cdb 打开、`!wow64exts.sw` 是否成功、以及日志里是否只有线程列表没有 `k` 输出。'
  } else if (runningInVendorDriver.length > 0) {
    base = `${runningInVendorDriver.length} 处帧落在显卡驱动模块里（${runningInVendorDriver.map((h) => `tid=${h.tid}:${h.frame}`).slice(0, 5).join('、')}）—— 这才是"有线程正在驱动里执行"。`
  } else {
    base = `解析到 ${list.length} 条线程的原生栈，没有任何一条在执行显卡驱动模块 —— ` +
      '这只说明**抓取那一刻**没有线程在驱动里，不等于驱动无问题，也不能反推"驱动没卡过"。'
  }
  // 两种"这份结果不完整"的状态都要自曝，否则空结论会被读成"没有"：
  //   ① 没跑完（超时/失败）→ 只覆盖已写出的部分；② 栈没回溯出来（多半是没符号）→ 一律不适用。
  const notes = []
  if (walkLooksBroken) {
    notes.push(`⚠ 解出的栈明显不完整（${list.length} 条线程共 ${framesTotal} 帧；中位数 ${medianFrames} 帧/线程，` +
      `${Math.round(shareLe1 * 100)}% 的线程只有 ≤1 帧）：` +
      '32 位目标的栈回溯**需要 PDB**（x86 的 FPO 信息在 pdb 里，不在 PE 里），没有符号时 dbghelp 会直接放弃。' +
      '别拿这份结果判断"在不在驱动里"。')
  }
  if (o.partial) {
    notes.push(`⚠ 本次运行没有跑完${o.reason ? '（' + o.reason + '）' : ''}：下面的结论只覆盖日志里已写出的 ${list.length} 条线程，不能当全量结论。`)
  }
  const verdict = notes.join('') + base

  return {
    threadCount: list.length, framesTotal, resolvedFrames, unresolvedFrames,
    runningInVendorDriver, graphicsStackThreads, partial: !!o.partial,
    walkLooksBroken, avgFramesPerThread: Number(avgFrames.toFixed(2)),
    medianFramesPerThread: medianFrames, shareThreadsWithOneFrameOrLess: Number(shareLe1.toFixed(2)), verdict,
  }
}

/**
 * 拼 cdb 的 `-c` 命令串。**`!wow64exts.sw` 只出现一次**（见文件头 ③：它是切换不是设置）。
 * @param {object} o
 * @param {number} [o.frames=24]  `.kframes`，每条线程取多少帧
 * @param {number[]} [o.threads]  只解这几条线程（十进制 tid）；空 = `~*k` 全量
 * @param {boolean} [o.switchWow64=true] 是否切到 WOW64 的 32 位视图
 */
export function buildUnwindCommands(o = {}) {
  const frames = Number.isFinite(o.frames) && o.frames > 0 ? Math.floor(o.frames) : 24
  const parts = [`.kframes ${frames}`]
  if (o.switchWow64 !== false) parts.push('!wow64exts.sw')
  const threads = (o.threads || []).filter((n) => Number.isInteger(n) && n > 0)
  if (threads.length) {
    for (const t of threads) parts.push(`~~[0n${t}]s`, `.echo ===TID-${t}===`, 'r', 'k')
  } else {
    parts.push('.echo ===ALL-THREADS===', '~*k')
  }
  parts.push('q')
  return parts.join('; ')
}

/** 默认符号路径：显式 env 优先，否则"临时目录缓存 + 微软符号服务器"。 */
export function resolveSymbolPath(env = process.env, cacheDir) {
  for (const n of DEFAULT_SYMBOL_ENV) {
    const v = env[n]
    if (v && String(v).trim() !== '') return { value: String(v).trim(), from: n }
  }
  const dir = cacheDir || join(tmpdir(), 'dsh-native-symbols')
  return { value: `srv*${dir}*https://msdl.microsoft.com/download/symbols`, from: '默认（本地缓存 + 微软符号服务器）' }
}

/**
 * 快速档用的"空符号目录"。
 * ⚠ **必须是一个存在的目录**：把符号路径传成空串并不能关掉下载 —— 实测 cdb 会回退到内置默认
 * `<cdb目录>\sym*https://msdl.microsoft.com/download/symbols`，日志里出现
 * `DBGHELP: Timeout to store: …msdl…`，一个小 dump 600s 只出 1 条线程。
 */
export function resolveNoSymbolDir(cacheDir) {
  const dir = cacheDir || join(tmpdir(), 'dsh-native-nosym')
  mkdirSync(dir, { recursive: true })
  return dir
}

const isUnderWindowsApps = (p) => /[\\/]WindowsApps[\\/]/i.test(String(p || ''))

/** 商店版 WinDbg 包里的 cdb（按包名倒序 = 版本新的优先）。 */
function findStoreWindbg(env, opts = {}) {
  const root = env.ProgramFiles || 'C:\\Program Files'
  const out = []
  let pkgs = []
  try {
    pkgs = readdirSync(join(root, 'WindowsApps')).filter((n) => /^Microsoft\.WinDbg_/i.test(n)).sort().reverse()
  } catch { return out }
  for (const pkg of pkgs) {
    for (const arch of ['amd64', 'x86']) {
      const p = join(root, 'WindowsApps', pkg, arch, 'cdb.exe')
      if ((opts.existsSync || existsSync)(p)) out.push(p)
    }
  }
  return out
}

/** 从 PATH 找 cdb（Windows 的 `where`，其它平台 `which`）。 */
function findOnPath(opts = {}) {
  const res = (opts.spawnSync || spawnSync)(process.platform === 'win32' ? 'where' : 'which', ['cdb'], { encoding: 'utf8' })
  if (res.status !== 0 || !res.stdout) return []
  return String(res.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 把 WindowsApps 里的调试器**拷到可写目录**再返回新路径。
 * 原因：那里直接执行会被拒（实测"拒绝访问"）；原包不动，只拷 cdb + 引擎 dll + 两个扩展目录。
 */
export function copyDebuggerOut(cdbPath, cacheDir, opts = {}) {
  const srcDir = dirname(cdbPath)
  const pkg = basename(dirname(srcDir))
  const dstDir = join(cacheDir || join(tmpdir(), 'dsh-native-cdb'), pkg, basename(srcDir))
  const dstCdb = join(dstDir, 'cdb.exe')
  const exists = opts.existsSync || existsSync
  const copy = opts.copyFileSync || copyFileSync
  if (exists(dstCdb)) return dstCdb
  mkdirSync(dstDir, { recursive: true })
  for (const f of ['cdb.exe', 'dbgeng.dll', 'dbghelp.dll', 'dbgcore.dll', 'symsrv.dll', 'dbgmodel.dll']) {
    const from = join(srcDir, f)
    if (exists(from)) copy(from, join(dstDir, f))
  }
  // 扩展：ext.dll（winext）与 wow64exts.dll（winxp）—— `!wow64exts.sw` 就在后者里
  for (const sub of ['winext', 'winxp']) {
    const from = join(srcDir, sub)
    if (!exists(from)) continue
    mkdirSync(join(dstDir, sub), { recursive: true })
    for (const f of readdirSync(from)) {
      const src = join(from, f)
      try { if (statSync(src).isFile()) copy(src, join(dstDir, sub, f)) } catch { /* 拷不动的单个扩展不影响 cdb 主流程 */ }
    }
  }
  return dstCdb
}

/**
 * 定位一个可执行的 cdb.exe。
 * @returns {{path:string, origin:string, copiedFrom:string, searched:string[], warnings:string[]}}
 */
export function resolveCdb(o = {}) {
  const env = o.env || process.env
  const exists = o.existsSync || existsSync
  const searched = []
  const candidates = []
  const add = (p, from) => { if (p) { candidates.push({ p, from }); searched.push(p) } }

  for (const n of (o.envNames || DEFAULT_CDB_ENV)) {
    const v = env[n]
    if (v && String(v).trim() !== '') add(String(v).trim(), n)
  }
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean)) {
    add(join(base, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'), 'Windows SDK 调试器（x64）')
    add(join(base, 'Windows Kits', '10', 'Debuggers', 'x86', 'cdb.exe'), 'Windows SDK 调试器（x86）')
  }
  for (const p of (o.storeWindbg || findStoreWindbg(env, { existsSync: exists }))) add(p, '商店版 WinDbg 包')
  for (const p of (o.onPath || findOnPath({ spawnSync: o.spawnSync }))) add(p, 'PATH')

  const hit = candidates.find((c) => exists(c.p))
  if (!hit) {
    return {
      path: '', origin: '', copiedFrom: '', searched, warnings: [
        '找不到 cdb.exe（64 位调试器）：**32 位原生栈只有 64 位调试器解得出来**（32 位 dbgeng 改 `.effmach x86` 会 E_INVALIDARG）。' +
        '装一个带 cdb 的调试器即可：`winget install Microsoft.WinDbg`（商店版自带 `amd64\\cdb.exe`），' +
        '或装 Windows SDK 的 Debugging Tools；也可以用 ' + (o.envNames || DEFAULT_CDB_ENV).join(' / ') + ' 直接指向 cdb.exe。试过：' + searched.join('、'),
      ],
    }
  }
  if (isUnderWindowsApps(hit.p)) {
    const copied = (o.copyDebugger || copyDebuggerOut)(hit.p, o.cacheDir, { existsSync: exists, copyFileSync: o.copyFileSync })
    return {
      path: copied,
      origin: hit.from + '（原位置在 WindowsApps 下**不能直接执行**，已自动拷到可写目录）',
      copiedFrom: hit.p,
      searched,
      warnings: [],
    }
  }
  return { path: hit.p, origin: hit.from, copiedFrom: '', searched, warnings: [] }
}

/**
 * 跑一次 unwind。日志同时落盘（便于复查/进证据包）。
 * @returns {{exitCode:number, stdout:string, logFile:string, args:string[]}}
 */
/** 默认超时：首次跑在从符号服务器下 pdb，给足 30 分钟（`--timeout 0` = 不限）。 */
export const DEFAULT_TIMEOUT_MS = 1800000

export function runNativeStacks(o = {}) {
  const spawn = o.spawnSync || spawnSync
  const args = ['-z', o.dump, '-y', o.symbols, '-c', o.commands]
  const timeoutMs = o.timeoutMs === 0 ? undefined : (o.timeoutMs || DEFAULT_TIMEOUT_MS)
  const r = spawn(o.cdbPath, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs })
  const stdout = String(r.stdout || '') + String(r.stderr || '')
  if (o.outFile) writeFileSync(o.outFile, stdout, 'utf8')
  // status === null = 被超时杀掉或启动失败。**必须**如实标出来：否则半份日志会被当成全量结论
  // （实测：默认符号缓存是空的时候，首次跑能把 900s 超时用光，只解出 2/94 条线程）。
  const killed = r.status === null
  return {
    exitCode: killed ? -1 : r.status,
    killed,
    error: r.error ? String(r.error.message || r.error) : '',
    timeoutMs: timeoutMs || 0,
    stdout,
    logFile: o.outFile || '',
    args,
  }
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log(`用法: node lib/native-stacks.mjs <dump> [选项]

  --out <file>        把 cdb 原始输出写到这个文件（强烈建议：便于复查/进证据包）
  --frames <n>        每条线程取几帧（默认 24）
  --threads <tid,...> 只解这几条线程（十进制 tid，逗号分隔）；默认全量 ~*k
  --no-wow64-switch   不执行 !wow64exts.sw（解 64 位 dump 时用）
  --symbols <path>    符号路径（srv*…）；默认取 DSH_*_SYMBOL_PATH，否则本地缓存 + 微软符号服务器
  --no-symbols        快速档：不下载任何 pdb（模块名来自 dump 本身，够回答"在不在驱动里"）
  --cdb <path>        指定 cdb.exe（否则自动找：env → Windows SDK → 商店版 WinDbg → PATH）
  --timeout <sec>     cdb 超时秒数（默认 1800；0 = 不限）。首次跑要下符号，别把超时调小
  --from-log <file>   不跑 cdb，只解析已有日志（离线可复跑）
  --json              输出机器可读 JSON
`)
}

function main(argv) {
  const opts = { frames: 24, wow64: true }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--frames') opts.frames = Number(argv[++i])
    else if (a === '--threads') opts.threads = String(argv[++i]).split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger)
    else if (a === '--no-wow64-switch') opts.wow64 = false
    else if (a === '--symbols') opts.symbols = argv[++i]
    else if (a === '--no-symbols') opts.noSymbols = true
    else if (a === '--cdb') opts.cdb = argv[++i]
    else if (a === '--timeout') opts.timeout = Number(argv[++i]) * 1000
    else if (a === '--from-log') opts.fromLog = argv[++i]
    else if (a === '--json') opts.json = true
    else if (a === '-h' || a === '--help') { usage(); return 0 }
    else positional.push(a)
  }
  const dump = positional[0]
  if (!dump && !opts.fromLog) { usage(); return 1 }

  const commands = buildUnwindCommands({ frames: opts.frames, threads: opts.threads, switchWow64: opts.wow64 })
  let text = ''
  const meta = { dump: dump ? resolve(dump) : '', cdb: '', cdbOrigin: '', copiedFrom: '', symbols: '', symbolsOrigin: '', commands, exitCode: null, killed: false, partialReason: '', logFile: '', elapsedMs: 0 }

  if (opts.fromLog) {
    text = readFileSync(opts.fromLog, 'utf8')
    meta.logFile = resolve(opts.fromLog)
  } else {
    const cdb = opts.cdb ? { path: opts.cdb, origin: '--cdb 指定', copiedFrom: '', warnings: [] } : resolveCdb()
    if (!cdb.path) { console.error(cdb.warnings.join('\n')); return 2 }
    meta.cdb = cdb.path; meta.cdbOrigin = cdb.origin; meta.copiedFrom = cdb.copiedFrom
    // 无符号档：**回答"有没有线程在 igc32/d3d9 里"只需要模块名**，而模块表就在 dump 里。
    const sym = opts.noSymbols
      ? { value: resolveNoSymbolDir(), from: '--no-symbols（快速档：空目录覆盖符号路径，只到模块级）' }
      : (opts.symbols ? { value: opts.symbols, from: '--symbols 指定' } : resolveSymbolPath())
    meta.symbols = sym.value; meta.symbolsOrigin = sym.from
    const t0 = Date.now()
    const run = runNativeStacks({ dump, cdbPath: cdb.path, symbols: sym.value, commands, outFile: opts.out, timeoutMs: opts.timeout })
    meta.elapsedMs = Date.now() - t0
    meta.exitCode = run.exitCode
    meta.killed = run.killed
    meta.logFile = run.logFile ? resolve(run.logFile) : ''
    // 没跑完（超时被杀 / 启动失败 / 非零退出）必须传下去：日志只有前半截，结论不能当全量
    if (run.killed) meta.partialReason = `cdb 在 ${Math.round(run.timeoutMs / 1000)}s 超时被结束` + (run.error ? `（${run.error}）` : '')
    else if (run.exitCode !== 0) meta.partialReason = `cdb 退出码 ${run.exitCode}`
    text = run.stdout
  }

  const parsed = parseNativeStacks(text)
  const sum = summarizeNativeStacks(parsed.threads, { partial: !!meta.partialReason, reason: meta.partialReason })

  if (opts.json) {
    console.log(JSON.stringify({ ...meta, ...sum, frameLines: parsed.frameLines, droppedEmptyHeaders: parsed.skippedHeaders }, null, 2))
    return 0
  }

  console.log('=== 原生栈 unwind ===')
  console.log('dump    : ' + (meta.dump || '(来自 --from-log)'))
  if (meta.cdb) console.log('cdb     : ' + meta.cdb + '  ← ' + meta.cdbOrigin)
  if (meta.copiedFrom) console.log('          原位置: ' + meta.copiedFrom)
  if (meta.symbolsOrigin) console.log('符号    : ' + (meta.symbols || '(不加载)') + '  ← ' + meta.symbolsOrigin)
  console.log('命令    : ' + commands)
  if (meta.exitCode !== null) console.log('退出码  : ' + meta.exitCode + '  用时 ' + (meta.elapsedMs / 1000).toFixed(1) + 's')
  if (meta.logFile) console.log('日志    : ' + meta.logFile)
  if (meta.partialReason) {
    console.log('⚠ 未跑完: ' + meta.partialReason)
    console.log('          日志只写了已产出的部分（多半是首次跑在从符号服务器下 pdb）。')
    console.log('          建议：复用一份已经热过的符号缓存 —— 把 DSH_NATIVE_SYMBOL_PATH（或 DSH_PERF_SYMBOL_PATH）指向它再跑一次。')
  }
  console.log('')
  console.log(`解析：${sum.threadCount} 条线程 / ${sum.framesTotal} 帧（有符号 ${sum.resolvedFrames}，未解析 ${sum.unresolvedFrames}）`)
  console.log('【结论】' + sum.verdict)
  if (sum.runningInVendorDriver.length) {
    console.log('驱动里的帧：')
    for (const h of sum.runningInVendorDriver.slice(0, 20)) console.log(`  tid=${h.tid}  帧${h.frameIndex}: ${h.frame}`)
  }
  if (sum.graphicsStackThreads.length) {
    console.log(`图形栈上的线程（wpfgfx/d3d/dxgi/…）：${sum.graphicsStackThreads.length} 条`)
    for (const t of sum.graphicsStackThreads.slice(0, 20)) console.log(`  tid=${t.tid}  帧0: ${t.top}${t.hitIndex ? `   命中@帧${t.hitIndex}: ${t.hit}` : ''}`)
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (e) { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 3 }
}
