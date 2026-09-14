// dsh-api-visualizer：**改系统代理这条路径**的安全回归（F-037，2026-09-12 r34，读代码查出）。
//
// 病（不是理论问题 —— 本机用户当前就是 `ProxyEnable=1`、`ProxyServer=127.0.0.1:6518`）：
//   旧 `readSystemProxy()` 分三次 `reg query /v <name>`，**同一个 try/catch** 包住，
//   任何一步失败都 `catch {}` 后返回默认值 `{enable:false, server:'', override:''}` ——
//   把"**没读到**"和"**读到就是没有**"压成同一个返回值。而它唯一的消费者 `setSystemProxy()`
//   拿这个返回值当**备份**：
//     · 备份记成"用户没开代理" ⇒ 恢复时写 `ProxyEnable=0` ⇒ **关掉用户真实的代理**，
//       而且这份错备份还会落盘 `sysproxy-backup.json` 持久化（错会一直传下去）；
//     · 更短的一条：**从没备份过**就调 `setSystemProxy(false)`，旧实现走 `backup === null`
//       分支直接写 `ProxyEnable=0` —— "我们没动过它，却把它关了"。
//
// 本文件用**注入**（regWriter / winInetRefresh / sysProxyReader）复现这两条路径，
// **绝不碰真实注册表**：所有写入都进数组，写完即断言"该写几次、写了什么"。
import { ProxyEngine, readSystemProxy } from '../lib/proxy-engine.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function skip(name, why) { console.log('  SKIP ' + name + ' — ' + why) }

// ── 0. 自检：断言器本身不能是"恒真"的（本仓反复踩过的空断言坑）──
//    注意：**不要**用 `check()` 来做这件事 —— 那会在输出里留下一行 `FAIL`，
//    读输出的人会以为真有一项失败（我第一版就这么写的）。改为直接记账、只印一行 ok。
{
  const before = failures
  let sawFail = false
  const probe = (cond) => { if (!cond) sawFail = true }
  probe(false)
  const delta = sawFail ? 1 : 0
  const after = failures + 0
  failures = before
  console.log((delta === 1 && after === before ? '  ok   ' : '  FAIL ')
    + '（自检）断言器有效 —— 否则本文件后面的绿都是假的')
  if (!(delta === 1 && after === before)) failures++
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'proxy-engine.mjs'), 'utf8')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-sysproxy-'))
const backupFile = () => join(tmp, 'sysproxy-backup.json')

/** 造一个"代理已启动"的引擎（不真起 server），并把三个危险动作全部注入为纯记录。 */
function mkEngine({ readResult = null } = {}) {
  const writes = []
  const refreshes = []
  const engine = new ProxyEngine({
    certDir: tmp,
    port: 48899,
    upstream: null,
    onRecord: () => {},
    regWriter: async (arg) => { writes.push(arg); return true },
    winInetRefresh: async () => { refreshes.push(Date.now()); return true },
    sysProxyReader: () => (readResult !== null ? readResult : readSystemProxy()),
  })
  engine.server = { fake: true } // setSystemProxy 要求 running
  return { engine, writes, refreshes }
}

// ---------------------------------------------------------------------------
// 1. ★★ 从没备份过就"恢复" ⇒ 必须**什么都不写**（旧实现在这里写 ProxyEnable=0）
// ---------------------------------------------------------------------------
{
  try { rmSync(backupFile(), { force: true }) } catch { /* ignore */ }
  const { engine, writes } = mkEngine()
  const r = await engine.setSystemProxy(false)
  check('★★ 无备份时 setSystemProxy(false) **不写注册表**（旧实现会写 ProxyEnable=0 关掉用户的代理）',
    writes.length === 0, 'writes=' + JSON.stringify(writes))
  check('★ 且**如实回报**拒绝原因（不是静默成功）',
    r.refused === true && r.reason === 'no-backup' && typeof r.error === 'string' && r.error.length > 20,
    JSON.stringify(r).slice(0, 200))
  check('拒绝时不声称 restored（避免"恢复了"的错觉）', r.restored === null, JSON.stringify(r.restored))
}

// ---------------------------------------------------------------------------
// 2. ★★ 备份读不到 ⇒ 拒绝启用（不能拿一份假备份去覆盖真实设置）
// ---------------------------------------------------------------------------
{
  try { rmSync(backupFile(), { force: true }) } catch { /* ignore */ }
  const { engine, writes } = mkEngine({ readResult: { ok: false, reason: 'reg-query-failed', enable: false, server: '', override: '' } })
  const r = await engine.setSystemProxy(true)
  check('★★ 备份不可信时 setSystemProxy(true) **拒绝启用**且不写注册表', writes.length === 0 && r.refused === true,
    'writes=' + JSON.stringify(writes) + ' r=' + JSON.stringify(r).slice(0, 160))
  check('★ 拒绝理由点名"读不到"（而不是含糊的失败）',
    r.reason === 'backup-unreadable' && /读不到/.test(String(r.error)), String(r.error).slice(0, 120))
  check('★ 拒绝时不落盘备份文件（不把假备份持久化）', !existsSync(backupFile()), backupFile())
}

