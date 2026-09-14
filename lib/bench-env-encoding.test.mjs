// 跨进程读环境变量：**控制台 OEM 码页**这件事不许再被各脚本各写一遍（F-036，2026-09-12 r33）。
//
// 病（实测量出，不是推理）：
//   Windows 上 `powershell.exe` 的 stdout 是按**控制台 OEM 代码页**（本机 zh-CN = CP936）编码的。
//   脚本里这么读用户级环境变量：
//       execFileSync('powershell.exe', ['-NoProfile','-Command',
//           `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' })
//   ASCII 值一切正常，带中文的值**必坏**：
//       实测 DSH_UI_WINDOW_NAME（值 `示例窗口`）→ 一串 U+FFFD 替换字符
//       —— 5 个字符，其中 **4 个是 U+FFFD 替换字符**（原始 6 字节 GBK 被按 UTF-8 硬解）。
//
//   而 `lib/env-fallback.mjs` **早就把这件事修对了**（`reg query` + `decodeConsole` 按 OEM 解码，
//   它的注释里甚至点名了 `DSH_UI_WINDOW_NAME=示例窗口` 这个症状）。两个验收脚本却绕开它、
//   自己又实现了一遍 —— 于是这个"已经修过的缺陷"在脚本里复活。
//
//   为什么值得单独钉住：乱码后**窗口匹配必然失败**，而报错长成
//   「未找到主窗口」——看起来像**被测客户端**的问题，不是脚本自己的问题。
//   把工具链自己的缺陷记到客户端头上，是这套工具最该避免的误判。
import { readRegistryEnv, decodeConsole, envOr } from './env-fallback.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let skipped = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' — ' + why) }

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CN = '示例窗口'
// `示例窗口` 的 GBK(CP936) 字节 —— 与 Windows 上 `reg query` 实际吐出的字节同源。
// 下面的自检用 Node 的 TextDecoder('gbk') 反解回来核对，写错了会被当场抓住。
const GBK_CN = [0xCA, 0xBE, 0xC0, 0xFD, 0xB4, 0xB0, 0xBF, 0xDA]

// ---------------------------------------------------------------------------
// 1. ★ 核心：GBK 字节的注册表输出必须被正确解回，且**不能**靠 UTF-8 硬解
// ---------------------------------------------------------------------------
{
  const okBytes = new TextDecoder('gbk').decode(Buffer.from(GBK_CN)) === CN
  check('前置：测试固件的 GBK 字节确实解出「' + CN + '」（否则本文件在测空气）', okBytes,
    JSON.stringify(new TextDecoder('gbk').decode(Buffer.from(GBK_CN))))

  // 先证明"按 UTF-8 硬解"这条路是**真的会坏**——否则下面的断言可能只是因为测试写得太宽松。
  const naive = new TextDecoder('utf-8').decode(Buffer.concat([
    Buffer.from('    DSH_UI_WINDOW_NAME    REG_SZ    ', 'ascii'), Buffer.from(GBK_CN),
  ]))
  const badCount = (naive.match(/\uFFFD/g) || []).length
  check('★ 反证：同样字节按 UTF-8 解会产出替换字符 U+FFFD（这就是旧写法坏掉的方式）',
    badCount > 0, 'U+FFFD x' + badCount + '  ' + JSON.stringify(naive))

  if (process.platform !== 'win32') {
    skip('注册表 OEM 解码', '非 Windows')
  } else {
    const buf = Buffer.concat([
      Buffer.from('    DSH_UI_WINDOW_NAME    REG_SZ    ', 'ascii'),
      Buffer.from(GBK_CN),
      Buffer.from('\r\n', 'ascii'),
    ])
    const v = readRegistryEnv('DSH_UI_WINDOW_NAME', 'HKCU\\Environment', () => buf)
    check('★ readRegistryEnv 把 GBK 字节正确解回「' + CN + '」', v === CN, JSON.stringify(v))
    check('解出来的值里没有 U+FFFD', typeof v === 'string' && !v.includes('\uFFFD'), JSON.stringify(v))

    // 契约：**字符串 = 调用方已经解好了**，readRegistryEnv 原样取用、不二次解码。
    //   （我第一版这里传的是 `buf.toString('binary')` —— 那在进函数之前就已经把字节毁成
    //    `Å£¹ÉÍõ` 了，再断言"能解回中文"是**不可能成立**的，是断言写错、不是代码错。）
    const preDecoded = '    DSH_UI_WINDOW_NAME    REG_SZ    ' + CN + '\r\n'
    const v2 = readRegistryEnv('DSH_UI_WINDOW_NAME', 'HKCU\\Environment', () => preDecoded)
    check('喂**已解码字符串**时原样取用、不二次损坏', v2 === CN, JSON.stringify(v2))

    // 而"把 Buffer 硬转成字符串"确实会丢信息 —— 这条如实记下来，说明调用方必须交 Buffer。
    const latin1 = Buffer.concat([Buffer.from('    DSH_UI_WINDOW_NAME    REG_SZ    ', 'ascii'), Buffer.from(GBK_CN)]).toString('binary')
    check('（如实记录）Buffer 若先 toString(\'binary\')，字节已毁、任何解码器都救不回 —— 所以调用方必须直接交 Buffer',
      readRegistryEnv('DSH_UI_WINDOW_NAME', 'HKCU\\Environment', () => latin1) !== CN, '')
  }

  // 纯 ASCII 零行为变化（正常路径不能被这次修复影响）
  const ascii = Buffer.from('    DSH_UI_PROC_NAME    REG_SZ    AcmeClient\r\n', 'ascii')
  const vA = readRegistryEnv('DSH_UI_PROC_NAME', 'HKCU\\Environment', () => ascii)
  check('ASCII 值零行为变化', vA === 'AcmeClient', JSON.stringify(vA))
  check('decodeConsole 对合法 UTF-8 直通', decodeConsole(Buffer.from(CN, 'utf8')) === CN, '')
}

