/**
 * 环境变量解析：进程环境 → 用户级注册表 → 机器级注册表（带来源标注）。
 *
 * 为什么需要它（2026-09-11 真机实测，G1 可用性缺陷）：
 *   Windows 上 `setx`/用户级环境变量只对**之后**启动的进程生效。DSH 宿主是长活进程，
 *   用户在配置好 `DSH_UI_PROC_NAME` 等变量**之后**并没有重启宿主 —— 于是宿主（以及它 spawn 的
 *   MCP server）的 `process.env` 里根本没有这些变量，工具却只报一句
 *   「未配置目标进程（设置 DSH_UI_PROC_NAME / ...）」。
 *   实测证据：注册表 HKCU\Environment 里 DSH_UI_PROC_NAME=AcmeClient、DSH_UI_CLIENT_EXE=…
 *   全都齐备，而同一台机器上 `ui_status` 返回 `{running:false, unconfigured:true}`。
 *   **用户明明配置了，工具说他没配** —— 这就是工具在撒谎（G2），而且给出的下一步
 *   （"去设置它"）是错的：他已经设过了，真正的动作是"重启宿主"或"给进程传 env"。
 *
 * 设计约束：
 *   · **进程环境优先**：进程里有的值永远赢（显式 `env VAR=...` 传参不被覆盖）。
 *   · 来源必须可查：返回 `source`，调用方应把它带上（`process` / `user` / `machine` / `missing`）。
 *     不静默：从注册表读到的值带 `inherited:false`，调用方可提示"当前进程未继承，建议重启宿主"。
 *   · 只读、失败即忽略：非 Windows / 无 reg.exe / 权限问题一律返回 missing，绝不抛。
 *   · 结果缓存（含负结果）：每个进程最多问一次注册表。
 */
import { execFileSync } from 'node:child_process'

/** 注册表读取实现（可注入，便于测试）。返回 null 表示"这个 hive 里没有"。 */
export function readRegistryEnv(name, hive, exec = defaultExec) {
  if (process.platform !== 'win32') return null
  let out
  try {
    out = exec('reg', ['query', hive, '/v', name])
  } catch {
    return null // 值不存在时 reg 退出码非 0 —— 正常情况，不是错误
  }
  if (!out) return null
  // 允许 exec 直接给 Buffer（真实 defaultExec 就是这么用的）：Buffer 必须走 OEM 解码，
  // 绝不能 `String(buf)`（那等于按 UTF-8 硬解，中文值必坏）。
  const text = typeof out === 'string' ? out : decodeConsole(out)
  // 形如：    DSH_UI_PROC_NAME    REG_SZ    AcmeClient
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2,}([^\s]+)\s+(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ)\s+(.*)$/.exec(line)
    if (!m || m[1].toLowerCase() !== name.toLowerCase()) continue
    const raw = m[3].trim()
    return m[2] === 'REG_EXPAND_SZ' ? expand(raw) : raw
  }
  return null
}

/**
 * reg.exe 的输出按**控制台 OEM 代码页**编码，不是 UTF-8（2026-09-11 真机踩到）。
 *
 * 症状很隐蔽：ASCII 值（AcmeClient）一切正常，一旦值里有中文就变乱码 ——
 * `DSH_UI_WINDOW_NAME=示例窗口` 被解成垃圾后，探针报「未找到主窗口」；
 * `DSH_UI_CLIENT_EXE=…\<client>\…` 被解成垃圾后，`existsSync` 必然 false。
 * 也就是说：**回退本身能用，但会把带中文的配置悄悄弄坏**（比不回退更糟：错误表现为"窗口找不到"）。
 *
 * 修法：先按 UTF-8 **严格**解码（fatal:true——只要有非法序列就抛），失败再依次试常见 OEM 代码页。
 * 纯 ASCII 输出在 UTF-8 下必然成功，所以正常路径零开销、零行为变化。
 */
export function decodeConsole(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch { /* 不是合法 UTF-8 → 按 OEM 代码页试 */ }
  for (const enc of ['gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    try {
      const s = new TextDecoder(enc).decode(b)
      if (s && !s.includes('\uFFFD')) return s
    } catch { /* 该代码页在此构建里不可用 */ }
  }
  return b.toString('utf8')
}