// ---------------------------------------------------------------------------
// 3. ★★ 正常往返：备份**逐字节**写回（含中文绕过条目 —— 编码不许弄坏它）
// ---------------------------------------------------------------------------
{
  try { rmSync(backupFile(), { force: true }) } catch { /* ignore */ }
  const CN_OVERRIDE = '*.示例.internal;<local>'
  const good = { ok: true, enable: true, server: '127.0.0.1:6518', override: CN_OVERRIDE }
  const { engine, writes } = mkEngine({ readResult: good })

  const on = await engine.setSystemProxy(true)
  check('启用成功且把系统代理指向本引擎', on.enabled === true && writes.length === 1 && writes[0].server === '127.0.0.1:48899',
    JSON.stringify(writes))
  check('★ 启用的同时保留用户原有的**中文绕过条目**（没被编码弄坏）',
    writes[0].override === CN_OVERRIDE, JSON.stringify(writes[0].override))

  const off = await engine.setSystemProxy(false)
  check('★★ 恢复把原值**逐字节**写回（enable/server/override 三项都对）',
    writes.length === 2 && writes[1].enable === true && writes[1].server === '127.0.0.1:6518' && writes[1].override === CN_OVERRIDE,
    JSON.stringify(writes[1]))
  check('★ 恢复回的是**用户原来的** enable=true（旧实现会把它写成 false）', writes[1].enable === true, String(writes[1].enable))
  check('恢复结果如实体现在返回值里', off.restored && off.restored.server === '127.0.0.1:6518', JSON.stringify(off.restored))
}

// ---------------------------------------------------------------------------
// 4. ★ readSystemProxy：**一次整键查询**，把"值不存在"与"读失败"分开
// ---------------------------------------------------------------------------
{
  if (process.platform !== 'win32') {
    skip('readSystemProxy 注入用例', '非 Windows')
  } else {
    const KEY_TEXT = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:6518',
      '    ProxyOverride    REG_SZ    localhost;<local>',
    ].join('\r\n')

    const okRes = readSystemProxy({ exec: () => KEY_TEXT })
    check('★ 整键读到 ⇒ ok=true，三项都解析出来', okRes.ok === true && okRes.enable === true && okRes.server === '127.0.0.1:6518',
      JSON.stringify(okRes))
    check('★ 缺 ProxyOverride 时 ok 仍为 true（**值不存在 ≠ 读失败**）',
      readSystemProxy({ exec: () => 'x\r\n    ProxyEnable    REG_DWORD    0x1\r\n' }).ok === true, '')
    check('★ 缺 ProxyEnable 时 enable=false 但 ok=true（这是真实的"没设"，不是读失败）',
      (() => { const r = readSystemProxy({ exec: () => 'x\r\n    ProxyServer    REG_SZ    1.2.3.4:80\r\n' }); return r.ok === true && r.enable === false })(), '')

    const bad = readSystemProxy({ exec: () => { throw new Error('reg.exe missing') } })
    check('★★ reg 失败 ⇒ ok=false（**不许**伪装成默认值 {false,\'\',\'\'}）',
      bad.ok === false && bad.reason === 'reg-query-failed', JSON.stringify(bad))
    check('★ ok=false 时给出可执行的 detail', typeof bad.detail === 'string' && bad.detail.length > 10, String(bad.detail))

    // OEM 码页：`示例窗口` 的 GBK 字节（与 `reg.exe` 实际输出同源）
    const gbk = Buffer.concat([
      Buffer.from('x\r\n    ProxyOverride    REG_SZ    ', 'ascii'),
      Buffer.from([0xCA, 0xBE, 0xC0, 0xFD, 0xB4, 0xB0, 0xBF, 0xDA]),
      Buffer.from('\r\n', 'ascii'),
    ])
    check('★ 注入 Buffer 时按 OEM 解码（中文绕过条目不被弄成 U+FFFD）',
      (() => { const r = readSystemProxy({ exec: () => gbk }); return r.ok === true && r.override === '示例窗口' })(), '')
  }
}

// ---------------------------------------------------------------------------
// 5. 源码守卫：旧的那两处危险分支不许回来
// ---------------------------------------------------------------------------
{
  check('★ 源码里不再有 `backup === null || backup.server === \'\'` 这种"没备份也去恢复"的分支',
    !/backup\s*===\s*null\s*\|\|\s*backup\.server\s*===\s*''/.test(SRC), '旧分支回来了')
  check('★ 源码里不再有"读失败即静默返回默认值"的三连 reg query 写法',
    !/result\.enable\s*=\s*m\s*!==\s*null/.test(SRC), '')
  check('★ 恢复路径必须走 this.regWriter（可注入 = 可测）',
    /await this\.regWriter\(\{ enable: backup\.enable/.test(SRC), '')
  check('★ 无备份分支必须 return 而不是继续写', /reason: 'no-backup'/.test(SRC) && /current: this\.readSysProxy\(\)/.test(SRC), '')
  check('★ 用共享的 OEM 解码器（不许自己写第二份解码）', /import \{ decodeConsole \} from '\.\.\/\.\.\/\.\.\/lib\/env-fallback\.mjs'/.test(SRC), '')
}

try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(failures
  ? `\nFAILED: ${failures} 项`
  : '\nPASS: 改系统代理的安全回归（F-037：不许拿不可信备份去写用户的注册表）')
process.exit(failures ? 1 : 0)
