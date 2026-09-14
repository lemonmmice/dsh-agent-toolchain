// 配置读法纪律（仓库级守卫）：**用户级配置项必须经 env-fallback 读**。
//
// 病（2026-09-11 真机实测，本仓第 13/14 处同型半修，且这两处直接掐死了用户的两个头号场景）：
//   Windows 上用户按常规做法把配置写进**用户级环境变量**（注册表 HKCU\Environment）。而 DSH 宿主是
//   **长活进程** —— 它的环境块里没有这些变量（它们是宿主启动之后才设的），`process.env.X` 读到 undefined。
//   于是同一批插件里出现两种读法，症状各异，但都是**工具在说谎 + 下一步建议是错的**：
//     · dsh-hang-inspector：`DSH_UI_PROC_NAME` 读成空 → `hang_run` 启动监测**不带 -ProcName** →
//       监测脚本立刻 `HANG_MONITOR_ERROR 未指定客户端进程名` 退出 → **「用户报卡死」主线根本起不来**；
//       且 `DSH_HANG_SRC_ROOT` 读不到 → analyze 只能给模块级线索，**拿不到代码级证据（G3）**。
//     · lib/dump-tools.mjs：procdump/DumpStack 读成"缺失" → **抓不到 dump**（已修）。
//     · dsh-perf / dsh-build / api-visualizer 的 DSH 面配置入口：同类漏读。
//
// 本测试的做法：把"用户会去配的那些变量"列成一张**显式清单**（不是通配），
// 然后扫描仓库里所有非测试源码，要求它们**只以字符串形式**出现在 env-fallback 调用里
// （envOr/envValue/unconfiguredHint），不得直接 `process.env.X` / `env.X`。
//
// 为什么用清单而不是"所有 DSH_*"：像 DSH_UI_SERVE、DSH_UI_LOCK_*、DSH_CAPTURE_FLUSH_MS 这类是
// **进程级调参**，本来就该只认进程环境（用户不会去注册表配它们）。清单里每一项都对应"用户会配、
// 且配不上就会导致工具说谎"的东西。清单是**故意写死**的：改动它必须过 code review，而不是被自动放宽。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const ROOT = join(import.meta.dirname, '..')

/** 用户会配、且漏读会导致"工具说谎/拿不到证据"的配置项。 */
const USER_FACING = [
  // 目标进程/窗口/客户端：决定"看不看得见客户端"
  'DSH_UI_PROC_NAME', 'DSH_UI_WINDOW_NAME', 'DSH_UI_CLIENT_EXE',
  // 证据目录与源码根：决定"拿不拿得到代码级证据"（G3）
  'DSH_UI_EVIDENCE_DIR', 'DSH_UI_LIVE_DIR',
  'DSH_HANG_SRC_ROOT', 'DSH_HANG_EVIDENCE_DIR', 'DSH_HANG_RUN_DIR', 'DSH_HANG_UI_DRIVE', 'DSH_HANG_LOOP_SCRIPT',
  'DSH_PERF_SRC_ROOT', 'DSH_PERF_EVIDENCE_DIR',
  'DSH_API_SRC_ROOT', 'DSH_API_CAPTURE_STORE',
  // 构建：决定"能不能编译验证"
  'DSH_BUILD_REPO_ROOT', 'DSH_BUILD_CLIENT_ROOT', 'DSH_BUILD_MSBUILD', 'DSH_BUILD_LOGS_DIR',
  // 本机工具链位置（用户按需覆盖）
  'DSH_HANG_PROCDUMP', 'DSH_PERF_PROCDUMP', 'DSH_HANG_DUMPSTACK', 'DSH_PERF_DUMPSTACK',
  'DSH_HANG_DAC_DIR', 'DSH_PERF_DAC_DIR', 'DSH_PERF_SYMBOL_PATH', 'DSH_PERF_SYMBOL_CACHE',
  // 长期记忆/收尾裁决的存储位置
  'DSH_MEMORY_DIR', 'DSH_VERIFY_DIR', 'DSH_FAILURE_CORPUS_DIR',
  // ---- 以下由 Codex r15 复核补入（它直接驳倒了上一版清单："不能证明所有用户配置都避免裸读"）----
  // 安全/护栏类：这些是**运维会去配**的东西，配不上就等于"以为有护栏其实没有"
  'DSH_UI_DENY_RE', 'DSH_UI_APP_POLICY', 'DSH_UI_SAFETY_POLICY_FILE', 'DSH_UI_ESTOP_FILE',
  // 解释器覆盖（用户机器上 pwsh 路径特殊时要配）
  'DSH_UI_POWERSHELL', 'DSH_PERF_POWERSHELL', 'DSH_HANG_PWSH',
]