function defaultExec(file, args) {
  // 必须拿 Buffer，不能用 { encoding: 'utf8' } —— 那会在解码前就把字节按 UTF-8 弄坏了。
  const buf = execFileSync(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  return decodeConsole(buf)
}

/** %USERPROFILE% 这类引用按当前进程环境展开（未定义的引用原样保留，不谎报成功）。 */
function expand(s) {
  return String(s).replace(/%([^%]+)%/g, (full, name) => {
    const v = process.env[name]
    return v === undefined ? full : v
  })
}

const cache = new Map()

/**
 * 解析一个配置项。返回 { name, value, source, inherited, note }。
 *  · source: 'process' | 'user' | 'machine' | 'missing'
 *  · inherited: 值是否来自当前进程的环境块（false 且 value 非空 = 进程未继承，宿主需重启）
 */
export function envValue(name, { env = process.env, exec = defaultExec, fresh = false } = {}) {
  const direct = env[name]
  // 显式空串 = 调用方**主动清空**（`env VAR=` / 测试里 `process.env.X = ''`），
  // 这种情况绝不回退注册表 —— 否则"我想测未配置路径"会拿到机器上真配好的值。
  // 只有 undefined（进程环境里根本没这个变量）才回退。
  if (typeof direct === 'string') {
    if (direct !== '') return { name, value: direct, source: 'process', inherited: true, note: '' }
    return { name, value: '', source: 'missing', inherited: true, note: '进程环境里该变量被显式设为空串（视为未配置，不回退注册表）' }
  }
  // 测试专用硬闸（DSH_NO_ENV_FALLBACK=1）：**彻底不看注册表**。
  // 起因是一场真实事故（2026-09-11）：本回退上线后，某个用 `delete process.env.X` 模拟
  // "未配置"的测试拿到了本机真配好的客户端路径，于是 `build(killClient=true)` 把用户**正在跑的
  // 客户端进程杀掉了**。测试绝不该能驱动/结束真实目标进程 —— 所以由测试运行器统一设这个闸，
  // 让所有测试进程对"机器上真配了什么"完全失明（要测回退本身，显式注入 env/exec，见单测）。
  if (String(env.DSH_NO_ENV_FALLBACK || '') === '1') {
    return { name, value: '', source: 'missing', inherited: true, note: 'DSH_NO_ENV_FALLBACK=1（测试硬闸）：不回退注册表' }
  }
  if (!fresh && cache.has(name)) return { ...cache.get(name) }
  let r = { name, value: '', source: 'missing', inherited: false, note: '' }
  for (const [hive, src] of [['HKCU\\Environment', 'user'], ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'machine']]) {
    let v = null
    try { v = readRegistryEnv(name, hive, exec) } catch { v = null }
    if (v) {
      r = {
        name, value: v, source: src, inherited: false,
        note: src === 'user'
          ? '值取自**用户级环境变量**（注册表 HKCU\\Environment）—— 当前进程的环境块里没有它，' +
            '说明这个变量是在宿主启动**之后**才设置的。值可用，但要让所有子进程都看到它（例如新建的 MCP server 或宿主重启后），' +
            '请重启宿主；本次已按注册表值工作。'
          : '值取自**机器级环境变量**（注册表 HKLM\...\Environment）—— 当前进程环境块里没有它，同样建议重启宿主后复验。',
      }
      break
    }
  }
  cache.set(name, r)
  return { ...r }
}

/** 便利：只要值（不含来源）。 */
export function envOr(name, fallback = '', opts) {
  const r = envValue(name, opts)
  return r.value || fallback
}

/**
 * 取**某个前缀下的一整组**变量（进程环境优先，其次注册表）。
 *
 * 为什么需要它（2026-09-12 复核发现）：凭据用的是 `DSH_CRED_<name>` 这种**带前缀的动态名**，
 * 而 `envValue` 只能按**完整名字**查。于是所有"按名字前缀注入一组配置"的地方都没法走回退：
 *   · ui-drive 的 `${cred:name}` 是在**子进程**里读 `DSH_CRED_name` 的 ——
 *     用户按 Windows 常规把凭据配在**用户级环境变量**里，长活宿主没继承 ⇒
 *     子进程读不到 ⇒ 工具报「凭据占位符未解析：DSH_CRED_x 未设置」，
 *     而用户明明设过了；最后人会**把明文直接贴进参数** —— 恰恰是这个机制要避免的事。
 * 同由一台机器上的实据：HKCU\Environment 里已存在 `DSH_CRED_<name>`，而宿主进程环境里没有它。
 *
 * 返回 { name: value }（同名时**进程环境优先**）。读不到就返回空对象，绝不抛。
 */
export function envWithPrefix(prefix, { env = process.env, exec = defaultExec, fresh = false } = {}) {
  const out = {}
  const p = String(prefix)
  if (!p) return out
  if (process.platform === 'win32' && String(env.DSH_NO_ENV_FALLBACK || '') !== '1') {
    for (const hive of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      let text = ''
      try {
        const buf = exec('reg', ['query', hive])
        text = typeof buf === 'string' ? buf : decodeConsole(buf)
      } catch { continue }   // 整个 hive 查不到值不是错误
      if (!text) continue
      for (const line of String(text).split(/\r?\n/)) {
        const m = /^\s{2,}([^\s]+)\s+(REG_SZ|REG_EXPAND_SZ|REG_MULTI_SZ)\s+(.*)$/.exec(line)
        if (!m) continue
        const name = m[1]
        if (!name.startsWith(p)) continue
        const raw = m[3].trim()
        out[name] = m[2] === 'REG_EXPAND_SZ' ? expand(raw) : raw
      }
    }
  }
  // 进程环境**最后覆盖**（显式传入的值永远赢）
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(p) && v !== undefined && String(v) !== '') out[k] = String(v)
  }
  return out
}

/**
 * 「未配置」时给用户的**可执行**说明：先查注册表判断到底是"没配过"还是"配了但没继承"。
 * 这两种情况的下一步完全不同 —— 混为一谈就是在教用户做无用功。
 */
export function unconfiguredHint(names, opts) {
  const list = Array.isArray(names) ? names : [names]
  const found = list.map((n) => envValue(n, opts)).filter((r) => r.value)
  if (found.length) {
    return '这些变量**在用户级环境里已经配好了**（' + found.map((r) => r.name + '=' + r.value).join('、') +
      '），但当前进程的环境块里没有它们 —— 说明是在进程启动**之后**才设置的。' +
      '现在已在本次调用里按注册表值生效；要让宿主/所有子进程都看到，请重启宿主后复验。'
  }
  return '这些变量在当前进程环境、用户级与机器级环境里**都不存在**：请先设置 ' + list.join(' / ') + ' 后重试。'
}

/** 测试用：清空缓存。 */
export function resetEnvCache() {
  cache.clear()
}
