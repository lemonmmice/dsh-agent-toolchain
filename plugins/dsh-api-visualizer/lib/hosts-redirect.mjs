/**
 * 透明拦截的 hosts 侧：把一组域名指向本机回环地址，由代理引擎在那里做反向代理（Fiddler 文档里的
 * 「Reverse Proxy + HOSTS」模式）。
 *
 * 为什么需要它：有的客户端在代码里强制直连（`request.Proxy = null` / `WebRequest.DefaultWebProxy = null`），
 * 系统代理、代理设置统统不看 ⇒ 本地代理根本收不到它的请求，mock 规则也就打不到。
 * 但它**一定会做 DNS 解析**，而 Windows 的解析先查 hosts —— 这是不改客户端代码、不装驱动就能把流量
 * 引到本机的那条路。
 *
 * 安全边界（每一条都对应一个"把用户机器改坏"的失败模式）：
 *   · 只动 hosts 里**自己那一段**（BLOCK_BEGIN … BLOCK_END），别人的条目原样保留：**按字节**读写
 *     （ReadAllBytes + Latin-1 解码 / Latin-1 编码 + WriteAllBytes），任何地方都不做 BOM 探测 ——
 *     带 UTF-8 BOM、含中文注释的 hosts 改一轮再还原，字节完全一致。
 *     段落的匹配规则 JS 与 PowerShell 共用同一个正则（BLOCK_SRC）；只有开始标记、没有结束标记的残缺段落
 *     **一律不碰**（猜不出它到哪结束，猜错就会删掉用户的行），报错让人手工处理。
 *   · 写 hosts 的逻辑只有**一份**（PowerShell 脚本）：宿主已提权就直接跑，未提权就经 UAC 提权跑同一份。
 *     脚本本体（纯 ASCII，所有动态值都以 base64 传入，不拼进 PowerShell 源码）写到临时文件，
 *     命令行里只有一个很小的引导脚本：读文件字节 → 校验 SHA-256 → 一致才执行（不一致 exit 97）。
 *     直接运行与 UAC 提权用的是**同一个**引导命令 ⇒ UAC 批准的命令钉死了实际执行的脚本内容；
 *     命令行长度也不再随域名数增长（以前双重 base64 内嵌，64 个长域名会超 32K 上限）。
 *   · 安全网：启用时同时注册一个 SYSTEM 计划任务（开机时 + 每 5 分钟），**监听器不在**（连续两次、间隔 20 秒
 *     的**身份探测**都没认出本插件的监听）就把这一段删掉并注销自己 ⇒ 重启电脑 / 宿主挂掉不再启动时，
 *     客户端最多受影响几分钟，不会一直连不上。探测认身份而不是只看端口通不通（别的程序在同一端口上
 *     监听 0.0.0.0 也能连通）：https = 完成 TLS 握手且证书颁发者是本插件根证书；http = 应答头带
 *     PROBE_HEADER: 1。任何一步出错（读不了 / 写不了 / 写完读回来段落还在）都**保留任务**，5 分钟后重试；
 *     读失败时绝不写（以前读失败会把 hosts 截成 0 字节）。
 *   · 注册安全网时成功的前提是**能查到**任务确实注册了、动作恰好是这份安全网脚本（不信同用户可改的结果文件：
 *     宿主已提权就自己查；未提权时 SYSTEM 任务对它不可见，只信提权子进程的退出码）；查不到 / 查不清就把段落撤回去
 *     （rolledBack），除非调用方明确 allowWithoutSafetyNet。
 *   · 安全网的决策日志（ASCII、有上限）只写在 hosts 所在目录（见 safetyLogPathFor）：SYSTEM 绝不写用户可写的目录。
 *   · hosts 段落存在 ⇔ 拦截生效；宿主重启时按段落恢复监听（见 ProxyEngine.recoverRedirect）——
 *     段落里的 `# apv-entry <spec>` 行记着每个域名原本的端口写法（tcp:// / 非默认端口），恢复时照着还原。
 */
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { decodeConsole } from '../../../lib/env-fallback.mjs'

export const BLOCK_BEGIN = '# >>> dsh-api-visualizer intercept begin'
export const BLOCK_END = '# <<< dsh-api-visualizer intercept end'
export const SAFETY_TASK = 'dsh-api-visualizer intercept safety net'
/**
 * 单次最多重定向的域名数。命令行长度已经和名单无关（脚本走临时文件），这里只是合理性上限：
 * 再多说明筛选没做好，而且段落越长、hosts 越难人工检查。
 */
export const MAX_HOSTS = 64
/** 安全网 https 探测用的 SNI（.invalid 不可能是真实域名；监听端据此把探测与真实客户端区分开）。 */
export const PROBE_SNI = 'apv-safety-probe.invalid'
/** 安全网 http 探测请求的路径。 */
export const PROBE_PATH = '/__apv_safety_probe'
/** 本插件监听对 PROBE_PATH 的应答必须带这个头，值为 '1'（http 探测据此认出"是我们的监听"）。 */
export const PROBE_HEADER = 'x-apv-intercept'
/** 本插件根证书的 CN（https 探测要求监听出示的证书由它颁发）。 */
export const CA_ISSUER_CN = 'dsh-api-visualizer Local CA'

const SPEC_LINE_PREFIX = '# apv-entry '
/** 一条 spec = 不含空白的可打印 ASCII（例：`https://h:8443`、`tcp://h:9000`、`h`）。 */
const SPEC_RE = /^[\x21-\x7e]{1,300}$/
const MAX_SPECS = MAX_HOSTS * 4
/** 引导脚本的退出码（读不到临时脚本 / 校验不通过）。 */
const EXIT_SCRIPT_UNREADABLE = 96
const EXIT_SCRIPT_TAMPERED = 97
const EXIT_APPROVED_TOO_LATE = 98
/** 脚本已走到安全网那一步时的退出码（见 applyScript）。 */
const EXIT_TASK_ROLLED_BACK = 20
const EXIT_TASK_ROLLBACK_FAILED = 21
const EXIT_TASK_KEPT_UNVERIFIED = 22
const EXIT_UNREGISTER_FAILED = 23
const EXIT_UAC_CANCELED = 1223
const EXIT_UAC_FAILED = 1225

export function defaultHostsPath() {
  const root = process.env.SystemRoot || process.env.windir || ((process.env.SystemDrive || 'C:') + '\\Windows')
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

/** 读 hosts 文本（Latin-1：字节一一对应，不做 BOM 探测，别人写的非 ASCII 注释不会被改坏）。 */
export function readHostsText(hostsPath = defaultHostsPath()) {
  try {
    return { ok: true, text: fs.readFileSync(hostsPath).toString('latin1') }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, text: '', missing: true }
    return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- 段落匹配（JS 与 PowerShell/.NET 共用同一份正则源码，两边语义一致）----
// 不用 ^/$ + 多行模式：JS 的多行模式把单独的 \r 也当行尾，.NET 只认 \n ⇒ 用 (?<![^\n]) 表示"行首"。
const LINE_START = '(?<![^\\n])'
const BEGIN_LINE_SRC = LINE_START + '[ \\t]*' + escapeRe(BLOCK_BEGIN)
const END_LINE_SRC = LINE_START + '[ \\t]*' + escapeRe(BLOCK_END)
/** 一整段：开始行 … 结束行（含结束行的换行）。中间不许再出现开始行 ⇒ 残缺的旧开始标记不会把用户的行一起吞掉。 */
const BLOCK_SRC = BEGIN_LINE_SRC + '(?:(?!' + BEGIN_LINE_SRC + ')[\\s\\S])*?' + END_LINE_SRC + '[^\\n]*\\n?'
const BEGIN_LINE_RE = new RegExp(BEGIN_LINE_SRC)
const BEGIN_AT_LINE_RE = new RegExp('^[ \\t]*' + escapeRe(BLOCK_BEGIN))
const END_AT_LINE_RE = new RegExp('^[ \\t]*' + escapeRe(BLOCK_END))

/** 去掉本插件的段落（纯函数，供校验与测试；真正写盘走 PowerShell 那一份，用的是同一个正则）。 */
export function stripBlock(text) {
  return String(text ?? '').replace(new RegExp(BLOCK_SRC, 'g'), '')
}

/**
 * 解析出本插件那一段：{ found, ip, entries:[{ip,host}], specs:string[], dangling }。
 * specs 来自段落里的 `# apv-entry <spec>` 行；dangling = 有开始标记却配不上结束标记（残缺段落，不能自动改）。
 */
export function parseBlock(text) {
  const s = String(text ?? '')
  const lines = s.split(/\r?\n/)
  let inBlock = false
  let found = false
  const entries = []
  const specs = []
  for (const raw of lines) {
    if (BEGIN_AT_LINE_RE.test(raw)) { inBlock = true; found = true; continue }
    if (END_AT_LINE_RE.test(raw)) { inBlock = false; continue }
    if (!inBlock) continue
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      const m = /^#[ \t]*apv-entry[ \t]+(\S+)[ \t]*$/.exec(line)
      if (m !== null && SPEC_RE.test(m[1]) && !specs.includes(m[1])) specs.push(m[1])
      continue
    }
    const parts = line.split(/\s+/)
    const ip = parts[0]
    for (const name of parts.slice(1)) {
      if (name.startsWith('#')) break
      entries.push({ ip, host: name.toLowerCase() })
    }
  }
  const dangling = found && BEGIN_LINE_RE.test(stripBlock(s))
  return { found, ip: entries.length > 0 ? entries[0].ip : null, entries, specs, dangling }
}

/**
 * hosts 里**本插件段落之外**、映射了 names 中任一域名（不分大小写）的条目：[{ host, line, ip, text }]。
 * line 是从 1 开始的行号，text 是该行原文（截断到 200 字符）。Windows 按 hosts 里的第一条生效 ⇒
 * 这样的条目会让本插件的段落对该域名无效（或者把它指向别处），调用方应拒绝拦截该域名并据此解释原因。
 */
export function hostsConflicts(text, names) {
  const want = new Set((Array.isArray(names) ? names : [names]).map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean))
  const out = []
  if (want.size === 0) return out
  const lines = String(text ?? '').split(/\r?\n/)
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (BEGIN_AT_LINE_RE.test(raw)) { inBlock = true; continue }
    if (END_AT_LINE_RE.test(raw)) { inBlock = false; continue }
    if (inBlock) continue
    const hash = raw.indexOf('#')
    const content = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
    if (content === '') continue
    const parts = content.split(/\s+/)
    if (parts.length < 2 || net.isIP(parts[0]) === 0) continue // 第一列不是 IP 的行 Windows 也不认
    for (const name of parts.slice(1)) {
      const h = name.toLowerCase()
      if (want.has(h)) out.push({ host: h, line: i + 1, ip: parts[0], text: raw.trim().slice(0, 200) })
    }
  }
  return out
}

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/** 域名是否可以被重定向（IP、localhost、单段名都不行：hosts 只对"要解析的名字"生效）。 */
export function validRedirectHost(host) {
  const h = String(host ?? '').trim().toLowerCase()
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return false
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return false
  return HOST_RE.test(h)
}