/**
 * 前缀规则：`DSH_CRED_*` 是**带前缀的动态名**（凭据按名注入），没法逐个列。
 * 它的读法尤其要紧 —— 展开发生在 PowerShell **子进程**里，所以 Node 侧的回退救不了它，
 * 必须由驱动把注册表里的值**注入子进程环境**（见 driver.mjs 的 missingCredEnv）。
 * 因此这里除了"不得裸读"，还多一条：驱动必须真的注入。
 */
const USER_FACING_PREFIXES = ['DSH_CRED_']

/** 允许直接读这些变量的**非测试**文件（每条都要有理由；空列表是目标状态）。 */
const RAW_READ_OK = new Map([
  // env-fallback 自己就是那个"回退"的实现，必然要读 process.env。
  ['lib/env-fallback.mjs', '回退实现本身'],
  // dump-tools 的注册表回退实现在 env-fallback 里，这里只做 pickEnv 转调（见该文件注释）。
  ['lib/dump-tools.mjs', '经 envValue 转调；本文件里的 process.env 只是 envValue 的默认入参'],
])

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'bench-runs') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|js)$/.test(e.name)) {
      const rel = relative(ROOT, p).split('\\').join('/')
      // 测试文件允许直接摆弄 process.env（其中 DSH_NO_ENV_FALLBACK=1 让回退整体失效）
      if (!/\.test\.mjs$/.test(rel) && !/^plugins\/[^/]+\/test\//.test(rel) && !/^scripts\/test\//.test(rel)) out.push({ rel, abs: p })
    }
  }
  return out
}

const files = walk(join(ROOT, 'plugins')).concat(walk(join(ROOT, 'lib')), walk(join(ROOT, 'mcp')), walk(join(ROOT, 'scripts')))
check('扫描器有效（确实扫到了源码文件，否则本节通过没有意义）', files.length > 40, 'files=' + files.length)

const offenders = []
for (const f of files) {
  if (RAW_READ_OK.has(f.rel)) continue
  const src = readFileSync(f.abs, 'utf8')
  const lines = src.split(/\r?\n/)
  lines.forEach((line, i) => {
    // 去掉行内注释，避免注释里提到变量名被误判
    const code = line.replace(/(^|\s)\/\/.*$/, '')
    for (const v of USER_FACING) {
      // 直接成员读取：process.env.X / env.X / process.env['X']
      const direct = new RegExp('(?:process\\.env|\\benv)\\.' + v + '\\b').test(code) ||
        new RegExp("(?:process\\.env|\\benv)\\[\\s*['\"]" + v + "['\"]\\s*\\]").test(code)
      if (!direct) continue
      // 允许：写入进程环境（给子进程传参）——`env.X = ...` 是**设置**，不是读取配置
      const isWrite = new RegExp('(?:process\\.env|\\benv)\\.' + v + '\\s*(?:=|\\+=)').test(code)
      if (isWrite) continue
      offenders.push({ file: f.rel, line: i + 1, v, text: line.trim().slice(0, 120) })
    }
    // 前缀规则：`process.env['DSH_CRED_' + name]` / `env[name]` 这类**动态名**也要能查出来
    for (const pfx of USER_FACING_PREFIXES) {
      const dyn = new RegExp("(?:process\\.env|\\benv)\\[[^\\]]*['\"]" + pfx + "['\"]").test(code) ||
        new RegExp("(?:process\\.env|\\benv)\\[\\s*`[^`]*" + pfx).test(code)
      if (dyn) offenders.push({ file: f.rel, line: i + 1, v: pfx + '*（动态名）', text: line.trim().slice(0, 120) })
    }
  })
}

// 分组打印，便于一眼看出"哪个文件还在裸读"
const byFile = new Map()
for (const o of offenders) {
  if (!byFile.has(o.file)) byFile.set(o.file, [])
  byFile.get(o.file).push(o)
}
for (const [file, list] of byFile) {
  console.log('  ---- ' + file + '（' + list.length + ' 处）')
  for (const o of list) console.log('       行 ' + o.line + '  ' + o.v + '   ' + o.text)
}

