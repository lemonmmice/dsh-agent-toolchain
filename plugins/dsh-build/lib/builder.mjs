/**
 * dsh-build builder — MSBuild 进程封装 + 错误结构化解析。
 * 不依赖 DSH API，可独立单测。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { decodeBuffer } from '../../../lib/decode.mjs'
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

export function makeBuilder(cfg) {
  const c = {
    clientRoot: process.env.DSH_BUILD_CLIENT_ROOT || '',
    repoRoot: process.env.DSH_BUILD_REPO_ROOT || '',
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
  if (!c.clientRoot) c.clientRoot = process.env.DSH_BUILD_CLIENT_ROOT || ''
  if (!c.repoRoot) c.repoRoot = process.env.DSH_BUILD_REPO_ROOT || ''

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
    const proc = process.env.DSH_BUILD_CLIENT_PROC || process.env.DSH_UI_PROC_NAME || ''
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
    const wanted = String(process.env.DSH_BUILD_CLIENT_EXE || process.env.DSH_UI_CLIENT_EXE || '').trim()
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
    let remaining = pids.filter((p) => isPidAlive(p))
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      remaining = pids.filter((p) => isPidAlive(p))
    }
    return { killed: remaining.length === 0, name, scope, pids, instances, remaining, waitedMs: Date.now() - startedAt }
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

    // Repository root: explicit param > DSH_BUILD_REPO_ROOT > client root
    // (DSH_BUILD_CLIENT_ROOT). Fail closed when unset — never build some
    // accidental cwd.
    const repoRoot = opts.repoRoot || c.repoRoot || c.clientRoot
    if (!repoRoot || !existsSync(repoRoot)) {
      return { ok: false, error: '仓库根目录不存在：' + (repoRoot || '(未配置)') + '（传 repoRoot 或设置 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT）' }
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
      if (!existsSync(p)) return { ok: false, error: '构建目标不存在：' + p }
      if (!isSolutionPath(p) && !isProjectPath(p)) {
        return { ok: false, error: 'project 必须是 .sln/.slnx/.csproj/.vbproj/.fsproj：' + project }
      }
      targetArg = p
      targetDisplay = project
    } else {
      const found = findDefaultSolution(repoRoot)
      if (found.kind === 'found') {
        targetArg = found.path
        targetDisplay = found.display
      } else if (!isDotnet || found.kind === 'multiple') {
        return { ok: false, error: found.error + '（project 可定向 .sln/.csproj，repoRoot 指向仓库根）' }
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
    if (!msbuild) return { ok: false, error: '未找到 MSBuild（可用 DSH_BUILD_MSBUILD 指定）' }
    if (isDotnet) {
      // Verify the dotnet executable is resolvable via PATH.
      try {
        execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true })
      } catch {
        return { ok: false, error: 'dotnet 引擎需要 PATH 上有 dotnet SDK（或设置 DOTNET_ROOT）' }
      }
    }

    // 前置检查：客户端运行会锁它自己的输出目录（MSB3021/3027 文件锁风暴）。
    // 但锁只发生在「构建目标就是客户端本体」时——把 guard 做成全局的会让任何
    // 无关仓库的构建在客户端开着时全部失败（外部智能体复核指出的问题）。
    // 判定：目标程序集名 == 客户端进程名（例如 MyClient.csproj vs MyClient.exe）。
    const client = clientProcess()
    let clientRunningWarning = null
    let clientKill = null
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
    // Evidence-pack spine: an optional runId names the log and the per-run record.
    const runId = String(opts.runId ?? '').replace(/[^\w.-]+/g, '_').slice(0, 60)

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
      runId: runId || null,
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
    if (runId) {
      // Per-run record: the evidence pack's build leg, looked up by verify_report kind=build.
      try { writeFileSync(join(c.logsDir, 'run-' + runId + '.json'), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2), 'utf8') } catch { /* ignore */ }
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

  function lastPath() { return join(c.logsDir, 'last.json') }

  function persistLast(result) {
    try { writeFileSync(lastPath(), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2), 'utf8') } catch { /* ignore */ }
  }

  function status() {
    try {
      const r = JSON.parse(readFileSync(lastPath(), 'utf8'))
      return { hasRun: true, ...r }
    } catch {
      return { hasRun: false }
    }
  }

  function errorsOfLast() {
    const s = status()
    if (!s.hasRun) return { hasRun: false }
    const text = readFileSync(s.logPath, 'utf8')
    const { errors, warnings } = parseErrors(text)
    return { hasRun: true, logPath: s.logPath, errors, warnings }
  }

  return { config: c, build, status, errorsOfLast, parseErrors, isEnvError, findMsbuild, decodeBuffer, clientProcess, clientInstances, isPidAlive, exePathOf, killClientProcess, listClientPids, lockedFilesOf, logsDir: () => c.logsDir }
}