/** 段落里的地址只能是回环 IPv4（拦截监听只开在 127.x 上；安全网也只探测它）。 */
function validBlockIp(ip) {
  return typeof ip === 'string' && net.isIPv4(ip) && ip.startsWith('127.')
}

function normalizeHosts(hosts) {
  if (!Array.isArray(hosts)) throw new Error('hosts 必须是域名数组')
  const out = []
  for (const h of hosts) {
    const x = String(h ?? '').trim().toLowerCase()
    if (!validRedirectHost(x)) throw new Error(`不是可重定向的域名: ${String(h).slice(0, 80)}`)
    if (!out.includes(x)) out.push(x)
  }
  return out
}

function normalizeSpecs(specs) {
  if (specs === undefined || specs === null) return []
  if (!Array.isArray(specs)) throw new Error('specs 必须是字符串数组')
  const out = []
  for (const s of specs) {
    const x = String(s ?? '').trim()
    if (!SPEC_RE.test(x)) throw new Error(`段落里的条目写法只能是不含空白的 ASCII（≤300 字符）: ${JSON.stringify(String(s)).slice(0, 80)}`)
    if (!out.includes(x)) out.push(x)
  }
  if (out.length > MAX_SPECS) throw new Error(`条目写法太多（${out.length} > ${MAX_SPECS}）`)
  return out
}

function normalizeProbe(probe, probePort) {
  let port
  let mode
  if (probe !== undefined && probe !== null) {
    if (typeof probe !== 'object') throw new Error('probe 必须是 { port, mode }')
    port = Number(probe.port)
    mode = probe.mode === undefined || probe.mode === null ? 'https' : String(probe.mode)
  } else {
    port = probePort === undefined || probePort === null ? 443 : Number(probePort) // 兼容旧参数 probePort（按 https）
    mode = 'https'
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`安全网探测端口无效: ${probe?.port ?? probePort}`)
  if (mode !== 'https' && mode !== 'http') throw new Error(`安全网探测方式只能是 https / http: ${mode}`)
  return { port, mode }
}

/**
 * 生成要写入的那一段（纯 ASCII，含说明注释与 `# apv-entry <spec>` 行）。
 * 输入不合法直接抛错 —— 这段文字最终进系统 hosts，绝不能让换行/空白混进去拼出额外的条目。
 */
export function buildBlock({ ip, hosts = [], specs = [], eol = '\r\n' } = {}) {
  if (eol !== '\r\n' && eol !== '\n') throw new Error('eol 只能是 \\r\\n 或 \\n')
  const list = normalizeHosts(hosts)
  if (list.length > 0 && !validBlockIp(ip)) throw new Error(`段落地址必须是回环 IPv4（127.x.x.x）: ${String(ip).slice(0, 40)}`)
  const specList = normalizeSpecs(specs)
  const lines = [
    BLOCK_BEGIN + ' (auto-generated by the capture panel; removed on stop, on reboot, or when its listener is gone)',
    '# to undo by hand: delete every line from the begin marker to the end marker, then run ipconfig /flushdns',
    ...specList.map((s) => SPEC_LINE_PREFIX + s),
    ...list.map((h) => `${ip} ${h}`),
    BLOCK_END,
  ]
  return lines.join(eol) + eol
}

/** 当前进程能否直接写 hosts（已提权 / 用户自己放宽过 ACL）。 */
export function canWriteDirect(hostsPath = defaultHostsPath()) {
  try {
    const fd = fs.openSync(hostsPath, 'r+')
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

/** 文件带「只读」属性（Windows 上 fs.access(W_OK) 只看这个属性，不看 ACL）。不存在 = false。 */
function hasReadOnlyAttribute(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK)
    return false
  } catch (e) {
    return Boolean(e && (e.code === 'EPERM' || e.code === 'EACCES'))
  }
}

// ---- PowerShell 生成：所有动态值经 base64 传入；数字只接受校验过的整数 ----
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64')
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const PS_HEAD = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'function D([string]$s) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }',
]
const psStr = (s) => `(D '${b64(s)}')`
function psB64Literal(s) {
  if (typeof s !== 'string' || !B64_RE.test(s)) throw new Error('内部错误：不是 base64')
  return `'${s}'`
}
function psInt(n) {
  if (!Number.isInteger(n)) throw new Error('内部错误：不是整数')
  return String(n)
}
function asciiBytes(script) {
  if (!/^[\x00-\x7f]*$/.test(script)) throw new Error('内部错误：生成的 PowerShell 脚本含非 ASCII 字符')
  return Buffer.from(script, 'ascii')
}
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex').toUpperCase()

function psExe() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(p)) return p
  }
  return 'powershell.exe'
}
const PS_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/**
 * 安全网脚本（以 SYSTEM 身份由计划任务执行；导出仅供自测直接运行）。
 * 流程：读 hosts（读不了 ⇒ 不写、保留任务）→ 没有段落 ⇒ 注销自己 → 身份探测两次（间隔 20 秒），任一次认出
 * 本插件的监听 ⇒ 什么都不做 → 写之前**重新读一遍** → 删段落写回 → 再读一遍确认开始标记没了 →
 * 才刷 DNS、注销任务。任何一步失败都保留任务（5 分钟后重试）。开机时宿主还没起来 ⇒ 必然删除 ⇒ "重启电脑即还原"。
 * 退出码：0 = 已处理（段落不在 / 监听在 / 已删除）；10 读失败；11 残缺段落；12 写失败；13 写后校验失败；14 删完但注销失败。
 * @param {object} o
 * @param {string} o.hostsPath
 * @param {string} o.probeIp      段落指向的回环地址（探测目标）
 * @param {{port:number, mode:'https'|'http'}} [o.probe]  探测端口与方式（兼容旧参数 probePort = https）
 * @param {string} [o.taskName]   要注销的任务名（默认 SAFETY_TASK；自测传假名）
 * @param {string} [o.logPath]    决策日志（ASCII、追加、超过 256KB 轮转一次）；空 = 不记
 */