// ---------------------------------------------------------------------------
// 2. 守卫：**任何自定义 userEnv 都必须走共享解码器**（不许再各写一遍 powershell 读法）
// ---------------------------------------------------------------------------
{
  const benchDir = join(REPO, 'bench-runs')
  if (!existsSync(benchDir)) {
    skip('bench-runs 脚本守卫', '目录不存在（未纳入版本管理的调试产物）')
  } else {
    let files = []
    try {
      files = readdirSync(benchDir, { recursive: true })
        .filter((p) => String(p).endsWith('.mjs'))
        .map((p) => join(benchDir, String(p)))
    } catch { files = [] }

    // ⚠ **覆盖面声明**：@codex r34 指出第一版只匹配 `function userEnv(` —— 改名、箭头、内联都能绕过，**它是对的**。
    //   现在改两路：
    //     路 A（名字类）：任何"看起来像在读环境变量"的自定义 helper，**不限写法**。
    //     路 B（idiom 类）：**直接盯危险动作本身**（把 powershell 交给 execFileSync/spawn + 查
    //                      GetEnvironmentVariable），**不依赖 helper 叫什么** ⇒ 改名对它无效。
    //   但这仍不是静态分析器。已知仍可绕过：① 挪到另一个文件再调用；② 用 `node -e` / `.ps1` 代劳
    //   （本仓 `.ps1` 在 PowerShell 进程内读，不跨编码边界，**合法**）；③ 用 `child_process` 别名字段规避字面匹配。
    //   **它的价值是"本仓约定写法一犯就红"，不是"证明不存在这类缺陷"。**
    const HELPER = /(?:userEnv|readEnv|envUser|getEnvVar|readUserEnv)\s*(?:=\s*(?:\(|function)|[(:])/
    const DIRECT_PS = /(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*['"]powershell/i
    const GEV = /GetEnvironmentVariable/

    const offendersA = []
    const offendersB = []
    let withHelper = 0
    for (const f of files) {
      let t = ''
      try { t = readFileSync(f, 'utf8') } catch { continue }
      const importsShared = /env-fallback/.test(t)
      if (HELPER.test(t)) {
        withHelper++
        if (!importsShared) offendersA.push(f.replace(REPO + sep, ''))
      }
      if (DIRECT_PS.test(t) && GEV.test(t) && !importsShared) {
        offendersB.push(f.replace(REPO + sep, ''))
      }
    }
    check('路A（名字类）bench-runs 下自定义环境变量 helper 的脚本都 import 了 env-fallback',
      offendersA.length === 0, offendersA.join(' , '))
    check('路B（idiom 类）没有"直接把 powershell 交给 execFileSync 又查 GetEnvironmentVariable"却不走共享解码器的脚本',
      offendersB.length === 0, offendersB.join(' , '))
    console.log(`       （扫到 ${files.length} 个 .mjs，其中 ${withHelper} 个出现 helper 名；⚠ 已知可绕过：挪到别的文件 / node -e / .ps1 代劳 / child_process 别名）`)
  }
}

// ---------------------------------------------------------------------------
// 3. 守卫：生产代码（plugins/**）不得自己 cross-process 读环境变量
// ---------------------------------------------------------------------------
{
  const pluginsDir = join(REPO, 'plugins')
  const offenders = []
  try {
    const files = readdirSync(pluginsDir, { recursive: true })
      .filter((p) => String(p).endsWith('.mjs') && !String(p).includes('node_modules'))
      .map((p) => join(pluginsDir, String(p)))
    for (const f of files) {
      let t = ''
      try { t = readFileSync(f, 'utf8') } catch { continue }
      // 插件里的 .ps1 是**在 PowerShell 进程内**读环境，不跨编码边界，合法；
      // 这里只看 .mjs（Node → powershell 的跨进程读取）。
      if (/\[System\.Environment\]::GetEnvironmentVariable|\[Environment\]::GetEnvironmentVariable/.test(t)) {
        offenders.push(f.replace(REPO + sep, ''))
      }
    }
  } catch { /* ignore */ }
  check('plugins/**/*.mjs 里没有 GetEnvironmentVariable（应统一走 env-fallback）',
    offenders.length === 0, offenders.join(' , '))
}

// ---------------------------------------------------------------------------
// 4. 真机旁证：本机用户级 DSH_UI_WINDOW_NAME（含中文）读出来不得有替换字符
// ---------------------------------------------------------------------------
{
  const v = process.platform === 'win32' ? envOr('DSH_UI_WINDOW_NAME') : ''
  if (!v) skip('真机 DSH_UI_WINDOW_NAME 读值核对', '本机未配置该变量')
  else check('★ 真机读出的 DSH_UI_WINDOW_NAME 不含 U+FFFD（值以环境为准，不硬编码）',
    !v.includes('\uFFFD'), JSON.stringify(v))
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : `\nPASS: env OEM 编码 + 脚本守卫（F-036）${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failures ? 1 : 0)
