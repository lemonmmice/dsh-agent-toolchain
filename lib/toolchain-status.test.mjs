// `toolchain_status`（环境/前置条件自检，E3 / F-042）—— 集成 + **诚实性**断言。
//
// 由来（两个互相隔离的黑盒 agent 独立提出同一个要求）：
//   ① 全新会话的子 agent 只凭工具面走完三个场景后明确写：「散落着 DSH_HANG_SRC_ROOT /
//      DSH_PERF_SYMBOL_PATH / DSH_UI_CLIENT_EXE 以及"需管理员"硬前置，**却没有任何工具能查其当前值**」；
//   ② @codex 的 P0 普查把 E3（统一 health 工具）标成 **"能力缺失，不是测试没找到"**。
//   后果具体：源码根没配 ⇒ 只能给方法名、给不出 文件:行号 —— 而用户最想要的就是那一行。
//
// 本文件除了"它能跑"，重点测**它会不会说谎** —— 这是它存在的全部意义：
//   · 每个值必须带**来源**（进程环境 / 用户级 / 未配置），"配了但没继承"与"没配过"必须**可区分**；
//   · 每个 ✗ 必须带下一步（除非那项本来就"不配也能用"，此时不许报 ✗ 吓人）；
//   · 检查不到的（如接口→VM 归因）必须明说"无法自检"，**不许假装 true**；
//   · 实现只有**一份**（在 lib/），插件里不许再抄一遍。
import { buildToolchainStatus, renderToolchainStatus } from './toolchain-status.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ── 自检：断言器不能恒真 ──
{
  let sawFail = false
  const probe = (c) => { if (!c) sawFail = true }
  probe(false)
  console.log((sawFail ? '  ok   ' : '  FAIL ') + '（自检）断言器有效')
  if (!sawFail) failures++
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

// 全程用**注入**的 env/exec，不读本机真实配置（否则测试结果随机器状态变）。
const fakeExec = () => { throw new Error('no registry') }

// ---------------------------------------------------------------------------
// 1. ★ 诚实性：**"配了但没继承" 与 "从没配过" 必须说成两句话**
// ---------------------------------------------------------------------------
{
  // 进程环境里没有 → 回退注册表 → 我们让注册表"读到"一个值 ⇒ source 应为 user，且 inherited=false
  const execUser = (file, args) => {
    const name = String(args[args.length - 1] || '')
    if (name === 'DSH_HANG_SRC_ROOT') return Buffer.from(
      '    DSH_HANG_SRC_ROOT    REG_SZ    C:\\src\\client\r\n', 'ascii')
    throw new Error('not found')
  }
  const a = buildToolchainStatus({ env: {}, exec: execUser })
  const rootA = a.items.find((i) => i.key === 'DSH_HANG_SRC_ROOT')
  check('★ 值取自注册表时，来源标成 user（不是 missing、也不是 process）',
    rootA && rootA.source === 'user', JSON.stringify(rootA))
  check('★ 且**不会**被当成"没配过"', rootA && rootA.value.includes('C:\\src\\client'), JSON.stringify(rootA && rootA.value))

  const b = buildToolchainStatus({ env: {}, exec: fakeExec })
  const rootB = b.items.find((i) => i.key === 'DSH_HANG_SRC_ROOT')
  check('★★ 真的没配时才是 missing（两种情形必须可区分 —— 这正是 F-010/G2 那类"工具在说谎"的根源）',
    rootB && rootB.source === 'missing' && rootB.value === '(未配置)', JSON.stringify(rootB))
}

// ---------------------------------------------------------------------------
// 2. ★ 每个 ✗ 都要给下一步；而"不配也能用"的项不许报 ✗
// ---------------------------------------------------------------------------
{
  const st = buildToolchainStatus({ env: {}, exec: fakeExec })
  const bad = st.items.filter((i) => !i.ok)
  check('★ 有 ✗ 项时，nextSteps 非空（不许只说"缺"不说"怎么办"）', bad.length === 0 || st.nextSteps.length > 0,
    '✗=' + bad.length + ' next=' + st.nextSteps.length)
  check('★ 没有 ✗ 项时 nextSteps 应为空（不许无病呻吟）', bad.length > 0 || st.nextSteps.length === 0,
    '✗=' + bad.length + ' next=' + st.nextSteps.length)

  const sym = st.items.find((i) => i.key === 'symbols')
  check('★ 符号未配置**不该**报 ✗ 吓人（它本来就"不配也能跑"），但 note 要说清代价',
    sym && sym.ok === true && /也能跑/.test(sym.note || ''), JSON.stringify(sym))

  const ev0 = st.items.find((i) => i.key === 'DSH_PERF_EVIDENCE_DIR')
  check('★ 证据目录未配置也算 ✓（会用内置默认），并说明不影响使用',
    ev0 && ev0.ok === true && /默认/.test(ev0.note || ''), JSON.stringify(ev0))
}

// ---------------------------------------------------------------------------
// 3. ★★ "检查不到" 必须显式标出来，**不许假装 true**
// ---------------------------------------------------------------------------
{
  const st = buildToolchainStatus({ env: {}, exec: fakeExec })
  const api = st.readyFor.apiCallerAttribution
  check('★★ 接口→ViewModel 归因必须是 ok=null（无法自检），**不是 true**',
    api && api.ok === null, JSON.stringify(api))
  check('★ 并且说明为什么（需要客户端侧旁路日志）+ 提醒"0 条 ≠ 没有"',
    api && /uiprobe-caller|无法自检/.test(api.note) && /不等于|≠/.test(api.note), String(api && api.note))
}

// ---------------------------------------------------------------------------
// 4. ★★ 汇总必须由**实际项**推导（不许硬编码"可以"）
// ---------------------------------------------------------------------------
{
  const noClient = buildToolchainStatus({ env: {}, exec: fakeExec })
  check('★★ 什么都没配 ⇒ hangCodeEvidence.ok 必须是 false（并逐项列出缺什么）',
    noClient.readyFor.hangCodeEvidence.ok === false, JSON.stringify(noClient.readyFor.hangCodeEvidence))
  check('★ needs 里逐项可读（client / sourceRoot / dumpTools）',
    noClient.readyFor.hangCodeEvidence.needs
    && 'client' in noClient.readyFor.hangCodeEvidence.needs
    && 'sourceRoot' in noClient.readyFor.hangCodeEvidence.needs
    && 'dumpTools' in noClient.readyFor.hangCodeEvidence.needs,
    JSON.stringify(noClient.readyFor.hangCodeEvidence.needs))

  // 构造"三件都齐"：进程名 + 源码根（用真实存在的目录）+ 三件套路径
  const realDir = REPO
  const envOk = {
    DSH_UI_PROC_NAME: 'definitely-not-running-xyz',
    DSH_HANG_SRC_ROOT: realDir,
    DSH_HANG_PROCDUMP: join(REPO, 'package.json'),      // 存在即可（只查存在性）
    DSH_HANG_DUMPSTACK: join(REPO, 'package.json'),
    DSH_HANG_DAC_DIR: realDir,
  }
  const withEnv = buildToolchainStatus({ env: envOk, exec: fakeExec })
  const r = withEnv.items.find((i) => i.key === 'DSH_HANG_SRC_ROOT')
  check('★ 注入后源码根那一项变成 ✓（说明汇总确实是算出来的）', r && r.ok === true, JSON.stringify(r))
  check('★ 进程名配了但进程没在跑 ⇒ client 项为 ✗（"配了" ≠ "在跑"）',
    (withEnv.items.find((i) => i.key === 'client') || {}).ok === false, '')
}

// ---------------------------------------------------------------------------
// 5. render 必须能跑通且包含三条目标结论
// ---------------------------------------------------------------------------
{
  const st = buildToolchainStatus({ env: {}, exec: fakeExec })
  let txt = ''
  try { txt = renderToolchainStatus(st) } catch (e) { txt = 'THREW: ' + String(e.message || e) }
  check('★ renderToolchainStatus 不抛', !txt.startsWith('THREW:'), txt.slice(0, 120))
  check('★ 渲染文本含三条目标结论（卡死→行号 / 卡顿→调用链 / 接口→VM）',
    /卡死 → 线程栈 → 文件:行号/.test(txt) && /卡顿 → ETW 调用链/.test(txt) && /接口 → 调用方 ViewModel/.test(txt),
    txt.slice(0, 200))
  check('★ 渲染文本逐项带来源（agent 能看见"这个值是哪儿来的"）', /来源：/.test(txt), '')
}

// ---------------------------------------------------------------------------
// 6. ★★ 同一件事只有**一份**实现（第 24 类缺陷）：插件里不许再抄一遍
// ---------------------------------------------------------------------------
{
  const plugin = readFileSync(join(REPO, 'plugins', 'dsh-verify', 'index.js'), 'utf8')
  check('★★ dsh-verify 只做壳：不许自己实现 buildToolchainStatus',
    !/function buildToolchainStatus/.test(plugin), '插件里又抄了一份实现')
  check('★ 插件通过动态 import 取共享实现（保住"被单独拷贝也不炸"的设计）',
    /import\('\.\.\/\.\.\/lib\/toolchain-status\.mjs'\)/.test(plugin), '')
  const mcp = readFileSync(join(REPO, 'mcp', 'server.mjs'), 'utf8')
  check('★ MCP 面 import 的是同一份 lib（两面行为一致 = E4 的精神）',
    /import \{ buildToolchainStatus \} from '\.\.\/lib\/toolchain-status\.mjs'/.test(mcp), '')
  check('★ lib 里确实导出了两个函数', existsSync(join(REPO, 'lib', 'toolchain-status.mjs'))
    && /export function buildToolchainStatus/.test(readFileSync(join(REPO, 'lib', 'toolchain-status.mjs'), 'utf8'))
    && /export function renderToolchainStatus/.test(readFileSync(join(REPO, 'lib', 'toolchain-status.mjs'), 'utf8')), '')
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : '\nPASS: toolchain_status（E3/F-042：环境自检 —— 且它自己不许说谎）')
process.exit(failures ? 1 : 0)