export function safetyScript({ hostsPath, probeIp, probe, probePort, taskName = SAFETY_TASK, logPath = '' } = {}) {
  const pr = normalizeProbe(probe, probePort)
  if (typeof hostsPath !== 'string' || hostsPath === '') throw new Error('hostsPath 不能为空')
  if (!validBlockIp(probeIp)) throw new Error(`探测地址必须是回环 IPv4: ${String(probeIp).slice(0, 40)}`)
  return [
    ...PS_HEAD,
    `$hostsPath = ${psStr(hostsPath)}`,
    `$task = ${psStr(taskName)}`,
    `$logPath = ${psStr(logPath ?? '')}`,
    `$probeIp = ${psStr(probeIp)}`,
    `$probePort = ${psInt(pr.port)}`,
    `$probeMode = ${psStr(pr.mode)}`,
    `$sni = ${psStr(PROBE_SNI)}`,
    `$probePath = ${psStr(PROBE_PATH)}`,
    `$probeHeader = ${psStr(PROBE_HEADER)}`,
    `$caRdn = ${psStr('CN=' + CA_ISSUER_CN)}`,
    `$blockPattern = ${psStr(BLOCK_SRC)}`,
    `$beginPattern = ${psStr(BEGIN_LINE_SRC)}`,
    '$latin1 = [Text.Encoding]::GetEncoding(28591)',
    'function Write-Log([string]$m) {',
    "  if ($logPath -eq '') { return }",
    '  try {',
    '    if ([IO.File]::Exists($logPath) -and (New-Object IO.FileInfo($logPath)).Length -gt 262144) {',
    "      $old = $logPath + '.1'",
    '      if ([IO.File]::Exists($old)) { [IO.File]::Delete($old) }',
    '      [IO.File]::Move($logPath, $old)',
    '    }',
    "    $m = $m -replace '[\\r\\n]+', ' '",
    "    [IO.File]::AppendAllText($logPath, ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + \"`r`n\"), [Text.Encoding]::ASCII)",
    '  } catch {}',
    '}',
    "function Err-Text($e) { return ('0x{0:X8} {1}' -f $e.Exception.HResult, $e.Exception.Message) }",
    'function Read-Hosts { return $latin1.GetString([IO.File]::ReadAllBytes($hostsPath)) }',
    'function Test-Begin([string]$t) { return [regex]::IsMatch($t, $beginPattern) }',
    'function Remove-Task {',
    '  try {',
    "    try { $null = Get-ScheduledTask -TaskPath '\\' -TaskName $task -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return 'absent' }; throw }",
    "    Unregister-ScheduledTask -TaskPath '\\' -TaskName $task -Confirm:$false -ErrorAction Stop",
    "    return 'unregistered'",
    "  } catch { return ('failed: ' + (Err-Text $_)) }",
    '}',
    // https：真握手（SNI = PROBE_SNI，任何证书都接受），只有证书颁发者的 CN 恰好是本插件根证书才算"是我们"
    'function Test-Https {',
    '  $c = $null; $ssl = $null',
    '  try {',
    '    $c = New-Object Net.Sockets.TcpClient',
    '    $ar = $c.BeginConnect($probeIp, $probePort, $null, $null)',
    '    if (-not $ar.AsyncWaitHandle.WaitOne(2000, $false)) { return $false }',
    '    $c.EndConnect($ar)',
    '    $c.ReceiveTimeout = 3000; $c.SendTimeout = 3000',
    "    $st = @{ issuer = '' }",
    '    $cb = [Net.Security.RemoteCertificateValidationCallback]{ param($snd, $cert, $chain, $errs) if ($null -ne $cert) { $st.issuer = [string]$cert.Issuer }; return $true }',
    '    $ssl = New-Object Net.Security.SslStream($c.GetStream(), $false, $cb)',
    "    $ssl.AuthenticateAsClient($sni, $null, [Security.Authentication.SslProtocols]'Tls12, Tls11, Tls', $false)",
    '    $iss = [string]$st.issuer',
    "    if ($iss -eq '' -and $null -ne $ssl.RemoteCertificate) { $iss = [string]$ssl.RemoteCertificate.Issuer }",
    "    foreach ($part in ($iss -split ',')) { if ($part.Trim() -ceq $caRdn) { return $true } }",
    '    return $false',
    '  } catch { return $false } finally {',
    '    if ($null -ne $ssl) { try { $ssl.Dispose() } catch {} }',
    '    if ($null -ne $c) { try { $c.Close() } catch {} }',
    '  }',
    '}',
    // http：GET PROBE_PATH，只有应答头里有 PROBE_HEADER: 1 才算"是我们"
    'function Test-Http {',
    '  $c = $null',
    '  try {',
    '    $c = New-Object Net.Sockets.TcpClient',
    '    $ar = $c.BeginConnect($probeIp, $probePort, $null, $null)',
    '    if (-not $ar.AsyncWaitHandle.WaitOne(2000, $false)) { return $false }',
    '    $c.EndConnect($ar)',
    '    $c.ReceiveTimeout = 3000; $c.SendTimeout = 3000',
    '    $ns = $c.GetStream()',
    "    $q = [Text.Encoding]::ASCII.GetBytes('GET ' + $probePath + \" HTTP/1.1`r`nHost: \" + $sni + \"`r`nConnection: close`r`n`r`n\")",
    '    $ns.Write($q, 0, $q.Length)',
    '    $ms = New-Object IO.MemoryStream',
    '    $buf = New-Object byte[] 4096',
    "    $head = ''",
    '    while ($ms.Length -lt 16384) {',
    '      $n = $ns.Read($buf, 0, $buf.Length)',
    '      if ($n -le 0) { break }',
    '      $ms.Write($buf, 0, $n)',
    '      $head = $latin1.GetString($ms.ToArray())',
    '      if ($head.Contains("`r`n`r`n")) { break }',
    '    }',
    '    $e = $head.IndexOf("`r`n`r`n", [StringComparison]::Ordinal)',
    '    if ($e -lt 0) { return $false }',
    '    $lines = $head.Substring(0, $e) -split "`r`n"',
    "    if (-not ($lines[0] -match '^HTTP/1\\.[01] [0-9]{3}')) { return $false }",
    '    for ($i = 1; $i -lt $lines.Length; $i++) {',
    "      $k = $lines[$i].IndexOf(':')",
    '      if ($k -le 0) { continue }',
    "      if ($lines[$i].Substring(0, $k).Trim() -eq $probeHeader -and $lines[$i].Substring($k + 1).Trim() -ceq '1') { return $true }",
    '    }',
    '    return $false',
    '  } catch { return $false } finally { if ($null -ne $c) { try { $c.Close() } catch {} } }',
    '}',
    "function Test-Alive { if ($probeMode -eq 'http') { return (Test-Http) }; return (Test-Https) }",
    '$text = $null',
    'try {',
    "  if (-not [IO.File]::Exists($hostsPath)) { Write-Log 'keep: hosts file not found'; exit 0 }",
    '  $text = Read-Hosts',
    "} catch { Write-Log ('keep: read failed: ' + (Err-Text $_)); exit 10 }",
    "if (-not (Test-Begin $text)) { $u = Remove-Task; Write-Log ('absent: no block in hosts; task ' + $u); exit 0 }",
    "if (Test-Alive) { Write-Log ('alive: ' + $probeMode + ' probe 1 answered by our listener'); exit 0 }",
    'Start-Sleep -Seconds 20',
    "if (Test-Alive) { Write-Log ('alive: ' + $probeMode + ' probe 2 answered by our listener'); exit 0 }",
    "try { $text = Read-Hosts } catch { Write-Log ('keep: re-read failed: ' + (Err-Text $_)); exit 10 }",
    "if (-not (Test-Begin $text)) { $u = Remove-Task; Write-Log ('absent: block already removed; task ' + $u); exit 0 }",
    "$new = [regex]::Replace($text, $blockPattern, '')",
    "if (Test-Begin $new) { Write-Log 'keep: begin marker without end marker, not touching hosts'; exit 11 }",
    "try { [IO.File]::WriteAllBytes($hostsPath, $latin1.GetBytes($new)) } catch { Write-Log ('keep: write failed: ' + (Err-Text $_)); exit 12 }",
    '$chk = $null',
    "try { $chk = Read-Hosts } catch { Write-Log ('keep: verify read failed: ' + (Err-Text $_)); exit 13 }",
    "if (Test-Begin $chk) { Write-Log 'keep: block still present after write'; exit 13 }",
    "$fl = 'ok'",
    "try { $null = & (Join-Path $env:SystemRoot 'System32\\ipconfig.exe') /flushdns; if ($LASTEXITCODE -ne 0) { $fl = 'failed' } } catch { $fl = 'failed' }",
    '$u = Remove-Task',
    "Write-Log ('removed: listener gone, block removed; flushdns ' + $fl + '; task ' + $u)",
    "if ($u -like 'failed*') { exit 14 }",
    'exit 0',
  ].join('\r\n')
}

const SAFETY_LOG_NAME = 'dsh-api-visualizer-safety-net.log'

