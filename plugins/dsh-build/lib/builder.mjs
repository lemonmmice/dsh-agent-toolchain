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

  function clientProcess() {
    const proc = process.env.DSH_BUILD_CLIENT_PROC || process.env.DSH_UI_PROC_NAME || ''
    if (!proc) return { running: false, pid: null, unconfigured: true }
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + proc + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      const m = out.match(new RegExp('"' + proc + '\\.exe","(\\d+)"'))
      if (m) return { running: true, pid: Number(m[1]) }
    } catch { /* ignore */ }
    return { running: false, pid: null }
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

    // Target: an explicit project/sln wins. Without one, the msbuild engine
    // auto-detects the default solution (see lib/build-resolve.mjs):
    // WholeSolution.sln keeps the legacy client layout, stock repos get
    // root-then-one-level-deep detection, ambiguity is an explicit error.
    // The dotnet engine keeps its cwd default when no project is given.
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
    } else if (!isDotnet) {
      const found = findDefaultSolution(repoRoot)
      if (found.kind !== 'found') return { ok: false, error: found.error + '（project 可定向 .sln/.csproj，repoRoot 指向仓库根）' }
      targetArg = found.path
      targetDisplay = found.display
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

    // 前置检查：客户端运行会锁 Product\Bin 的 dll（MSB3021/3027 文件锁风暴）
    const client = clientProcess()
    if (client.running && !opts.killClient) {
      return {
        ok: false,
        error: '客户端正在运行（PID ' + client.pid + '），输出文件会被锁定导致 MSB3021/3027 错误。请先关闭客户端，或传 killClient=true 让我强制结束它（会打断用户正在使用的界面，需先确认）。',
        clientRunning: true,
        clientPid: client.pid,
      }
    }
    if (client.running && opts.killClient) {
      try { spawn('taskkill', ['/PID', String(client.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500))
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
      clientWasKilled: !!(client.running && opts.killClient),
      // A failed build with zero code errors is a blocked-by-environment
      // situation (missing targeting packs, restore failures, locked
      // outputs). Surface it loudly instead of leaving the agent with
      // ok:false and "no errors to fix".
      blockedByEnvironment: run.code !== 0 && codeErrors.length === 0 && envErrors.length > 0,
      ...(run.code !== 0 && codeErrors.length === 0 && envErrors.length > 0
        ? { error: '构建失败但没有代码错误（环境性问题）：' + envErrors.slice(0, 3).map((e) => e.code + ': ' + String(e.message).slice(0, 100)).join(' | ') }
        : {}),
      logPath,
      encoding: enc,
      summaryLine: extractSummary(text) ?? `${errors.length} error(s), ${warnings.length} warning(s) (parsed)`,
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

  return { config: c, build, status, errorsOfLast, parseErrors, isEnvError, findMsbuild, decodeBuffer, logsDir: () => c.logsDir }
}