check('★ 用户级配置项不得被"裸读"（必须经 envOr/envValue，否则长活宿主的进程环境里读不到）',
  offenders.length === 0, offenders.length + ' 处裸读，见上')

// 反向自证：改法本身**必须真的能读到值**，否则"全都改成 envOr"就成了自欺。
// （进程环境里给值 → envOr 必须拿到；这是最弱但必要的一条。）
{
  const { envOr } = await import('./env-fallback.mjs')
  const key = 'DSH_UI_PROC_NAME'
  const saved = process.env[key]
  process.env[key] = 'UnitTestProc'
  try {
    check('envOr 在进程环境有值时确实读到（反向自证）', envOr(key) === 'UnitTestProc', envOr(key))
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

// 前缀类变量（`DSH_CRED_*`）光"不裸读"还不够：它的展开在**子进程**里，Node 侧回退救不了它 ——
// 驱动必须把注册表里的值**注入子进程环境**。这里把这条也钉住（两个 spawn 路径都要）。
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const driverSrc = readFileSync(join(ROOT, 'plugins', 'dsh-ui-drive', 'lib', 'driver.mjs'), 'utf8')
  const envSrc = readFileSync(join(ROOT, 'lib', 'env-fallback.mjs'), 'utf8')
  check('env-fallback 提供"按前缀取一组变量"的能力（动态名靠它）', /export function envWithPrefix\s*\(/.test(envSrc))
  check('★ 一次性脚本路径注入了凭据环境（否则 ${cred:...} 在长活宿主下必失败）',
    /missingCredEnv\(env\)/.test(driverSrc), '未见 missingCredEnv(env)')
  check('★ 常驻进程路径同样注入（常驻进程环境在启动那刻固定，之后只能靠这里）',
    /missingCredEnv\(warmEnv\)/.test(driverSrc), '未见 missingCredEnv(warmEnv)')
  check('注入实现走前缀读取（而不是自己拼 process.env）',
    /envWithPrefix\('DSH_CRED_'/.test(driverSrc), '未见 envWithPrefix(\'DSH_CRED_\')')
}

// 前缀读取器本身的行为（确定性：注入假的 reg 执行器，不依赖本机真配了什么）
{
  const { envWithPrefix } = await import('./env-fallback.mjs')
  const fakeExec = (file, args) => {
    const text = [
      'HKEY_CURRENT_USER\\Environment',
      '    DSH_CRED_alpha    REG_SZ    secretA',
      '    DSH_CRED_beta     REG_EXPAND_SZ    %USERPROFILE%\\beta.txt',
      '    DSH_OTHER         REG_SZ    nope',
      '    Path              REG_EXPAND_SZ    C:\\x',
      '',
    ].join('\r\n')
    return text
  }
  const r = envWithPrefix('DSH_CRED_', { env: {}, exec: fakeExec })
  check('按前缀只取到自己那一组（不把无关变量带出来）', Object.keys(r).sort().join(',') === 'DSH_CRED_alpha,DSH_CRED_beta', JSON.stringify(r))
  check('REG_EXPAND_SZ 会展开（不是把 %VAR% 原样带出去）', !/%USERPROFILE%/.test(String(r.DSH_CRED_beta || '')), String(r.DSH_CRED_beta))
  const override = envWithPrefix('DSH_CRED_', { env: { DSH_CRED_alpha: 'fromProcess' }, exec: fakeExec })
  check('进程环境的值优先（注册表不覆盖它）', override.DSH_CRED_alpha === 'fromProcess', override.DSH_CRED_alpha)
  const gated = envWithPrefix('DSH_CRED_', { env: { DSH_NO_ENV_FALLBACK: '1' }, exec: fakeExec })
  check('DSH_NO_ENV_FALLBACK=1 时完全不看注册表（测试硬闸仍然有效）', Object.keys(gated).length === 0, JSON.stringify(gated))
  check('空前缀返回空对象、不抛', Object.keys(envWithPrefix('', { env: { DSH_X: '1' } })).length === 0)
}

console.log(failures === 0
  ? '\nPASS: 配置读法纪律（用户级配置必须经 env-fallback）'
  : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