/**
 * 真实安全网任务的决策日志位置：**与 hosts 同一目录**（系统 hosts 时是 drivers\etc：只有管理员 / SYSTEM 能写、
 * 普通用户可读，宿主不提权也能读出来给界面看）。
 * 为什么不用调用方给的任意路径：任务以 SYSTEM 身份追加、轮转（Move / Delete）这个文件 —— 路径若在用户可写的目录里，
 * 低权限进程把目录换成 junction / 符号链接，就能借 SYSTEM 之手写入或删除任意文件（提权）。
 * 调用方的 logPath 只有落在 hosts 所在目录里才采用，否则用这里的默认位置。
 */
export function safetyLogPathFor(hostsPath = defaultHostsPath(), logPath = '') {
  const dir = path.dirname(path.resolve(String(hostsPath)))
  if (typeof logPath === 'string' && logPath !== '') {
    const want = path.resolve(logPath)
    if (path.dirname(want).toLowerCase() === dir.toLowerCase()) return want
  }
  return path.join(dir, SAFETY_LOG_NAME)
}

/** 计划任务动作的参数（安全网脚本以 -EncodedCommand 内嵌；长度与域名数无关）。 */
function safetyTaskSpec({ hostsPath, probeIp, probe, taskName, logPath }) {
  const encoded = encodePs(safetyScript({ hostsPath, probeIp, probe, taskName, logPath }))
  return { encoded, argument: '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + encoded }
}

/**
 * 写 hosts 的**唯一实现**：去掉旧段落 → 追加新段落（block 为空即只删除）→ 读回校验 →（注销）安全网 → 刷 DNS。
 * register 模式顺序相反：先注册 + 查证安全网，**通过之后才写段落**（宿主中途被杀也不会留下没有安全网的段落）；
 * 查不到任务（或动作不是这份安全网脚本、任务被禁用）且 rollback ⇒ 不写新段落，并在同一个（可能是提权的）进程里撤掉本插件已有的段落。
 * 结果写成一行 JSON 到 resultFile（提权运行时拿不到 stdout，只能这样回传）。结果文件在用户临时目录里、同用户进程可改，
 * 所以**只用于提示文字**；决策靠读回的 hosts、宿主自己的任务查询，以及**退出码**（提权子进程的退出码经 Start-Process
 * 原样转交，外人改不了）——宿主未提权时看不到 SYSTEM 任务，安全网是否注册成功只能信这个退出码。
 * 退出码：0 完成（register 时 = 任务已注册且本进程查证过）；2 写失败；3 读失败；4 残缺段落；5 无权限（直接模式下据此改走 UAC）；
 * 6 只读属性；7 写后读回不一致；20 任务没查证通过、段落已撤回；21 同左但撤回失败（段落还在）；22 任务没查证通过、按要求保留段落；
 * 23 注销任务失败（hosts 已按要求处理）。
 */
function applyScript({ hostsPath, block, resultFile, safetyNet, taskName, safetyEncoded, rollback }) {
  // 写段落 + 读回校验（三种模式共用；register 模式放到安全网注册并查证之后）
  const writeStep = [
    'if ($new -cne $text) {',
    "  if ($exists -and (([IO.File]::GetAttributes($hostsPath) -band [IO.FileAttributes]::ReadOnly) -ne 0)) { Fail 6 'read-only-attribute' }",
    "  try { Write-Hosts $new } catch [UnauthorizedAccessException] { Fail 5 ('access-denied: ' + $_.Exception.Message) } catch { Fail 2 ('hosts-write-failed: ' + $_.Exception.Message) }",
    "  $r.hosts = 'written'",
    "  $chk = ''",
    "  try { $chk = Read-Hosts } catch { Fail 7 ('hosts-verify-failed: ' + $_.Exception.Message) }",
    "  if ($chk -cne $new) { Fail 7 'hosts-verify-failed: content differs after write' }",
    '}',
  ]
  const lines = [
    ...PS_HEAD,
    `$hostsPath = ${psStr(hostsPath)}`,
    `$block = ${psStr(block)}`,
    `$resultFile = ${psStr(resultFile)}`,
    `$task = ${psStr(taskName)}`,
    `$mode = ${psStr(safetyNet)}`,
    `$rollback = ${rollback ? '$true' : '$false'}`,
    `$blockPattern = ${psStr(BLOCK_SRC)}`,
    `$beginPattern = ${psStr(BEGIN_LINE_SRC)}`,
    '$latin1 = [Text.Encoding]::GetEncoding(28591)',
    "$r = @{ hosts = 'unchanged'; task = 'skipped'; taskVerified = $false; flush = 'skipped'; error = '' }",
    '$code = 0',
    'function Save-Result { try { [IO.File]::WriteAllText($resultFile, (ConvertTo-Json -InputObject $r -Compress), (New-Object Text.UTF8Encoding($false))) } catch {} }',
    'function Fail([int]$code, [string]$msg) { $r.error = $msg; Save-Result; exit $code }',
    'function Read-Hosts { return $latin1.GetString([IO.File]::ReadAllBytes($hostsPath)) }',
    'function Write-Hosts([string]$t) { [IO.File]::WriteAllBytes($hostsPath, $latin1.GetBytes($t)) }',
    "$text = ''",
    '$exists = $false',
    "try { $exists = [IO.File]::Exists($hostsPath); if ($exists) { $text = Read-Hosts } } catch { Fail 3 ('hosts-read-failed: ' + $_.Exception.Message) }",
    "$new = [regex]::Replace($text, $blockPattern, '')",
    "if ([regex]::IsMatch($new, $beginPattern)) { Fail 4 'dangling-begin-marker' }",
    '$eol = "`r`n"',
    'if (-not $text.Contains("`r`n") -and $text.Contains("`n")) { $eol = "`n" }',
    "if ($block -ne '') {",
    '  if ($new.Length -gt 0 -and -not $new.EndsWith("`n", [StringComparison]::Ordinal)) { $new += $eol }',
    '  $new += ($block -replace "`r?`n", $eol)',
    '}',
    ...(safetyNet === 'register' ? [] : writeStep), // register：安全网查证通过之后才写（见下）
    'function Get-Task {',
    "  try { return (Get-ScheduledTask -TaskPath '\\' -TaskName $task -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }; throw }",
    '}',
  ]
  if (safetyNet === 'register') {
    // 先注册、查证安全网，再写段落：宿主在这中间被杀（Ctrl+C、崩溃、重启任务）时，最坏也只是留下一个没有段落的任务
    // （它下次运行发现没有段落就注销自己），绝不会留下一个没有安全网的段落。
    // 写之前先做不改动任何东西的检查：只读属性 ⇒ 6；没权限 ⇒ 5（直接模式据此改走 UAC，与以前先写后注册时一致）。
    lines.push(
      'if ($new -cne $text -and $exists) {',
      "  if ((([IO.File]::GetAttributes($hostsPath) -band [IO.FileAttributes]::ReadOnly) -ne 0)) { Fail 6 'read-only-attribute' }",
      "  try { $fs = [IO.File]::Open($hostsPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite); $fs.Dispose() } catch [UnauthorizedAccessException] { Fail 5 ('access-denied: ' + $_.Exception.Message) } catch {}",
      '}',
    )
    lines.push(
      `$safetyB64 = ${psB64Literal(safetyEncoded)}`,
      "$taskArg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $safetyB64",
      'try {',
      "  $exe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '  $action = New-ScheduledTaskAction -Execute $exe -Argument $taskArg',
      '  $t1 = New-ScheduledTaskTrigger -AtStartup',
      '  $t2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Minutes 5)',
      "  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
      '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew',
      "  Register-ScheduledTask -TaskName $task -TaskPath '\\' -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings -Force | Out-Null",
      "  $r.task = 'registered'",
      "} catch { $r.task = 'failed: ' + $_.Exception.Message }",
      // 查证：任务在，且动作里的 -EncodedCommand 恰好是这份安全网脚本（旧任务 / 别的同名任务都不算）
      'try {',
      '  $t = Get-Task',
      '  if ($null -ne $t) {',
      '    $a = @($t.Actions)',
      "    $m = [regex]::Match([string]$a[0].Arguments, '-EncodedCommand\\s+(\\S+)')",
      // 被禁用的任务不会运行：不算查证通过
      "    if ($a.Count -ge 1 -and $m.Success -and ($m.Groups[1].Value -ceq $safetyB64) -and ([string]$t.State -ne 'Disabled')) { $r.taskVerified = $true }",
      '  }',
      '} catch {}',
      // 没查证通过 ⇒ 默认不写新段落，并撤掉 hosts 里本插件已有的段落（不留下没有安全网的段落）；撤回本身也要读回确认
      'if (-not $r.taskVerified) {',
      '  if ($rollback) {',
      '    try {',
      "      $cur = ''",
      '      if ([IO.File]::Exists($hostsPath)) { $cur = Read-Hosts }',
      "      $back = [regex]::Replace($cur, $blockPattern, '')",
      '      if ($back -cne $cur) { Write-Hosts $back }',
      "      if ([IO.File]::Exists($hostsPath) -and [regex]::IsMatch((Read-Hosts), $beginPattern)) { $r.hosts = 'rollback-failed: block still present'; $code = 21 } else { $r.hosts = 'rolled-back'; $code = 20 }",
      "    } catch { $r.hosts = 'rollback-failed: ' + $_.Exception.Message; $code = 21 }",
      '  } else { $code = 22 }',
      '}',
    )
    // 查证通过（或按要求无安全网也保留）才写段落；撤回了（20 / 21）就不写
    lines.push('if ($code -ne 20 -and $code -ne 21 -and $new -cne $text) {', ...writeStep.slice(1))
  } else if (safetyNet === 'unregister') {
    lines.push(
      'try {',
      '  $t = Get-Task',
      "  if ($null -ne $t) { Unregister-ScheduledTask -TaskPath '\\' -TaskName $task -Confirm:$false -ErrorAction Stop; $r.task = 'unregistered' } else { $r.task = 'absent' }",
      "} catch { $r.task = 'failed: ' + $_.Exception.Message; $code = 23 }",
    )
  }
  lines.push(
    "if ($r.hosts -ne 'unchanged') {",
    "  try { $null = & (Join-Path $env:SystemRoot 'System32\\ipconfig.exe') /flushdns; if ($LASTEXITCODE -eq 0) { $r.flush = 'ok' } else { $r.flush = 'failed' } } catch { $r.flush = 'failed' }",
    '}',
    'Save-Result',
    'exit $code',
  )
  return lines.join('\r\n')
}

/**
 * 引导脚本：读临时脚本的字节 → 校验 SHA-256 → 一致才执行（ASCII 解码后点源执行，脚本里的 exit
 * 就是进程退出码）。读不到 exit 96，不一致 exit 97。直接运行与 UAC 提权用的都是它 ⇒ 批准的就是这份内容。
 * deadlineMs（可选，Unix 毫秒）：过了这个时刻才开始运行 ⇒ exit 98、什么都不做 —— 用户在宿主已经超时放弃之后
 * 才点 UAC「是」时，不能再去改 hosts（宿主那边已经当失败处理、关了监听）。
 */
function pinnedBootstrap(scriptFile, sha256, deadlineMs = null) {
  if (!/^[0-9A-F]{64}$/.test(String(sha256))) throw new Error('sha256 必须是 64 位大写十六进制')
  const deadline = deadlineMs === null ? [] : (() => {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs 必须是正整数')
    // .NET DateTime.UtcNow.Ticks = (Unix 毫秒 × 10000) + 1970-01-01 的 Ticks
    const ticks = BigInt(deadlineMs) * 10000n + 621355968000000000n
    return [`if ([DateTime]::UtcNow.Ticks -gt ${ticks.toString()}) { exit ${EXIT_APPROVED_TOO_LATE} }`]
  })()
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    ...deadline,
    'try {',
    `  $f = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(scriptFile)}'))`,
    '  $b = [IO.File]::ReadAllBytes($f)',
    "  $h = [BitConverter]::ToString((New-Object Security.Cryptography.SHA256CryptoServiceProvider).ComputeHash($b)).Replace('-', '')",
    `} catch { exit ${EXIT_SCRIPT_UNREADABLE} }`,
    `if ($h -cne '${sha256}') { exit ${EXIT_SCRIPT_TAMPERED} }`,
    '. ([ScriptBlock]::Create([Text.Encoding]::ASCII.GetString($b)))',
    'exit 0',
  ].join('\r\n')
}

