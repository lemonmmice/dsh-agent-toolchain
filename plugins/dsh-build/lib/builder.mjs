/**
 * dsh-build builder — MSBuild 进程封装 + 错误结构化解析。
 * 不依赖 DSH API，可独立单测。
 */
import { envOr } from '../../../lib/env-fallback.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname as dirNameOf } from 'node:path'
import { homedir } from 'node:os'
import { decodeBuffer } from '../../../lib/decode.mjs'
// F-007：宿主不热加载插件代码 —— 让 build_status / build_errors 自己说出"我跑的是旧代码"。
import { staleCodeInfo, moduleRoots } from '../../../lib/code-freshness.mjs'
import { fileURLToPath as fileUrlToPath } from 'node:url'

/** 本插件目录（仓库与 profile 两种布局下都成立）。 */
const BUILD_PLUGIN_DIR = dirNameOf(dirNameOf(fileUrlToPath(import.meta.url)))
/** 本插件 lib/ 目录 —— 后台构建执行器（build-bg-runner.mjs）与本文件同级。 */
const BUILD_LIB_DIR = dirNameOf(fileUrlToPath(import.meta.url))
import {
  isSolutionPath,
  isProjectPath,
  isLegacyLayout,
  resolveTargetPath,
  findDefaultSolution,
  defaultPlatformFor,
} from '../../../lib/build-resolve.mjs'

const VS_MSBUILD = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe'
const VSWITCH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'

/**
 * 统一的**失败返回形状**。
 *
 * BV-03（2026-09-11 审计确证）：`build()` 的 6 条早返回过去只写 `{ ok: false, error }`，
 * 而 DSH 面的 `renderBuild` 无条件读 `v.errors.length` → TypeError → 宿主把它换成
 * `INVALID_TOOL_OUTPUT: output.render failed`，那句**唯一能自救**的
 * 「传 repoRoot 或设置 DSH_BUILD_REPO_ROOT」被整个吃掉。
 * 最常见的触发路径恰恰是"没传 repoRoot"—— 也就是最需要看懂错误的那种情况。
 *
 * 现在所有失败路径走这里，保证形状一致：计数为 0、数组为空，而不是"没有这个字段"。
 * 调用方（DSH 与 MCP 两面）因此可以无条件读 errors/warnings/errorCount。
 */
function failResult(error, extra = {}) {
  return {
    ok: false,
    // BV-05 配套：显式的"这次构建**没有开始执行**"标记。
    // 不能靠 `errorCount===undefined` 或 `durationMs===null` 之类的间接特征去猜 ——
    // failResult 会把 errorCount 补成 0（有限值），于是"没跑"与"跑了但 0 错误"在数据上长得一样，
    // 渲染层只能猜错。（我第一版就是靠猜，结果那个分支永远不触发。）
    didNotRun: true,
    error,
    target: null,
    logPath: null,
    durationMs: null,
    errors: [],
    warnings: [],
    envErrors: [],
    errorCount: 0,
    warningCount: 0,
    envErrorCount: 0,
    truncated: false,
    ...extra,
  }
}

/**
 * 由「pid 归属明细」推导强杀终态（**纯函数**，F-038）。
 *
 * 抽出来的理由（就是 F-037 的教训）：这段判决此前埋在 `killClientProcess()` 里，
 * 而那个函数的输入要靠**真实进程**才能构造 ⇒ 竞态窗口**没法单测** ⇒ 缺陷活到 r34 被独立复核查出。
 * 现在它是纯函数：给一组明细就能精确模拟「判活与判占用之间进程刚好退出」那个窗口。
 *
 * 判决规则（关键：**判决只从这份明细推导**，因此判决与证据永远不可能互相矛盾）：
 *   · `owner === null`（这个号彻底没了）      ⇒ **不算没杀掉**（本来就已经结束了）→ `goneWhileChecking`
 *   · `owner !== null` 但不是我们的进程       ⇒ **不算没杀掉**（pid 被复用）        → `pidReused`
 *   · `owner !== null` 且仍是我们的进程        ⇒ **才算没杀掉**                    → `remaining`
 * `killed` = `remaining.length === 0`。
 *
 * @param {{detail: Array<{pid:number,owner:string|null}> , isReused: (pid:number)=>boolean}} args
 */
export function killOutcome({ detail, isReused, waitMs = 0 }) {
  const rows = Array.isArray(detail) ? detail : []
  const reusedOf = typeof isReused === 'function' ? isReused : () => false
  const pidReused = rows.filter((d) => d.owner !== null && reusedOf(d.pid)).map((d) => d.pid)
  const goneWhileChecking = rows.filter((d) => d.owner === null).map((d) => d.pid)
  const remaining = rows.filter((d) => d.owner !== null && !pidReused.includes(d.pid)).map((d) => d.pid)
  const killed = remaining.length === 0
  let note
  if (!killed) {
    note = '等待 ' + waitMs + 'ms 后目标进程仍在（见 remainingDetail）。'
  } else if (pidReused.length > 0 || goneWhileChecking.length > 0) {
    note = '目标已结束（'
      + (goneWhileChecking.length > 0 ? goneWhileChecking.length + ' 个 pid 号在核对窗口内消失' : '')
      + (goneWhileChecking.length > 0 && pidReused.length > 0 ? '；' : '')
      + (pidReused.length > 0 ? pidReused.length + ' 个 pid 号已被别的进程占用（pid 复用）' : '')
      + '）—— 这不算"没杀掉"。'
  }
  return { killed, remaining, pidReused, goneWhileChecking, ...(note ? { note } : {}) }
}