/**
 * 未提权时的外壳：以 UAC 提权启动**同一个**引导命令，等它结束并转交退出码（取消 = 1223）。
 * 不用 Start-Process：PS 5.1 的 Start-Process 把 ShellExecute 的 Win32Exception 换成一个**不带内层异常**的
 * InvalidOperationException（实测），"用户点了否"与其它失败就分不开了；Process.Start 直接抛 Win32Exception(1223)。
 */
function elevateLauncher(bootEncoded) {
  return [
    ...PS_HEAD,
    '$psi = New-Object Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${psStr(psExe())}`,
    "$psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + " + psB64Literal(bootEncoded),
    "$psi.Verb = 'runas'",
    '$psi.UseShellExecute = $true',
    '$psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden',
    'try {',
    '  $p = [Diagnostics.Process]::Start($psi)',
    `  if ($null -eq $p) { [Console]::Error.WriteLine('no process handle'); exit ${EXIT_UAC_FAILED} }`,
    '  $p.WaitForExit()',
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    // 用户点了「否」= ERROR_CANCELLED(1223)（PowerShell 调方法时外面会再包一层 MethodInvocationException）
    `  while ($null -ne $e) { if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { exit ${EXIT_UAC_CANCELED} }; $e = $e.InnerException }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    `  exit ${EXIT_UAC_FAILED}`,
    '}',
  ].join('\r\n')
}

/** 跑一次 powershell.exe（绝对路径，不走 PATH）；永不 reject。stdout 按 UTF-8（我们的脚本只输出 ASCII），stderr 按控制台代码页解码。 */
function runPowerShell(args, { timeoutMs = 60000, input = null } = {}) {
  return new Promise((resolve) => {
    const out = []
    const err = []
    let outLen = 0
    let errLen = 0
    let done = false
    let timedOut = false
    let timer = null
    let child = null
    const finish = (exitCode, spawnError) => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      resolve({
        exitCode, timedOut, spawnError,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: errLen > 0 ? decodeConsole(Buffer.concat(err)) : '',
      })
    }
    try {
      child = spawn(psExe(), args, { windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      finish(null, e instanceof Error ? e.message : String(e))
      return
    }
    child.stdout.on('data', (d) => { if (outLen < 8 * 1024 * 1024) { out.push(d); outLen += d.length } })
    child.stderr.on('data', (d) => { if (errLen < 256 * 1024) { err.push(d); errLen += d.length } })
    child.on('error', (e) => finish(null, e instanceof Error ? e.message : String(e)))
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, null))
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* already gone */ }
      // 孙进程（ipconfig 等）可能还握着管道，'close' 迟迟不来：最多再等 3 秒
      setTimeout(() => finish(null, null), 3000).unref?.()
    }, Math.max(1000, Number(timeoutMs) || 60000))
    if (input !== null) {
      child.stdin.on('error', () => { /* 进程提前退出 */ })
      child.stdin.end(input)
    }
  })
}

function readResult(resultFile) {
  try {
    const raw = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')
    const v = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true }) } catch { /* best effort */ }
}

/**
 * 生成脚本 → 写临时文件（钉 SHA-256）→ 直接跑，或（无权限时）经 UAC 跑同一个引导命令 → 收结果 → 删临时文件。
 * 用户在宿主超时放弃之后才点 UAC「是」：引导脚本过了截止时刻（exit 98）或读不到已删的临时脚本（exit 96）⇒ 什么都不做。
 */
async function runApply({ hostsPath, block, safetyNet, taskName, safetyEncoded, rollback, allowElevation, direct, timeoutMs }) {
  const id = randomUUID()
  const resultFile = path.join(os.tmpdir(), `dsh-apv-hosts-${id}.json`)
  const scriptFile = path.join(os.tmpdir(), `dsh-apv-hosts-${id}.ps1`)
  const limit = Math.max(1000, Number(timeoutMs) || 90000)
  try {
    const bytes = asciiBytes(applyScript({ hostsPath, block, resultFile, safetyNet, taskName, safetyEncoded, rollback }))
    fs.writeFileSync(scriptFile, bytes, { flag: 'wx', mode: 0o600 })
    // 截止时刻：给脚本本身留 20 秒跑完（注册计划任务要几秒）；再短也至少 15 秒用来点 UAC
    const boot = encodePs(pinnedBootstrap(scriptFile, sha256Hex(bytes), Date.now() + Math.max(15000, limit - 20000)))
    let method = 'direct'
    let run = null
    if (direct) run = await runPowerShell([...PS_BASE_ARGS, '-EncodedCommand', boot], { timeoutMs })
    if (run === null || run.exitCode === 5) {
      if (!allowElevation) return { method: 'direct', needsElevation: true, exitCode: run?.exitCode ?? null, result: run === null ? null : readResult(resultFile), stderr: run?.stderr ?? '', spawnError: run?.spawnError ?? null, timedOut: false }
      method = 'elevated'
      rmQuiet(resultFile)
      run = await runPowerShell([...PS_BASE_ARGS, '-EncodedCommand', encodePs(elevateLauncher(boot))], { timeoutMs })
    }
    return { method, ...run, result: readResult(resultFile) }
  } catch (e) {
    return { method: null, exitCode: null, timedOut: false, spawnError: e instanceof Error ? e.message : String(e), stdout: '', stderr: '', result: null }
  } finally {
    rmQuiet(scriptFile)
    rmQuiet(resultFile)
  }
}

/**
 * 查安全网任务（只读）：{ state: 'present'|'disabled'|'absent'|'invisible'|'error', argsMatch, taskState? }（taskState = 任务的 State：Ready / Running / Disabled…）。
 * invisible = 本进程未提权且没看到 —— 实测未提权令牌**看不到**管理员注册的 SYSTEM 任务（根目录 13 个 vs 提权 17 个），
 * 这时"没看到"不等于"不存在"。expectEncoded 给出时比对任务动作里的 -EncodedCommand 是否恰好是它（按 SHA-256）。
 */
async function queryTask({ taskName = SAFETY_TASK, expectEncoded = '', timeoutMs = 30000 } = {}) {
  if (process.platform !== 'win32') return { state: 'error', argsMatch: null }
  const script = [
    ...PS_HEAD,
    `$task = ${psStr(taskName)}`,
    'try {',
    '  $t = $null',
    "  try { $t = @(Get-ScheduledTask -TaskPath '\\' -TaskName $task -ErrorAction Stop) | Where-Object { $_.TaskName -eq $task } | Select-Object -First 1 } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { $t = $null } else { throw } }",
    '  if ($null -eq $t) {',
    '    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    "    if ($admin) { 'APV absent' } else { 'APV invisible' }",
    '  } else {',
    "    $m = [regex]::Match([string]@($t.Actions)[0].Arguments, '-EncodedCommand\\s+(\\S+)')",
    "    $h = '-'",
    "    if ($m.Success) { $h = [BitConverter]::ToString((New-Object Security.Cryptography.SHA256CryptoServiceProvider).ComputeHash([Text.Encoding]::ASCII.GetBytes($m.Groups[1].Value))).Replace('-', '') }",
    "    'APV present ' + $h + ' ' + [string]$t.State",
    '  }',
    "} catch { 'APV error' }",
  ].join('\r\n')
  const run = await runPowerShell([...PS_BASE_ARGS, '-EncodedCommand', encodePs(script)], { timeoutMs })
  return parseTaskQuery(run.stdout, expectEncoded)
}

/** queryTask 输出 → { state, argsMatch, taskState? }。任务在但被禁用（State = Disabled）⇒ state 'disabled'：它不会运行，不算在保护。 */
function parseTaskQuery(stdout, expectEncoded = '') {
  const m = /^APV (present|absent|invisible|error)(?: (\S+))?(?: (\S+))?\s*$/m.exec(String(stdout ?? ''))
  if (m === null) return { state: 'error', argsMatch: null }
  if (m[1] !== 'present') return { state: m[1], argsMatch: null }
  const argsMatch = expectEncoded === '' ? null : m[2] === sha256Hex(Buffer.from(expectEncoded, 'ascii'))
  const taskState = m[3] === undefined ? null : m[3]
  return { state: taskState === 'Disabled' ? 'disabled' : 'present', argsMatch, taskState }
}

/** 任务的 State 是否表示「会运行」（没给 State 的旧输出按会运行算）。 */
const taskRuns = (s) => s === undefined || s === null || s === 'Ready' || s === 'Running' || s === 'Queued'

/**
 * 安全网状态判定（纯函数）。结果文件（result）同用户进程可改 ⇒ 不参与 register 的判定，只用来区分 unregistered / absent。
 * register：看得见任务（宿主已提权）⇒ 以查询为准（动作必须恰好是这份安全网脚本）；看不见（宿主未提权，SYSTEM 任务
 * 对它不可见）/ 查询出错 ⇒ 以退出码为准：0 = 脚本在（提权）进程里查证通过；20/21/22 = 没通过；null（超时 / 被杀）= unknown。
 * unregister：任务还在 ⇒ failed；确定不在 ⇒ unregistered / absent；看不见 ⇒ 退出码 23 = failed，0 = 按结果文件，null = unknown。
 */
function safetyNetVerdict({ mode, query, exitCode, result }) {
  const r = result !== null && typeof result === 'object' ? result : null
  const task = r !== null && typeof r.task === 'string' ? r.task : null
  const state = query && typeof query.state === 'string' ? query.state : 'error'
  if (mode === 'register') {
    if (state === 'disabled') return 'failed'
    if (state === 'present') return query.argsMatch === true && taskRuns(query.taskState) ? 'registered' : 'failed'
    if (state === 'absent') return 'failed'
    if (exitCode === 0) return 'registered'
    if (exitCode === null || exitCode === undefined) return 'unknown'
    return 'failed'
  }
  if (mode === 'unregister') {
    if (state === 'present' || state === 'disabled') return 'failed'
    if (state === 'absent') return task === 'unregistered' ? 'unregistered' : 'absent'
    if (exitCode === EXIT_UNREGISTER_FAILED) return 'failed'
    if (exitCode === 0) return task === 'absent' ? 'absent' : 'unregistered'
    return 'unknown'
  }
  return 'skipped'
}

/** 退出码说明脚本已经走到（或可能走到）安全网那一步 ⇒ 要查任务。更早就失败的（2-7、96-98…）没碰任务。 */
function reachedTaskStep(exitCode) {
  return exitCode === null || exitCode === undefined || exitCode === 0 || exitCode === EXIT_TASK_ROLLED_BACK ||
    exitCode === EXIT_TASK_ROLLBACK_FAILED || exitCode === EXIT_TASK_KEPT_UNVERIFIED || exitCode === EXIT_UNREGISTER_FAILED
}

const DANGLING_MSG = 'hosts 里本插件的段落只有开始标记、配不上结束标记（多半被手工改过）⇒ 不自动改动；' +
  '请手工删掉从「' + BLOCK_BEGIN + '」开始属于本插件的那几行后重试'
const READONLY_MSG = 'hosts 文件带「只读」属性（可能是安全软件或"锁定 hosts"类工具设置的）⇒ 没有改动；去掉只读属性后重试'

/** PowerShell 异常文本常带换行 / 结尾空白：压成一行再拼进提示。 */
function oneLine(s, max = 200) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 结果文件里 task 字段的失败原因（'failed: …' 去掉前缀）；不是失败返回 ''。 */
function taskFailure(r) {
  return r !== null && typeof r === 'object' && typeof r.task === 'string' && r.task.startsWith('failed') ? oneLine(r.task.replace(/^failed:?\s*/, '')) : ''
}

function scriptError(run, timeoutMs) {
  if (run.spawnError) return '无法运行 PowerShell：' + run.spawnError
  if (run.timedOut) return `PowerShell 超过 ${Math.round((Number(timeoutMs) || 0) / 1000)} 秒没结束，已终止`
  switch (run.exitCode) {
    case EXIT_SCRIPT_UNREADABLE: return '写 hosts 的临时脚本读不到了（被删除或被拦截）⇒ 没有执行'
    case EXIT_SCRIPT_TAMPERED: return '写 hosts 的临时脚本校验不通过（运行前被改动过）⇒ 没有执行'
    case EXIT_APPROVED_TOO_LATE: return 'UAC 确认来得太晚（宿主已经按超时处理）⇒ 没有执行，hosts 未改动'
    case EXIT_UAC_FAILED: return 'UAC 提权失败：' + (oneLine(run.stderr) || '未知原因')
    case 4: return DANGLING_MSG
    case 6: return READONLY_MSG
    case 7: return '写完 hosts 读回来的内容不对（可能被安全软件拦截或还原了）：' + oneLine(run.result?.error)
    default: break
  }
  const e = run.result && typeof run.result.error === 'string' ? oneLine(run.result.error) : ''
  if (e.startsWith('access-denied')) return '没有写 hosts 的权限：' + e.slice('access-denied: '.length)
  if (e.startsWith('hosts-write-failed')) return '写 hosts 失败：' + e.slice('hosts-write-failed: '.length)
  if (e.startsWith('hosts-read-failed')) return '读 hosts 失败：' + e.slice('hosts-read-failed: '.length)
  if (e !== '') return e
  return oneLine(run.stderr, 300) || `hosts 未按预期更新（exit ${run.exitCode}）`
}

function blockMatches(p, ip, hosts, specs) {
  if (p === null || !p.found || p.dangling) return false
  if (p.entries.length !== hosts.length) return false
  const got = new Set(p.entries.map((e) => `${e.ip} ${e.host}`))
  if (!hosts.every((h) => got.has(`${ip} ${h}`))) return false
  return p.specs.length === specs.length && specs.every((s) => p.specs.includes(s))
}

/**
 * 应用（或清除）hosts 段落。
 * @param {object} o
 * @param {string} o.ip            段落里所有域名指向的回环地址（清除时可省）
 * @param {string[]} o.hosts       要重定向的域名；空数组 = 清除
 * @param {string[]} [o.specs]     每个域名原本的写法（`https://h:8443` / `tcp://h:9000` / `h`），写成 `# apv-entry` 行供恢复
 * @param {string} [o.hostsPath]   默认系统 hosts（测试注入临时文件）
 * @param {'register'|'unregister'|'none'} [o.safetyNet]
 * @param {{port:number, mode:'https'|'http'}} [o.probe]  安全网探测（兼容旧参数 probePort = https）
 * @param {boolean} [o.allowWithoutSafetyNet]  注册不成 / 查不清时也保留段落（默认 false = 撤回并失败）
 * @param {boolean} [o.allowElevation]  直接写失败（未提权）时是否弹 UAC（默认 true）
 * @param {string} [o.taskName]    安全网任务名（默认 SAFETY_TASK；仅自测传假名）
 * @param {string} [o.logPath]     安全网决策日志；只有落在 hosts 所在目录里才采用（见 safetyLogPathFor），否则用默认位置
 * @returns {Promise<{ok:boolean, method:string|null, hostsPath:string,
 *   safetyNet:'registered'|'unregistered'|'absent'|'skipped'|'failed'|'unknown', warnings:string[],
 *   error?:string, canceled?:boolean, rolledBack?:boolean, needsElevation?:boolean, exitCode?:number|null, result?:object|null,
 *   safetyLogPath?:string}>}
 */
export async function applyHostsBlock({
  ip = '', hosts = [], specs = [], hostsPath = defaultHostsPath(), safetyNet = 'none', probe, probePort,
  allowWithoutSafetyNet = false, allowElevation = true, timeoutMs = 90000, taskName = SAFETY_TASK, logPath = '',
} = {}) {
  const warnings = []
  const fail = (error, extra = {}) => ({ ok: false, method: null, hostsPath, safetyNet: 'skipped', warnings, error, ...extra })
  if (process.platform !== 'win32') return fail('透明拦截目前只支持 Windows（依赖 hosts + PowerShell）')
  if (safetyNet !== 'register' && safetyNet !== 'unregister' && safetyNet !== 'none') return fail(`safetyNet 只能是 register / unregister / none: ${safetyNet}`)
  if (typeof taskName !== 'string' || taskName.trim() === '' || taskName.length > 200 || /[\x00-\x1f\\/]/.test(taskName)) return fail('安全网任务名无效')
  if (typeof hostsPath !== 'string' || hostsPath === '') return fail('hostsPath 不能为空')
  let list
  let specList
  let probeCfg
  try {
    list = normalizeHosts(hosts)
    specList = normalizeSpecs(specs)
    probeCfg = safetyNet === 'register' ? normalizeProbe(probe, probePort) : null // 只有注册安全网才用得到探测参数
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (list.length > MAX_HOSTS) return fail(`一次最多重定向 ${MAX_HOSTS} 个域名（当前 ${list.length}）`)
  if (list.length > 0 && !validBlockIp(ip)) return fail(`段落地址必须是回环 IPv4（127.x.x.x）: ${String(ip).slice(0, 40)}`)
  if (safetyNet === 'register' && list.length === 0) return fail('safetyNet=register 需要至少一个域名（清除段落用 unregister / none）')

  // 事前检查（都不需要提权，不弹 UAC）：读得了、不是残缺段落、没有只读属性
  const before = readHostsText(hostsPath)
  if (!before.ok) return fail('读不了 hosts：' + before.error)
  if (parseBlock(before.text).dangling) return fail(DANGLING_MSG)
  if (!before.missing && hasReadOnlyAttribute(hostsPath)) return fail(READONLY_MSG)
  for (const c of hostsConflicts(before.text, list)) {
    warnings.push(`hosts 第 ${c.line} 行（本插件段落之外）已把 ${c.host} 指向 ${c.ip}：Windows 按第一条生效 ⇒ 这个域名的拦截不会生效`)
  }

  const block = list.length === 0 ? '' : buildBlock({ ip, hosts: list, specs: specList })
  const safetyLog = safetyNet === 'register' ? safetyLogPathFor(hostsPath, logPath) : null
  const safetyEncoded = safetyNet === 'register' ? safetyTaskSpec({ hostsPath, probeIp: ip, probe: probeCfg, taskName, logPath: safetyLog }).encoded : ''
  const run = await runApply({
    hostsPath, block, safetyNet, taskName, safetyEncoded,
    rollback: safetyNet === 'register' && !allowWithoutSafetyNet,
    allowElevation, direct: before.missing === true || canWriteDirect(hostsPath), timeoutMs,
  })
  const method = run.method
  const base = { method, hostsPath, warnings, exitCode: run.exitCode, result: run.result, ...(safetyLog !== null ? { safetyLogPath: safetyLog } : {}) }
  if (run.needsElevation) {
    return { ok: false, ...base, safetyNet: 'skipped', needsElevation: true, error: '没有写 hosts 的权限（宿主未提权），且本次不允许弹 UAC' }
  }
  if (run.exitCode === EXIT_UAC_CANCELED) {
    return { ok: false, ...base, safetyNet: 'skipped', canceled: true, error: '已取消 UAC 提权 ⇒ hosts 未改动' }
  }

  const after = readHostsText(hostsPath)
  const parsedAfter = after.ok ? parseBlock(after.text) : null
  const present = list.length > 0 && blockMatches(parsedAfter, ip, list, specList)
  const verified = list.length > 0 ? present : (parsedAfter !== null && !parsedAfter.found)

  // 安全网：脚本走到了任务那一步（见 reachedTaskStep）或结局不明（被杀 / 超时）才查；更早就失败的没碰任务
  let net = 'skipped'
  if (safetyNet !== 'none' && reachedTaskStep(run.exitCode)) {
    const query = await queryTask({ taskName, expectEncoded: safetyEncoded })
    net = safetyNetVerdict({ mode: safetyNet, query, exitCode: run.exitCode, result: run.result })
  }
  const r = run.result
  if (r !== null && r.flush === 'failed') warnings.push('ipconfig /flushdns 失败（DNS 缓存可能要等几分钟才过期）')

  if (safetyNet === 'register') {
    const why = taskFailure(r) !== '' ? '：' + taskFailure(r)
      : net === 'unknown' ? '：查不到注册结果（脚本可能被超时终止）'
        : net === 'skipped' ? '：脚本在注册之前就失败了（' + scriptError(run, timeoutMs).slice(0, 200) + '）' : ''
    if (present) {
      if (net === 'registered') return { ok: true, ...base, safetyNet: net }
      if (allowWithoutSafetyNet) {
        warnings.push(`安全网计划任务没有确认注册成功（${net}）${why} ⇒ 宿主异常退出 / 重启后 hosts 段落不会被自动清理`)
        return { ok: true, ...base, safetyNet: net }
      }
      // 段落在、安全网没确认 ⇒ 撤回段落（脚本自己没撤成：被杀 / 结果不可信）
      const rb = await rollbackBlock({ hostsPath, method, timeoutMs })
      return {
        ok: false, ...base, safetyNet: net, rolledBack: rb.ok,
        error: rb.ok
          ? `安全网计划任务没有确认注册成功（${net}）${why} ⇒ 已撤回 hosts 段落`
          : `安全网计划任务没有确认注册成功（${net}）${why}，撤回 hosts 段落也失败了（${rb.error}）⇒ 请停用拦截或手工删除 hosts 里本插件的段落`,
      }
    }
    // 脚本自己在同一进程里撤回了（exit 20），并且宿主读回确认段落已经不在
    if (run.exitCode === EXIT_TASK_ROLLED_BACK && parsedAfter !== null && !parsedAfter.found) {
      return { ok: false, ...base, safetyNet: net === 'registered' ? 'failed' : net, rolledBack: true, error: `安全网计划任务没有注册成功${why} ⇒ 已撤回 hosts 段落` }
    }
    return { ok: false, ...base, safetyNet: net, error: scriptError(run, timeoutMs) }
  }

  if (!verified) return { ok: false, ...base, safetyNet: net, error: scriptError(run, timeoutMs) }
  if (safetyNet === 'unregister' && (net === 'failed' || net === 'unknown')) {
    const t = taskFailure(r) !== '' ? '：' + taskFailure(r) : ''
    warnings.push(`安全网计划任务注销${net === 'failed' ? '失败' : '结果未知'}${t}（段落已删；任务下次运行发现没有段落会自己注销）`)
  }
  return { ok: true, ...base, safetyNet: net }
}

/** 撤回段落（只删段落、不动任务）：沿用原来的方式（直接 / UAC）。 */
async function rollbackBlock({ hostsPath, method, timeoutMs }) {
  const elevated = method === 'elevated'
  const run = await runApply({ hostsPath, block: '', safetyNet: 'none', taskName: SAFETY_TASK, safetyEncoded: '', rollback: false, allowElevation: elevated, direct: !elevated, timeoutMs })
  const after = readHostsText(hostsPath)
  const ok = after.ok && !parseBlock(after.text).found
  return { ok, error: ok ? null : (run.needsElevation ? '没有写 hosts 的权限' : scriptError(run, timeoutMs)) }
}

/** 当前 hosts 里本插件那一段的状态（只读）。 */
export function hostsBlockState(hostsPath = defaultHostsPath()) {
  const r = readHostsText(hostsPath)
  if (!r.ok) return { readable: false, found: false, ip: null, entries: [], specs: [], dangling: false, hostsPath, error: r.error }
  const p = parseBlock(r.text)
  return { readable: true, found: p.found, ip: p.ip, entries: p.entries, specs: p.specs, dangling: p.dangling, hostsPath }
}

/**
 * 安全网计划任务是否在保护（只读）：true / false / null（未知）。被禁用的任务不会运行 ⇒ 算 false（不在保护）。
 * 未提权的进程看不到管理员注册的 SYSTEM 任务 ⇒ 这种"没看到"返回 null，不冒充"不存在"。
 */
export async function safetyTaskState({ taskName = SAFETY_TASK } = {}) {
  if (process.platform !== 'win32') return null
  const q = await queryTask({ taskName, timeoutMs: 15000 })
  return q.state === 'present' ? true : q.state === 'absent' || q.state === 'disabled' ? false : null
}

/**
 * 安全网任务的详细状态（只读）：{ state: 'present'|'disabled'|'absent'|'invisible'|'error', taskState }。
 * 给界面区分「不在」和「在但被禁用」（后者要提示用户：宿主异常退出后段落不会被自动清理）。
 */
export async function safetyTaskInfo({ taskName = SAFETY_TASK } = {}) {
  if (process.platform !== 'win32') return { state: 'error', taskState: null }
  const q = await queryTask({ taskName, timeoutMs: 15000 })
  return { state: q.state, taskState: q.taskState ?? null }
}

/** 根证书是否已被 Windows 信任（当前用户 / 本机两个根存储；查不到 = null）。 */
export async function caTrustState(thumbprint) {
  if (process.platform !== 'win32' || !/^[0-9A-F]{40}$/.test(String(thumbprint ?? ''))) return { currentUser: null, localMachine: null }
  const script = [
    ...PS_HEAD,
    `$tp = ${psStr(thumbprint)}`,
    "$u = Test-Path -LiteralPath ('Cert:\\CurrentUser\\Root\\' + $tp)",
    "$m = Test-Path -LiteralPath ('Cert:\\LocalMachine\\Root\\' + $tp)",
    '"APV $u,$m"',
  ].join('\r\n')
  const r = await runPowerShell([...PS_BASE_ARGS, '-EncodedCommand', encodePs(script)], { timeoutMs: 15000 })
  const m = /^APV (True|False),(True|False)\s*$/m.exec(r.stdout)
  if (m === null) return { currentUser: null, localMachine: null }
  return { currentUser: m[1] === 'True', localMachine: m[2] === 'True' }
}

const MIN_TTL_S = 60
const MAX_TTL_S = 3600

/** ConvertTo-Json（PS 5.1）的数组可能是数组、单个值、或 { value:[…], Count } 包装 ⇒ 统一成数组。 */
function jsonList(v) {
  if (Array.isArray(v)) return v
  if (v !== null && typeof v === 'object' && Array.isArray(v.value)) return v.value
  if (v === null || v === undefined || v === '') return []
  return [v]
}

/**
 * 绕开 hosts 问 DNS：**一个** PowerShell 进程里对所有域名跑 `Resolve-DnsName -Type A -DnsOnly -NoHostsFile`
 * —— 走 Windows DNS 客户端（遵守 NRPT / VPN 分流 / 网卡顺序，与客户端自己的解析同路径，只是不看 hosts）。
 * 返回 Map<host(小写), { ips, ttlMs, error? }>：ttlMs 取 A 记录最小 TTL，下限 60 秒、上限 1 小时；
 * 每个域名各自的错误放进 error；**永不抛错**（起不来 / 超时时没结果的域名都带 error）。
 * 域名经 stdin 以 base64 传入（不进命令行：不受长度限制，也不拼进 PowerShell 源码）；结果逐行输出，超时前已解析的照样拿到。
 */
export async function resolveNoHostsFile(names, { timeoutMs } = {}) {
  const out = new Map()
  try {
    const list = [...new Set((Array.isArray(names) ? names : [names]).map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean))]
    const valid = []
    for (const n of list) {
      if (validRedirectHost(n)) valid.push(n)
      else out.set(n, { ips: [], ttlMs: MIN_TTL_S * 1000, error: '不是可解析的域名（IP / localhost / 单段名 / 非法字符）' })
    }
    if (valid.length === 0) return out
    if (process.platform !== 'win32') {
      for (const n of valid) out.set(n, { ips: [], ttlMs: MIN_TTL_S * 1000, error: '只支持 Windows（Resolve-DnsName）' })
      return out
    }
    const script = [
      ...PS_HEAD,
      '$raw = [Console]::In.ReadToEnd()',
      "foreach ($line in ($raw -split \"`n\")) {",
      '  $b = $line.Trim()',
      "  if ($b -eq '') { continue }",
      "  $o = @{ n = ''; ips = [string[]]@(); ttl = -1; err = '' }",
      '  try {',
      '    $o.n = D $b',
      '    $recs = @(Resolve-DnsName -Name $o.n -Type A -DnsOnly -NoHostsFile -ErrorAction Stop)',
      "    $a = @($recs | Where-Object { $_.Section -eq 'Answer' -and $_.Type -eq 'A' })",
      '    $o.ips = [string[]]@($a | ForEach-Object { [string]$_.IPAddress })',
      "    if ($a.Count -gt 0) { $o.ttl = [int64](($a | Measure-Object -Property TTL -Minimum).Minimum) } else { $o.err = 'no A record' }",
      '  } catch { $o.err = [string]$_.Exception.Message }',
      '  $j = ConvertTo-Json -InputObject $o -Compress -Depth 3',
      "  [Console]::Out.WriteLine('APV ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)))",
      '  [Console]::Out.Flush()',
      '}',
    ].join('\r\n')
    const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : Math.min(120000, 15000 + 3000 * valid.length)
    const run = await runPowerShell([...PS_BASE_ARGS, '-EncodedCommand', encodePs(script)], {
      timeoutMs: limit,
      input: valid.map((n) => b64(n)).join('\n') + '\n',
    })
    const got = new Map()
    for (const line of run.stdout.split(/\r?\n/)) {
      const m = /^APV ([A-Za-z0-9+/=]+)\s*$/.exec(line)
      if (m === null) continue
      let parsed
      try { parsed = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) } catch { continue }
      for (const o of jsonList(parsed)) {
        if (o === null || typeof o !== 'object') continue
        const n = String(o.n ?? '').trim().toLowerCase()
        if (n === '' || !valid.includes(n)) continue
        const ips = jsonList(o.ips).map((x) => String(x).trim()).filter((x) => net.isIPv4(x))
        const err = oneLine(o.err, 300)
        const ttl = Number(o.ttl)
        const ttlS = Number.isFinite(ttl) && ttl >= 0 ? ttl : 300
        got.set(n, ips.length > 0
          ? { ips, ttlMs: Math.max(MIN_TTL_S, Math.min(ttlS, MAX_TTL_S)) * 1000 }
          : { ips: [], ttlMs: MIN_TTL_S * 1000, error: err !== '' ? err : '没有 A 记录' })
      }
    }
    const missing = run.spawnError ? '无法运行 PowerShell：' + run.spawnError
      : run.timedOut ? `解析超时（${Math.round(limit / 1000)} 秒）`
        : '没有拿到解析结果' + (oneLine(run.stderr) !== '' ? '：' + oneLine(run.stderr) : '')
    for (const n of valid) out.set(n, got.get(n) ?? { ips: [], ttlMs: MIN_TTL_S * 1000, error: missing })
  } catch (e) {
    const msg = '解析失败：' + (e instanceof Error ? e.message : String(e))
    for (const n of (Array.isArray(names) ? names : [names])) {
      const k = String(n ?? '').trim().toLowerCase()
      if (k !== '' && !out.has(k)) out.set(k, { ips: [], ttlMs: MIN_TTL_S * 1000, error: msg })
    }
  }
  return out
}

/** 只给自测用的内部件（生成的脚本、判定函数、共用正则源码）；业务代码不要依赖。 */
export const _hostsRedirectInternals = { applyScript, runApply, pinnedBootstrap, elevateLauncher, safetyNetVerdict, reachedTaskStep, queryTask, parseTaskQuery, jsonList, BLOCK_SRC, BEGIN_LINE_SRC }