export function makeBuilder(cfg) {
  const c = {
    clientRoot: envOr('DSH_BUILD_CLIENT_ROOT'),
    repoRoot: envOr('DSH_BUILD_REPO_ROOT'),
    msbuild: VS_MSBUILD,
    engine: process.env.DSH_BUILD_ENGINE || 'msbuild',
    logsDir: join(homedir(), '.dsh-agent-toolchain', 'build-logs'),
    incrementalTimeoutMs: 8 * 60 * 1000,
    rebuildTimeoutMs: 15 * 60 * 1000,
    ...cfg,
  }
  // 空字符串不是「配置」：调用方习惯写 logsDir: process.env.X || ''，
  // 展开后会把默认目录清空，mkdirSync('') 直接 ENOENT（实测 MCP build_run）。
  // 空值统一回落到默认，避免这类「传空即崩」的坑。
  if (!c.logsDir) c.logsDir = join(homedir(), '.dsh-agent-toolchain', 'build-logs')
  if (!c.msbuild) c.msbuild = VS_MSBUILD
  if (!c.clientRoot) c.clientRoot = envOr('DSH_BUILD_CLIENT_ROOT')
  if (!c.repoRoot) c.repoRoot = envOr('DSH_BUILD_REPO_ROOT')

  // ------------------------------------------------------------ 编码
  // 双解码收敛到 lib/decode.mjs（builder / driver / perf 共用）

  // ------------------------------------------------------------ MSBuild 定位

  function findMsbuild() {
    if (c.msbuild && existsSync(c.msbuild)) return c.msbuild
    if (existsSync(VS_MSBUILD)) return VS_MSBUILD
    try {
      const out = execFileSync(VSWITCH, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-property', 'installationPath'], { encoding: 'utf8' })
      const root = out.trim().split(/\r?\n/)[0]
      if (root) {
        const p = join(root, 'MSBuild\\Current\\Bin\\MSBuild.exe')
        if (existsSync(p)) return p
      }
    } catch { /* ignore */ }
    return null
  }

  // ------------------------------------------------------------ 客户端进程检测

  /** 列出同名进程的全部 PID（tasklist CSV 可能多行）；失败一律当「没在跑」。 */
  function listClientPids(proc) {
    if (!proc) return []
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + proc + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const pids = []
      const re = new RegExp('"' + proc + '\\.exe","(\\d+)"', 'g')
      let m
      while ((m = re.exec(out)) !== null) pids.push(Number(m[1]))
      return pids
    } catch { return [] }
  }

  /** 单个 PID 是否还活着（按 PID 精确判定，不用「同名进程列表」当判据）。 */
  function isPidAlive(pid) {
    if (!pid) return false
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      return new RegExp('","' + pid + '",').test(out)
    } catch { return false }
  }

  /**
   * 这个 pid 现在**是不是我们的目标进程**（防 pid 复用）。
   *
   * F-028（2026-09-12，r29 真机整套并发跑时抓到）：`kill-client.test.mjs` 偶发报
   * `{"killed":false, "scope":"single-instance", "pids":[30960], …}` —— **而紧随其后的断言
   * "进程确实没了（按 PID 判定）"却是通过的**（按**进程名**枚举已经找不到它了）。
   * 两个判据同时成立只有一种解释：**pid 被复用了** —— 我们那个 `ping` 已经死了，但那个**号**
   * 被另一个无关进程（名字不同）接手，于是 `isPidAlive(pid)` 一直为真，`killed` 被判成 false。
   * 整套并发跑时进程创建/销毁极密集，15 秒窗口内 pid 被复用完全可能 —— 这解释了它为什么**偶发**。
   *
   * 后果与 F-024 同类：**做成了的事被回报成没做成**，而且这个 `killed` 会被带进构建结果与渲染文本
   * （`clientKill.killed` / `clientWasKilled`），让用户以为"客户端还在跑，所以构建可能不可信"。
   *
   * 判据：pid 在 **且** 该 pid 当前的镜像名仍是目标名 —— 否则视为"已消失（pid 被复用）"。
   */
  function isTargetAlive(pid, name) {
    if (!pid) return false
    const owner = pidOwner(pid)
    if (owner === null) return false                   // 号都不在了
    // name 可能给的是**全路径**、也可能是不带扩展名的镜像名 —— 统一取 basename 比，
    // 否则"配了 exe 全路径"的用户会被判成"进程已消失"（那是把没杀掉的报成杀掉了，比原缺陷更糟）。
    const want = basename(String(name ?? '')).toLowerCase()
    if (want === '') return true                       // 没给名字就退回按号判定
    const img = owner.image.toLowerCase()
    return img === want || img + '.exe' === want || img === want + '.exe'
  }

  /** 这个 pid 现在被**谁**占着（用于把"pid 复用"这件事说出来，而不是只报一个 false）。 */
  function pidOwner(pid) {
    try {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const line = out.trim().split(/\r?\n/)[0] ?? ''
      const m = /^"([^"]+)","(\d+)",/.exec(line)
      return m === null ? null : { pid: Number(m[2]), image: m[1] }
    } catch { return null }
  }

  /**
   * 同名进程的**实例明细**（PID + 可执行文件全路径），用于「按目标实例定位」。
   *
   * 为什么不能只看镜像名：`tasklist /FI IMAGENAME eq X.exe` 会把**所有**同名实例找出来 ——
   * 别的会话、别的用户、甚至测试宿主的同名进程都在里面。B-3 的复核（Codex，2026-09-11）
   * 把「按镜像名杀全部同名实例」判为 blocker（触犯「不误杀非目标进程」红线），这条实现就是修它。
   * 走一次 PowerShell/WMI 才拿得到 ExecutablePath，所以只在**真要动手/有歧义**时才调用。
   */
  function clientInstances(name) {
    if (!name) return []
    const pids = listClientPids(name)
    if (pids.length === 0) return []
    if (pids.length === 1) {
      // 只有一个实例：路径信息只作展示，不阻塞
      return [{ pid: pids[0], path: exePathOf(pids[0]) }]
    }
    return pids.map((pid) => ({ pid, path: exePathOf(pid) }))
  }

  /** 取某个 PID 的可执行文件全路径（拿不到就返回空串，绝不抛）。 */
  function exePathOf(pid) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").ExecutablePath'], { encoding: 'utf8', windowsHide: true })
      return String(out || '').trim().split(/\r?\n/)[0] || ''
    } catch { return '' }
  }

  function clientProcess() {
    const proc = envOr('DSH_BUILD_CLIENT_PROC') || envOr('DSH_UI_PROC_NAME')
    if (!proc) return { running: false, pid: null, pids: [], unconfigured: true }
    const pids = listClientPids(proc)
    if (pids.length) return { running: true, pid: pids[0], pids, name: proc }
    return { running: false, pid: null, pids: [], name: proc }
  }

  /**
   * 结束目标客户端（B-3）：按**目标实例**定位 + **等它真的退出**。
   *
   * 为什么必须等：`taskkill` 是异步的，旧实现 `spawn(taskkill…) + sleep(1500)` 既没确认
   * 进程死了、也没确认锁释放了 —— 进程还活着的时候 MSBuild 照样 MSB3021（昨夜两次构建
   * 失败并归因错误「参数没生效」，真因是门控 + 没等退出）。
   *
   * 实例定位规则（`DSH_BUILD_CLIENT_EXE` / `DSH_UI_CLIENT_EXE` 指定期望的 exe 全路径）：
   *   1) 配了 exe 路径 → 只杀**路径一致**的实例（多实例场景下这是唯一安全的做法）；
   *   2) 没配路径但**只有 1 个**同名实例 → 杀它（无歧义）；
   *   3) 没配路径且有 **≥2 个**实例 → **拒绝强杀**，如实回报实例清单，请调用方指定 exe 或手工处理
   *      （宁可构建失败，也不误杀别人的客户端 —— 红线优先）。
   * 退出判据只轮询**本次真正杀掉的 PID**，不再用「同名进程列表为空」当判据
   * （否则别的实例还在时会把「已成功」误报成失败）。
   * 上限 `DSH_BUILD_KILL_WAIT_MS`（默认 15000ms），超时如实回报 remaining。
   */
  async function killClientProcess(client) {
    const startedAt = Date.now()
    const name = (client && client.name) || ''
    const wanted = String(envOr('DSH_BUILD_CLIENT_EXE') || envOr('DSH_UI_CLIENT_EXE')).trim()
    const instances = clientInstances(name)
    let targets = []
    let scope = ''
    if (instances.length === 0) {
      return { killed: false, nothingToKill: true, name, pids: [], remaining: [], waitedMs: 0, instances: [], scope: 'none' }
    }
    if (wanted) {
      const w = wanted.toLowerCase()
      targets = instances.filter((i) => i.path && i.path.toLowerCase() === w)
      scope = 'exe-path'
      if (targets.length === 0) {
        return {
          killed: false, refused: true, scope, name, wanted, instances,
          pids: [], remaining: instances.map((i) => i.pid), waitedMs: Date.now() - startedAt,
          error: '没有实例的可执行路径等于 DSH_BUILD_CLIENT_EXE（' + wanted + '）；已拒绝强杀，避免误杀其他会话的同名进程。候选：' +
            instances.map((i) => i.pid + '=' + (i.path || '(路径未知)')).join('、'),
        }
      }
    } else if (instances.length === 1) {
      targets = instances
      scope = 'single-instance'
    } else {
      return {
        killed: false, refused: true, scope: 'ambiguous', name, instances,
        pids: [], remaining: instances.map((i) => i.pid), waitedMs: Date.now() - startedAt,
        error: '发现 ' + instances.length + ' 个同名实例（' + instances.map((i) => i.pid + '=' + (i.path || '(路径未知)')).join('、') +
          '）且未配置 DSH_BUILD_CLIENT_EXE，无法唯一定位目标实例：已拒绝强杀（避免误杀其他会话）。' +
          '请设置 DSH_BUILD_CLIENT_EXE 指向目标 exe，或先手工关闭目标客户端。',
      }
    }

    const pids = targets.map((t) => t.pid)
    for (const pid of pids) {
      try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
    }
    const waitMs = Number(process.env.DSH_BUILD_KILL_WAIT_MS || 15000)
    const deadline = Date.now() + waitMs
    // F-028：等待"我们的进程"消失，而不是"这个号"消失（pid 复用会让后者永远为真）
    let remaining = pids.filter((p) => isTargetAlive(p, name))
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      remaining = pids.filter((p) => isTargetAlive(p, name))
    }
    // 把"这个号现在被谁占着"一并带出去：`killed:false` 时否则无法区分
    // 「进程赖着不走」与「pid 被复用」—— 前者要重试，后者其实已经成功了。
    //
    // ★ F-038（2026-09-12 r34，@claude 独立复核查出，**症状是"把做成的事说成没做成"**）：
    //   上面那个循环的最后一次 `isTargetAlive()` 与这里 `pidOwner()` 的**第二次**测量之间存在时间差。
    //   旧实现只处理了 `owner !== null` 那一支（pid 被**别人**占用 ⇒ `pidReused`），
    //   **"这个号彻底没了"（owner === null）那一支没被处理** —— 于是它仍留在 `remaining` 里：
    //     返回值一边说 `killed:false` + note「等待 Nms 后目标进程仍在」，
    //     一边在自己的 `remainingDetail` 里写「该 pid 当前不存在」 —— **同一份返回值自相矛盾**。
    //   @claude 抓到的实据（负载下的真机原文）：
    //     {"killed":false,"remaining":[33108],
    //      "remainingDetail":[{"pid":33108,"owner":null,"note":"该 pid 当前不存在（判活与判占用之间发生了变化）"}],
    //      "waitedMs":20416,"note":"等待 10000ms 后目标进程仍在（见 remainingDetail）。"}
    //   这不只是文案问题：**负载下它会把"已经停掉的客户端"报成"没停掉"**，
    //   与 `build_run(killClient=true)` 的调用方判断直接冲突（会谎报"文件锁仍在"）。
    //
    //   修法（关键点：**判定必须从同一份证据里推导出来**，这样二者不可能再互相矛盾）：
    //     · `owner === null`（号没了）⇒ **不算 remaining**（不是"赖着不走"，是"已经走了"）；
    //     · `owner !== null` 但不是我们的进程 ⇒ **不算 remaining**（原 `pidReused` 逻辑，保留）；
    //     · 只有"既存在、又还是我们的进程"才算 remaining。
    //   `killed` 一律由 `remainingDetail` 推导，**不再用更早那次判活的快照**。
    //   残余 TOCTOU 如实声明：`pidReused` 那一步仍会再判一次活，极端窗口下仍有抖动 ——
    //   但现在**报出来的判决与报出来的证据一定一致**，不会出现上面那种自相矛盾。
    const remainingDetail = remaining.map((p) => {
      const owner = pidOwner(p)
      return owner === null
        ? { pid: p, owner: null, note: '该 pid 当前不存在（判活与判占用之间发生了变化）—— 视为已结束' }
        : { pid: p, owner: owner.image, note: 'pid 仍被占用，占用者镜像=' + owner.image }
    })
    // ★ 判决走**纯函数**（同上 F-038）：判决与它引用的明细由同一份输入推出，不可能互相矛盾。
    const outcome = killOutcome({
      detail: remainingDetail,
      isReused: (pid) => !isTargetAlive(pid, name),
      waitMs,
    })
    return {
      killed: outcome.killed, name, scope, pids, instances,
      remaining: outcome.remaining, remainingDetail,
      pidReused: outcome.pidReused, goneWhileChecking: outcome.goneWhileChecking,
      waitedMs: Date.now() - startedAt,
      ...(outcome.note ? { note: outcome.note } : {}),
    }
  }

  /** 从 MSB3021/3027 报文里挖出被锁文件（报文形如：无法将文件"源"复制到"目标"。…）。 */
  function lockedFilesOf(errs) {
    const out = []
    for (const e of errs) {
      const quoted = String(e.message || '').match(/"([^"]+)"/g) || []
      for (const q of quoted) {
        const f = q.slice(1, -1)
        if (f && !out.includes(f)) out.push(f)
      }
    }
    return out.slice(0, 4)
  }

  // ------------------------------------------------------------ 错误解析

  // Code prefixes can be long (CS/MSB/NU/NETSDK/…) — NETSDK1004 needs 6 letters.
  // The code group is optional: NuGet compat notices print code-less
  // "file(line,col): warning : message". Code-less ERROR prose is dropped in
  // the loop — MSBuild's own summary does not count it (count parity).
  const ERR_LINE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(?:([A-Z]{1,7}\d+):)?\s*(.*)$/
  // Top-level MSBuild errors carry no (line,col): "MSBUILD : error MSB1009: …"
  // or "MSBUILD : 错误 MSB1009: …". Dropping them produced ok:false with
  // errors:[] — the structured list disagreed with the summary line.
  const ERR_TOP = /^MSBUILD\s*:\s*(?:error|错误)\s+([A-Z]{1,7}\d+):\s*(.*)$/
  // dotnet/NuGet form without position: "Foo.csproj : error NU1301: …".
  const ERR_PLAIN = /^(.*?)\s*:\s*(?:error|错误)\s+([A-Z]{1,7}\d+):\s*(.*)$/
  // SDK-resolution chains embed the code mid-message: "Foo.csproj : error : MSB4276: …".
  // Pure-prose chain lines without an embedded code are NOT separate errors
  // (MSBuild's own summary does not count them) — skipping them keeps the
  // parsed count in parity with the summary line.
  const ERR_EMBED = /^(.*?)\s*:\s*(?:error|错误)\s*:\s*(.*)$/

  /** 环境性错误（文件锁/目标占用/SDK 解析/NuGet 源不可达等），不是代码错误。 */
  function isEnvError(e) {
    const p = (e.file || '').toLowerCase()
    return p.includes('microsoft.common.currentversion.targets') ||
      /MSB302[0-9]|MSB4018|MSB4023|MSB4236|MSB4276|NETSDK1004|NETSDK1045|NU1301/.test(e.code || '')
  }

  function parseErrors(text) {
    const errors = []
    const warnings = []
    // MSBuild prints each error twice (inline + the trailing summary block);
    // dedupe on (file,line,col,code) so errorCount matches the summary line
    // instead of being 2x the truth.
    const seenErr = new Set()
    const seenWarn = new Set()
    const dedupeKey = (e) => `${e.file}|${e.line}|${e.col}|${e.code}`
    const pushErr = (entry) => {
      const k = dedupeKey(entry)
      if (seenErr.has(k)) return
      seenErr.add(k)
      errors.push(entry)
    }
    const pushWarn = (entry) => {
      const k = dedupeKey(entry)
      if (seenWarn.has(k)) return
      seenWarn.add(k)
      warnings.push(entry)
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(ERR_LINE)
      if (m) {
        const kind = m[4]
        const code = m[5] || ''
        const message = (m[6] || '').replace(/^:\s*/, '').trim()
        // Code-less positioned ERROR prose is part of SDK-resolution chains;
        // MSBuild's summary does not count it, so skipping keeps errorCount
        // in parity with the summary line.
        if (kind === 'error' && !code) continue
        const entry = { file: m[1].trim(), line: Number(m[2]), col: Number(m[3]), code: code || '(none)', message }
        if (kind === 'error') pushErr(entry)
        else pushWarn(entry)
        continue
      }
      const t = line.match(ERR_TOP)
      if (t) {
        pushErr({ file: '(top-level)', line: 0, col: 0, code: t[1], message: t[2].trim() })
        continue
      }
      const p = line.match(ERR_PLAIN)
      if (p) {
        pushErr({ file: p[1].trim() || '(top-level)', line: 0, col: 0, code: p[2], message: p[3].trim() })
        continue
      }
      const e2 = line.match(ERR_EMBED)
      if (e2) {
        // "file : error : MSB4276: …" — the code is embedded in the message.
        const cm = e2[2].match(/\b([A-Z]{1,7}\d{4,5})\b/)
        if (cm) pushErr({ file: e2[1].trim() || '(top-level)', line: 0, col: 0, code: cm[1], message: e2[2].trim() })
        continue
      }
    }
    return { errors, warnings }
  }

  // ------------------------------------------------------------ 构建执行

  /**
   * 运行一次构建。
   * @param {object} opts {target:'Build'|'Rebuild', project, configuration, platform, engine, repoRoot}
   *  msbuild 引擎无 project 时自动探测默认解决方案（WholeSolution.sln 保持旧布局）；
   *  platform 缺省时按布局规则解析（legacy x86 / 从 .sln 探测 / 省略）。
   */
  async function build(opts = {}) {
    const target = opts.target === 'Rebuild' ? 'Rebuild' : 'Build'
    const configuration = opts.configuration || 'Debug'
    const engine = opts.engine || c.engine || 'msbuild'
    const isDotnet = engine === 'dotnet'
    const project = opts.project || ''

    // UD-02（Codex 第四轮指出我的第一版不完整）：runId 要在**所有**返回路径上都存在，
    // 包括"还没跑到 MSBuild 就早返回"的那些（最常见的是没传 repoRoot）。
    // 否则调用方拿着一次失败去 verify_report 时既没有 runId、也找不到任何记录，
    // 只能得到含糊的 unverified —— 而事实是"这次构建压根没跑"，那是个**确定**的结论。
    // 所以：runId 在这里就先算好，早返回也**落一条 per-run 记录**（ok:false），
    // 让 verify_report(kind=build) 能给出 fail（有证据的否定）而不是 unverified（没证据）。
    const suppliedRunId = String(opts.runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60)
    const runId = suppliedRunId || ('auto-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
    const runIdAuto = suppliedRunId === ''
    // 日志目录不存在会让**全部构建证据**（last.json / run-<id>.json / 日志文件）静默写失败，
    // 而 verify_report 只看到"找不到记录"——又是一次"证据缺失但没有信号"。
    // 所以在任何写入之前先把目录建好（mkdir -p 语义）。
    try { mkdirSync(c.logsDir, { recursive: true }) } catch { /* 建不了就让后续写入如实报错 */ }
    const earlyFail = (error, extra = {}) => {
      const r = failResult(error, { runId, runIdAutoGenerated: runIdAuto, target, configuration, ...extra })
      // BV-05（2026-09-11 审计确证）：早返回过去**不写 last.json**（persistLast 只在成功路径调用），
      // 于是被挡下的那次构建之后，`build_status` 报的还是**上一次成功** ——
      // 又是一个"陈旧数据被当成当前状态"，而且这次是 agent 自己刚触发的失败被藏起来了。
      // 现在：失败也写 last.json，让 build_status 如实显示"最近一次尝试"的结果。
      persistLast(r)
      try {
        writeFileSync(join(c.logsDir, 'run-' + runId + '.json'), JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2), 'utf8')
      } catch (e) {
        r.evidenceWriteError = 'per-run 构建记录写入失败：' + (e && e.message ? e.message : String(e))
      }
      return r
    }

    // Repository root: explicit param > DSH_BUILD_REPO_ROOT > client root
    // (DSH_BUILD_CLIENT_ROOT). Fail closed when unset — never build some
    // accidental cwd.
    // R42：opts.clientRoot 之前**不被读取** —— 参数声明了、build() 却只认 opts.repoRoot，
  // 那样加参数等于加了个幽灵。两者语义相同（谁给用谁），顺序：本次调用 > 环境/配置。
  const repoRoot = opts.repoRoot || opts.clientRoot || c.repoRoot || c.clientRoot
    if (!repoRoot || !existsSync(repoRoot)) {
      return earlyFail('仓库根目录不存在：' + (repoRoot || '(未配置)') + '（传 repoRoot 或设置 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT）')
    }

    // Target: an explicit project/sln wins. Without one, both engines
    // auto-detect the default solution (see lib/build-resolve.mjs):
    // WholeSolution.sln keeps the legacy client layout, stock repos get
    // root-then-one-level-deep detection, ambiguity is an explicit error.
    // Only exception: the dotnet engine on a repo with no solution at all
    // falls back to its cwd default (`dotnet build` in the repo root), which
    // keeps single-root-project repos working as before.
    let targetArg = ''
    let targetDisplay = ''
    if (project) {
      const p = resolveTargetPath(repoRoot, project)
      if (!existsSync(p)) return earlyFail('构建目标不存在：' + p)
      if (!isSolutionPath(p) && !isProjectPath(p)) {
        return earlyFail('project 必须是 .sln/.slnx/.csproj/.vbproj/.fsproj：' + project)
      }
      targetArg = p
      targetDisplay = project
    } else {
      const found = findDefaultSolution(repoRoot)
      if (found.kind === 'found') {
        targetArg = found.path
        targetDisplay = found.display
      } else if (!isDotnet || found.kind === 'multiple') {
        return earlyFail(found.error + '（project 可定向 .sln/.csproj，repoRoot 指向仓库根）')
      }
    }

    // Platform: explicit param > DSH_BUILD_PLATFORM > layout rules.
    // WholeSolution.sln and legacy repos keep x86; other solutions get the
    // platform detected from the .sln (null = omit the arg and let MSBuild
    // use the solution's own default). The dotnet engine never passes
    // /p:Platform (SDK default Any CPU).
    let platformArg = opts.platform || process.env.DSH_BUILD_PLATFORM || null
    if (isDotnet) platformArg = null
    else if (!platformArg) {
      if (targetArg && isSolutionPath(targetArg)) platformArg = defaultPlatformFor(targetArg)
      else if (isLegacyLayout(repoRoot)) platformArg = 'x86'
    }

    const msbuild = isDotnet ? 'dotnet' : findMsbuild()
    if (!msbuild) return earlyFail('未找到 MSBuild（可用 DSH_BUILD_MSBUILD 指定）')
    if (isDotnet) {
      // Verify the dotnet executable is resolvable via PATH.
      try {
        execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true })
      } catch {
        return earlyFail('dotnet 引擎需要 PATH 上有 dotnet SDK（或设置 DOTNET_ROOT）')
      }
    }

    // 前置检查：客户端运行会锁它自己的输出目录（MSB3021/3027 文件锁风暴）。
    // 但锁只发生在「构建目标就是客户端本体」时——把 guard 做成全局的会让任何
    // 无关仓库的构建在客户端开着时全部失败（外部智能体复核指出的问题）。
    // 判定：目标程序集名 == 客户端进程名（例如 MyClient.csproj vs MyClient.exe）。
    const client = clientProcess()
    let clientRunningWarning = null
    let clientKill = null
    // BV-04（2026-09-11，Codex 独立只读复核确认）：`clientProcess()` 是三态，旧代码只读 client.running，
    // 于是「**进程名没配置**」被压成「running:false」= 「客户端没在跑」：
    //   · killClient=true → 静默跳过 killClientProcess() → 继续构建（调用方以为锁已经解除，
    //     实际锁还在，最后以 MSB3021/3027 的形式爆出来），并被归因成「参数没生效 / 客户端未运行」；
    //   · 非 killClient 路径同样不提示，诊断把它引向"去启动客户端"这个完全错误的方向。
    // 红线：宁可这次构建明确失败并说清怎么配，也不要一个"我以为锁没了"的构建。
    const clientUnconfigured = client.unconfigured === true
    let clientUnconfiguredNote = null
    const clientCfgHint = '客户端进程名未配置（DSH_BUILD_CLIENT_PROC 与 DSH_UI_PROC_NAME 都没设），无法探测客户端是否在运行'
    if (clientUnconfigured && opts.killClient) {
      return earlyFail(clientCfgHint + '，所以 killClient=true **无法生效** —— 这不是「客户端未运行」，是「根本没配」。' +
        '请设 DSH_BUILD_CLIENT_PROC=<进程名>（或 DSH_UI_PROC_NAME）后重试，或先手工关闭目标客户端再构建。', {
        clientUnconfigured: true,
        clientKillRequested: true,
        clientKillSkipped: true,
        hint: 'killClient=true 被拒绝执行：没有进程名就无法判断"要杀谁"，也无从确认"是否还需要杀"。',
      })
    }
    if (clientUnconfigured) {
      // 非 killClient 路径：不阻断（无从判断是否真的在跑），但必须**明说这是"未知"而不是"没在跑"**。
      // 用独立的 clientUnconfiguredNote 而不是复用 clientRunningWarning：后者是"确实在跑但与目标无关"，
      // 两者语义不同，挤在同一个字段里会让渲染层只能挑一种说法。
      clientUnconfiguredNote = clientCfgHint + '，本次构建按「未知」继续；若出现 MSB3021/3027 文件锁，先配好进程名再传 killClient=true。'
    }
    const targetAssembly = targetArg ? basename(targetArg).replace(/\.(cs|vb|fs)proj$/i, '').replace(/\.(sln|slnx)$/i, '') : ''
    const clientName = client.name ? client.name.toLowerCase() : ''
    const touchesClientOutput = clientName !== '' && targetAssembly !== '' && targetAssembly.toLowerCase() === clientName
    if (client.running && !opts.killClient && touchesClientOutput) {
      return {
        ok: false,
        error: '客户端正在运行（PID ' + client.pid + '），构建目标 ' + (targetDisplay || targetArg) + ' 就是客户端本体，输出文件会被锁定导致 MSB3021/3027 错误。请先关闭客户端，或传 killClient=true 让我强制结束它（会打断用户正在使用的界面，需先确认）。',
        clientRunning: true,
        clientPid: client.pid,
      }
    }
    if (client.running && opts.killClient) {
      // B-3：killClient=true 的语义就是「先结束目标客户端再构建」，**无条件生效**。
      // 旧实现把它门控在 touchesClientOutput（目标程序集名 == 客户端进程名）之下，
      // 于是最需要它的场景反而没杀：锁的是**共享依赖 DLL**（构建目标是 .sln 或别的工程）
      // 时门控为假 → 不 kill → 构建继续 MSB3021，调用方还以为是「参数没生效」。
      clientKill = await killClientProcess(client)
      if (clientKill.refused) {
        // 无法唯一定位目标实例（多实例且没配 DSH_BUILD_CLIENT_EXE）→ **fail closed**：
        // 宁可这次构建失败并说清怎么修，也不误杀别人的客户端（红线优先）。
        return {
          ok: false,
          error: clientKill.error,
          clientRunning: true,
          clientPid: client.pid,
          clientKill,
          refused: true,
        }
      }
    }
    if (client.running && !opts.killClient && !touchesClientOutput) {
      // 无关目标：只提示，不阻断（客户端仍可能锁住共享依赖的 copy 目标，
      // 真出问题会以 MSB3021 的形式出现在结构化错误里）
      clientRunningWarning = '客户端正在运行（PID ' + client.pid + '），但构建目标 ' + (targetDisplay || targetArg) + ' 与客户端本体无关，已继续构建。'
    }

    // dotnet engine: dotnet build <target> -c <cfg> --nologo -v minimal
    // (restores by default, no /p:Platform). msbuild engine: full legacy
    // switch set with the resolved target; /p:Platform only when a platform
    // was resolved (legacy x86 or detected from the solution). /restore is
    // required: MSBuild.exe does not restore implicitly (unlike dotnet
    // build), and SDK-style projects fail with NETSDK1004 without it; it is
    // a no-op for legacy packages.config projects (no Restore target).
    const args = isDotnet
      ? ['build', ...(targetArg ? [targetArg] : []), '--configuration', configuration, '--nologo', '--verbosity', 'minimal', ...(target === 'Rebuild' ? ['--no-incremental'] : []), '/nodeReuse:false', '/clp:Summary', '-p:NuGetAudit=false']
      : [targetArg, '/t:' + target, '/p:Configuration=' + configuration, ...(platformArg ? ['/p:Platform=' + platformArg] : []), '/m', '/v:m', '/nologo', '/restore', '/nodeReuse:false', '/clp:Summary']
    const timeoutMs = target === 'Rebuild' ? c.rebuildTimeoutMs : c.incrementalTimeoutMs
    const startedAt = Date.now()
    // Evidence-pack spine: runId 已在函数开头算好（见上面 earlyFail 的说明），
    // 这里只用它命名日志与 per-run 记录。

    const run = await new Promise((resolve) => {
      let child
      try {
        child = spawn(msbuild, args, { cwd: repoRoot, windowsHide: true })
      } catch (e) {
        resolve({ spawnError: String(e), code: -1, chunks: [] })
        return
      }
      const chunks = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
        resolve({ timedOut: true, code: null, chunks })
      }, timeoutMs)
      child.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
      child.stderr.on('data', (d) => chunks.push(Buffer.from(d)))
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ spawnError: String(e), code: -1, chunks })
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, chunks })
      })
    })

    const buf = Buffer.concat(run.chunks || [])
    const { text, enc } = decodeBuffer(buf)
    const { errors, warnings } = parseErrors(text)
    const envErrors = errors.filter(isEnvError)
    const codeErrors = errors.filter((e) => !isEnvError(e))
    const durationMs = Date.now() - startedAt
    mkdirSync(c.logsDir, { recursive: true })
    const ts = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = ts.getFullYear() + p(ts.getMonth() + 1) + p(ts.getDate()) + '-' + p(ts.getHours()) + p(ts.getMinutes()) + p(ts.getSeconds())
    const logName = runId ? `build-${runId}-${stamp}-${target.toLowerCase()}.log` : `build-${stamp}-${target.toLowerCase()}.log`
    const logPath = join(c.logsDir, logName)
    writeFileSync(logPath, text, 'utf8')

    // B-3：文件锁错误的归因要「指名道姓」。MSB3021/3027 的报文只说被锁的文件，
    // 不说占用者是谁——这里补上最关键的一条事实：目标客户端现在还在不在跑。
    const lockErrors = envErrors.filter((e) => /MSB302[0-9]/.test(e.code || ''))
    let lockDiagnosis = null
    if (run.code !== 0 && lockErrors.length > 0) {
      const codes = [...new Set(lockErrors.map((e) => e.code))]
      const files = lockedFilesOf(lockErrors)
      const clientAfter = clientProcess()
      lockDiagnosis = {
        codes,
        lockedFiles: files,
        clientRunning: !!clientAfter.running,
        clientPid: clientAfter.running ? clientAfter.pid : null,
        killedBeforeBuild: !!(clientKill && clientKill.killed),
        hint: clientAfter.running
          ? ('检测到文件锁（' + codes.join('/') + '），且客户端 ' + clientAfter.name + ' 仍在运行（PID ' + clientAfter.pid + '）' +
             (files.length ? '；被锁文件：' + files.join('、') : '') + '。传 killClient=true 可先结束它再构建。')
          : ('检测到文件锁（' + codes.join('/') + '），但目标客户端进程当前未运行：占用者可能是别的进程（另一个会话的同类进程 / 杀软 / 资源管理器预览）' +
             (files.length ? '；被锁文件：' + files.join('、') : '') + '。'),
      }
    }

    const result = {
      ok: run.code === 0,
      exitCode: run.code,
      timedOut: !!run.timedOut,
      spawnError: run.spawnError || null,
      engine,
      target,
      repoRoot,
      project: targetDisplay || '(default)',
      configuration,
      platform: platformArg || (isDotnet ? 'Any CPU' : '(auto)'),
      durationMs,
      runId,
      // UD-02：让调用方一眼看出这个 runId 是自动生成的（否则它会以为是自己传的）。
      runIdAutoGenerated: runIdAuto,
      errorCount: errors.length,
      codeErrorCount: codeErrors.length,
      envErrorCount: envErrors.length,
      warningCount: warnings.length,
      errors: codeErrors.slice(0, 40),
      envErrors: envErrors.slice(0, 8),
      warnings: warnings.slice(0, 20),
      truncated: errors.length > 40 || warnings.length > 20,
      clientWasKilled: !!(clientKill && clientKill.killed),
      ...(clientKill ? { clientKill } : {}),
      ...(clientKill && !clientKill.killed && !clientKill.nothingToKill
        ? { clientKillFailed: true, error: 'killClient=true 但目标客户端进程仍未退出（PID ' + clientKill.remaining.join(',') + '，等待 ' + clientKill.waitedMs + 'ms）：文件锁大概率仍在，构建会继续报 MSB3021/3027。' }
        : {}),
      ...(clientRunningWarning ? { clientRunningWarning } : {}),
      // BV-04：三态中的第三态必须随结果一起回报 —— 只印在 warning 文本里，
      // 读 JSON 的调用方（MCP/脚本）仍然分不出「没配」和「没在跑」。
      ...(clientUnconfigured ? { clientUnconfigured: true } : {}),
      ...(clientUnconfiguredNote ? { clientUnconfiguredNote } : {}),
      ...(lockDiagnosis ? { lockDiagnosis } : {}),
      // A failed build with zero code errors is a blocked-by-environment
      // situation (missing targeting packs, restore failures, locked
      // outputs). Surface it loudly instead of leaving the agent with
      // ok:false and "no errors to fix".
      blockedByEnvironment: run.code !== 0 && codeErrors.length === 0 && envErrors.length > 0,
      ...(run.code !== 0 && codeErrors.length === 0 && envErrors.length > 0
        ? { error: '构建失败但没有代码错误（环境性问题）：' + envErrors.slice(0, 3).map((e) => e.code + ': ' + String(e.message).slice(0, 100)).join(' | ') }
        : {}),
      // A non-zero exit with NOTHING parsed is the dangerous shape: the agent
      // reads "0 error(s)" and concludes the build passed. Surface it as an
      // explicit failure and hand over the log tail so the cause is visible.
      ...(run.code !== 0 && errors.length === 0 && envErrors.length === 0
        ? {
            error: '构建以非零退出码结束但未解析到任何错误（可能是 SDK/工具链/环境问题，不是代码错误）；日志尾部：' + text.split(/\r?\n/).filter((l) => l.trim()).slice(-4).join(' / ').slice(0, 400),
            summaryLineOverride: 'BUILD FAILED (exit ' + run.code + '), no parsed errors — see log tail',
          }
        : {}),
      logPath,
      encoding: enc,
      summaryLine: (run.code !== 0 && errors.length === 0 && envErrors.length === 0)
        ? ('BUILD FAILED (exit ' + run.code + '), no parsed errors — see log tail')
        : (extractSummary(text) ?? `${errors.length} error(s), ${warnings.length} warning(s) (parsed)`),
    }
    persistLast(result)
    // UD-02：runId 现在总是有值（缺省自动生成），所以 per-run 记录**总是**会写 ——
    // 证据永远存在可被 verify_report(kind=build) 串联，不再取决于 agent 记不记得传参。
    // 写失败也不能静默：那是"证据缺失"的另一种来源，必须让调用方看见。
    try {
      writeFileSync(join(c.logsDir, 'run-' + runId + '.json'), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2), 'utf8')
    } catch (e) {
      result.evidenceWriteError = 'per-run 构建记录写入失败（verify_report 将找不到本次证据）：' + (e && e.message ? e.message : String(e))
    }
    return result
  }

  function extractSummary(text) {
    const en = text.match(/(\d+)\s+Error\(s\)\s*\r?\n?\s*(\d+)\s+Warning\(s\)/i)
    if (en) return en[1] + ' error(s), ' + en[2] + ' warning(s)'
    const zhErr = text.match(/(\d+)\s+个错误/)
    const zhWarn = text.match(/(\d+)\s+个警告/)
    if (zhErr || zhWarn) return (zhErr ? zhErr[1] : '0') + ' error(s), ' + (zhWarn ? zhWarn[1] : '0') + ' warning(s)'
    return null
  }

  // ------------------------------------------------------------ 后台构建（W4：不阻塞）
  //
  // 病：`build()` 是**同步阻塞** 8~15 分钟（Rebuild 更久），一次 build_run 期间整个 agent 卡死，
  // 既不能观察客户端、也不能干别的。抄 Codex `exec_command` 的 yield-or-handle 形状：
  // background=true 时立刻返回 jobId + 标记文件，真正的 build() 交给一个**分离子进程**去跑，
  // 用 build_status 轮询（state=running/done/crashed）。**构建逻辑一行未改** —— 后台只是薄壳。
  //
  // 诚实三态（沿用本仓风格）：子进程写不出结果又已退出 ⇒ crashed（未完成），绝不当成"通过"。
  const BG_RUNNER = join(BUILD_LIB_DIR, 'build-bg-runner.mjs')
  function bgMarkerPath(jobId) { return join(c.logsDir, 'bg-' + jobId + '.json') }

  /** 启动一次后台构建，立即返回（不阻塞）。opts 与 build() 同形。 */
  function startBackground(opts = {}) {
    try { mkdirSync(c.logsDir, { recursive: true }) } catch { /* 建不了让下面写标记时如实报错 */ }
    const suppliedRunId = String(opts.runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60)
    const jobId = suppliedRunId || ('auto-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
    const target = opts.target === 'Rebuild' ? 'Rebuild' : 'Build'
    const markerPath = bgMarkerPath(jobId)
    // 显式列出转发给子进程的构建入参（**不**把整包 opts 原样落进标记文件）：标记文件会被读日志的人看到，
    // 逐字段列出既避免把无关字段写进去，也让"每个参数都有归宿"这件事对参数级守卫可见。
    // runId 钉成 jobId：子进程 build() 会写 run-<jobId>.json，证据脊柱与前台一致。
    const buildOpts = {
      target,
      project: opts.project,
      configuration: opts.configuration,
      platform: opts.platform,
      engine: opts.engine,
      repoRoot: opts.repoRoot,
      clientRoot: opts.clientRoot,
      killClient: opts.killClient,
      runId: jobId,
    }
    const marker = { jobId, state: 'running', startedAt: new Date().toISOString(), pid: null, target, buildOpts, cfg: c }
    try {
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')
    } catch (e) {
      return failResult('无法写后台构建标记文件：' + (e && e.message ? e.message : String(e)), { runId: jobId, target, background: true })
    }
    let child
    try {
      // 分离子进程 + unref：父进程（宿主）不等它、也不持有它，MCP 调用立即返回。
      child = spawn(process.execPath, [BG_RUNNER, markerPath], { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (e) {
      return failResult('无法启动后台构建进程：' + (e && e.message ? e.message : String(e)), { runId: jobId, target, background: true })
    }
    child.unref()
    return {
      ok: true, background: true, state: 'running', jobId, runId: jobId, target,
      marker: markerPath,
      // 给出与 failResult 同形的"安全空壳"：任何读 errors.length 的渲染器都不会因缺字段而崩。
      errors: [], warnings: [], envErrors: [], errorCount: 0, warningCount: 0, envErrorCount: 0, truncated: false,
      hint: '后台构建已启动（不阻塞）。用 build_status 轮询：state=running→done/crashed；'
        + 'done 后结果照常写进 last.json 与 run-' + jobId + '.json（verify_report(kind=build) 可直接用这个 runId）。',
    }
  }

  /** 最近一次后台构建任务的状态（没有则 null）。crashed = 进程没了但没写出结果。 */
  function backgroundStatus() {
    let files
    try { files = readdirSync(c.logsDir).filter((f) => /^bg-.*\.json$/.test(f)) } catch { return null }
    if (!files || files.length === 0) return null
    let newest = null
    let newestMs = -1
    for (const f of files) {
      try { const st = statSync(join(c.logsDir, f)); if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = f } } catch { /* ignore */ }
    }
    if (!newest) return null
    const markerPath = join(c.logsDir, newest)
    let m
    try { m = JSON.parse(readFileSync(markerPath, 'utf8')) } catch {
      return { jobId: newest.replace(/^bg-|\.json$/g, ''), state: 'unreadable', marker: markerPath, note: '后台标记文件读不出（可能正在写）—— 稍后再查。' }
    }
    const startedMs = m.startedAt ? Date.parse(m.startedAt) : NaN
    const elapsedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null
    let state = m.state || 'running'
    let pidAlive = null
    if (state === 'running' && m.pid) {
      pidAlive = isPidAlive(m.pid)
      if (!pidAlive) state = 'crashed' // 子进程没了却没写出 done/failed ⇒ 崩了（未完成）
    }
    const r = m.result || null
    return {
      jobId: m.jobId, state, marker: markerPath,
      startedAt: m.startedAt || null, finishedAt: m.finishedAt || null,
      elapsedMs, pid: m.pid ?? null, pidAlive,
      ...(r ? { ok: r.ok, errorCount: r.errorCount, codeErrorCount: r.codeErrorCount, logPath: r.logPath, runId: r.runId } : {}),
      ...(m.error ? { error: m.error } : {}),
      ...(state === 'crashed'
        ? { note: '后台构建进程已不在，但没有写出结果 —— 视为**崩溃/未完成**，不要当成"通过"。用 build_run 重跑（可去掉 background 看同步报错）。' }
        : {}),
    }
  }

  function lastPath() { return join(c.logsDir, 'last.json') }

  function persistLast(result) {
    try { writeFileSync(lastPath(), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2), 'utf8') } catch { /* ignore */ }
  }

  function status() {
    // W4：轮询后台构建也走 build_status —— 有在跑/刚跑完的后台任务时把它一并带出（附加字段，不改既有字段）。
    const bg = backgroundStatus()
    try {
      const r = JSON.parse(readFileSync(lastPath(), 'utf8'))
      // F-007：宿主不热加载 —— 每次读"最近一次构建"都顺带说清"这份结论是不是用旧代码读的"。
      return { hasRun: true, ...r, ...(staleCodeInfo(moduleRoots(BUILD_PLUGIN_DIR)) || {}), ...(bg ? { backgroundJob: bg } : {}) }
    } catch {
      return { hasRun: false, ...(staleCodeInfo(moduleRoots(BUILD_PLUGIN_DIR)) || {}), ...(bg ? { backgroundJob: bg } : {}) }
    }
  }

  /**
   * 从**最近一次**构建日志重新解析错误/警告。
   *
   * BV-05/BV-04 连带暴露的一处（2026-09-11，被 `lib/mcp-newtools.test.mjs` 抓到）：
   * 早返回的 `last.json` 里 `logPath` 是 **null**（那次构建压根没跑），而这里直接
   * `readFileSync(s.logPath, …)` → `TypeError: path must be of type string...` →
   * 宿主把 build_errors 变成裸异常。**偏偏是在最需要日志的那一刻**（构建被挡下），
   * agent 拿到的是宿主崩溃而不是"没有日志，因为这次没跑"。
   */
  function errorsOfLast() {
    const s = status()
    if (!s.hasRun) return { hasRun: false }
    if (typeof s.logPath !== 'string' || s.logPath === '') {
      return {
        hasRun: true,
        logPath: null,
        errors: [],
        warnings: [],
        didNotRun: s.didNotRun === true,
        note: s.didNotRun === true
          ? '最近一次构建**没有执行**（' + (s.error || '原因未回报') + '），所以没有任何构建日志可解析 —— 这不等于"0 个错误"。'
          : '最近一次记录里没有日志路径（可能是老版本记录），无法解析历史错误。',
      }
    }
    let text = ''
    try {
      text = readFileSync(s.logPath, 'utf8')
    } catch (e) {
      return {
        hasRun: true,
        logPath: s.logPath,
        errors: [],
        warnings: [],
        readError: '日志文件读不到：' + (e && e.message ? e.message : String(e)),
        note: '日志路径存在但读不到（可能被轮转/删除）—— 不要把它读成"0 个错误"。',
      }
    }
    const { errors, warnings } = parseErrors(text)
    return { hasRun: true, logPath: s.logPath, errors, warnings }
  }

  return { config: c, build, startBackground, backgroundStatus, status, errorsOfLast, parseErrors, isEnvError, findMsbuild, decodeBuffer, clientProcess, clientInstances, isPidAlive, exePathOf, killClientProcess, listClientPids, lockedFilesOf, logsDir: () => c.logsDir }
}
