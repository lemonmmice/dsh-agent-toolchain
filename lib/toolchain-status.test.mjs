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
import { envValue, resetEnvCache } from './env-fallback.mjs'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
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

// r61 源码根内容哨兵用的两个临时目录：一个**真有源码**（含 .csproj），一个**存在但空壳**（只有 readme）。
//   —— "目录存在" ≠ "里面有源码"，这正是二号缺陷；哨兵必须认前者、拒后者。
const srcRootWithCs = mkdtempSync(join(tmpdir(), 'tcs-src-ok-'))
writeFileSync(join(srcRootWithCs, 'Demo.csproj'), '<Project/>', 'utf8')
const srcRootEmpty = mkdtempSync(join(tmpdir(), 'tcs-src-empty-'))
writeFileSync(join(srcRootEmpty, 'readme.txt'), 'no source here', 'utf8')

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

  // 构造"三件都齐"：进程名 + 源码根（用**真有源码**的目录，含 .csproj —— r61 后光"存在"不算数）+ 三件套路径
  const realDir = REPO
  const envOk = {
    DSH_UI_PROC_NAME: 'definitely-not-running-xyz',
    DSH_HANG_SRC_ROOT: srcRootWithCs,                   // 内容哨兵会认它（有 Demo.csproj）
    DSH_HANG_PROCDUMP: join(REPO, 'package.json'),      // 存在即可（只查存在性）
    DSH_HANG_DUMPSTACK: join(REPO, 'package.json'),
    DSH_HANG_DAC_DIR: realDir,
  }
  const withEnv = buildToolchainStatus({ env: envOk, exec: fakeExec, procList: () => '' })  // 空进程表 ⇒ 客户端确定性"没在跑"
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

// ---------------------------------------------------------------------------
// 7. ★★ R1-01（2026-09-14 夜，真机踩到的缺陷）：**生产路径不许把缓存里的旧值当现状**
//
// 实测时序（宿主是长活进程，当时那个 node 已跑数小时）：
//   18:25 调 `toolchain_status`（那三个证据目录当时确实没配）⇒ **负结果进了 envValue 的按名缓存**
//   18:31 把 `DSH_PERF_EVIDENCE_DIR` / `DSH_HANG_EVIDENCE_DIR` / `DSH_BUILD_LOGS_DIR` 写进 HKCU\Environment
//   18:32 再调 `toolchain_status` ⇒ **仍报「(未配置，来源：missing)」**
//   18:33 同一个进程里直接读注册表 ⇒ 三个值都在
// ⇒ 工具拿**几分钟前缓存**当"现状"回答 —— 正是本模块要消灭的第 17 类"工具在说谎"。
//
// 这一段**故意关掉测试硬闸**：`DSH_NO_ENV_FALLBACK=1` 时 `envValue` 连缓存都不看
//   （env-fallback.mjs 里闸判断在缓存判断**之前**）⇒ 缺陷根本复现不出来，
//   那样写出来的用例会是"永远绿的假证据"。关掉闸只影响本段，且全程**只读**
//   （buildToolchainStatus 只做 tasklist / existsSync / reg query，不写不杀）。
// ---------------------------------------------------------------------------
{
  const gate = process.env.DSH_NO_ENV_FALLBACK
  const savedEv = process.env.DSH_PERF_EVIDENCE_DIR
  resetEnvCache()
  delete process.env.DSH_NO_ENV_FALLBACK      // 复现需要真实走「进程环境 → 缓存 → 注册表」这条路
  delete process.env.DSH_PERF_EVIDENCE_DIR    // 保证第一步（直接读进程环境）不会命中
  try {
    // 预置一个**假的旧值**，等价于"本进程早先读过一次、当时用户还没配"：
    // 注入的 exec 让它与真机注册表完全无关（换台机器结论不变）。
    envValue('DSH_PERF_EVIDENCE_DIR', {
      env: {},
      exec: () => Buffer.from('    DSH_PERF_EVIDENCE_DIR    REG_SZ    C:\\primed\\fake-old\r\n', 'ascii'),
    })
    const st = buildToolchainStatus()            // ← **生产路径**（不带任何注入）
    const it = st.items.find((i) => i.key === 'DSH_PERF_EVIDENCE_DIR')
    check('★★ 生产路径不许把"缓存里的旧值"当现状（R1-01：宿主长活 + 负缓存 ⇒ 报过期结论）',
      !String(it && it.value).includes('C:\\primed\\fake-old'), JSON.stringify(it))
    let txt = ''
    try { txt = renderToolchainStatus(st) } catch (e) { txt = 'THREW: ' + String(e.message || e) }
    check('★ 渲染出来的人读文本里也不许出现那个旧值（agent 读的正是这段）',
      !txt.includes('C:\\primed\\fake-old'), String(txt).slice(0, 200))
    // 结构断言：行为断言靠的就是生产路径传了 fresh —— 把它钉死，免得被"顺手优化"掉。
    const src = readFileSync(join(REPO, 'lib', 'toolchain-status.mjs'), 'utf8')
    check('★★ 生产路径的 defaultEv 必须显式传 fresh: true',
      /envValue\(n, \{ fresh: true \}\)/.test(src), '')
    check('★ 且注释里写明为什么（免得后人当成多余参数删掉）',
      /生产路径也必须 fresh|生产路径也必须\s*fresh/.test(src), '')
  } finally {
    if (gate === undefined) delete process.env.DSH_NO_ENV_FALLBACK; else process.env.DSH_NO_ENV_FALLBACK = gate
    if (savedEv === undefined) delete process.env.DSH_PERF_EVIDENCE_DIR; else process.env.DSH_PERF_EVIDENCE_DIR = savedEv
    resetEnvCache()
  }
}

// ---------------------------------------------------------------------------
// 8. ★★ r61 头号缺陷：客户端进程检查**不许把"没查到这个名字"写成"客户端没开"**
//    真机现场：DSH_UI_PROC_NAME 漂成 OtherApp（没在跑），而客户端 ClientApp(pid 7632) 真在跑，
//    旧实现只查那一个名字、查不到就报"未在运行" —— 首问即骗人。
//    进程列表全程**注入**（与真机无关，换台机器结论不变）。
// ---------------------------------------------------------------------------
{
  const listWithNiugu = () =>
    '"ClientApp.exe","7632","Console","1","120,000 K"\r\n"svchost.exe","900","Services","0","10,000 K"\r\n'

  // (a) 配置名错、候补在跑 ⇒ 必须说"配置可能不匹配"，且**不含**"未在运行"式否定
  const a = buildToolchainStatus({
    env: { DSH_UI_PROC_NAME: 'OtherApp', DSH_UI_CLIENT_EXE: 'C:\\Apps\\ClientApp.exe' },
    exec: fakeExec, procList: listWithNiugu,
  })
  const ca = a.items.find((i) => i.key === 'client')
  const caStr = ca ? ca.value + ca.note : ''
  check('★★ (a) 配置名 OtherApp 查不到、但 ClientApp 在跑 ⇒ 结论含"配置可能不匹配"',
    /配置可能不匹配/.test(caStr), JSON.stringify(ca))
  check('★★ (a) 且**不含**"未在运行"式否定（绝不许等价于"客户端没开"）',
    ca && !/未在运行/.test(caStr), JSON.stringify(ca))
  check('★ (a) 点出真在跑的进程名+pid（ClientApp / 7632）并标明候补来源',
    ca && /ClientApp\.exe/.test(ca.value) && /7632/.test(ca.value) && /DSH_UI_CLIENT_EXE/.test(caStr), JSON.stringify(ca))

  // (b) 配置名对、进程在跑 ⇒ 正常报 pid（✓）
  const b = buildToolchainStatus({ env: { DSH_UI_PROC_NAME: 'ClientApp' }, exec: fakeExec, procList: listWithNiugu })
  const cb = b.items.find((i) => i.key === 'client')
  check('★★ (b) 配置名对、进程在跑 ⇒ client 为 ✓ 且报出 pid',
    cb && cb.ok === true && /ClientApp\.exe pid=7632/.test(cb.value), JSON.stringify(cb))

  // (c) 候选全不在跑 ⇒ 才说"未发现候选进程"，且**列出扫了哪些名字**（不是光秃秃一句否定）
  const c = buildToolchainStatus({
    env: { DSH_UI_PROC_NAME: 'OtherApp', DSH_UI_PROC_CANDIDATES: 'ClientApp,Foo' },
    exec: fakeExec, procList: () => '"svchost.exe","900","Services","0","10,000 K"\r\n',
  })
  const cc = c.items.find((i) => i.key === 'client')
  check('★ (c) 候选全不在跑 ⇒ client 为 ✗，明说"未发现候选进程"并列出扫过的名字',
    cc && cc.ok === false && /未发现候选进程/.test(cc.value) && /OtherApp/.test(cc.value) && /ClientApp/.test(cc.value), JSON.stringify(cc))
  check('★ (c) 措辞守住"没查到 ≠ 机器上没有客户端"（没读到不许写成没有）',
    cc && /≠|不等于/.test(cc.note || ''), JSON.stringify(cc))

  // (d) 连进程列表都没查成（tasklist 抛）⇒ 说"没查成"，**不写成"没在跑"**
  const d = buildToolchainStatus({
    env: { DSH_UI_PROC_NAME: 'ClientApp' }, exec: fakeExec,
    procList: () => { throw new Error('tasklist unavailable') },
  })
  const cd = d.items.find((i) => i.key === 'client')
  check('★★ (d) 进程列表查询失败 ⇒ 明说"没查成/不等于客户端没开"，且不含"未在运行"式断言',
    cd && cd.ok === false && /没查成/.test(cd.note || '') && !/未在运行/.test(cd.value + cd.note), JSON.stringify(cd))
}

// ---------------------------------------------------------------------------
// 9. ★★ r61 二号缺陷：源码根"目录存在"**不足以**判"可用" —— 至少要有内容哨兵（.sln/.csproj/.cs）
//    真机现场：DSH_PERF_SRC_ROOT 指到一个存在、却不含 AppMain.cs 的目录，却被报"可用/能映射 文件:行号"。
// ---------------------------------------------------------------------------
{
  // 存在但没有任何 .cs/.csproj/.sln ⇒ **绝不出现"可用"**，降级为"内容未验证"，且 ok=false
  const bad = buildToolchainStatus({ env: { DSH_PERF_SRC_ROOT: srcRootEmpty }, exec: fakeExec })
  const rb = bad.items.find((i) => i.key === 'DSH_PERF_SRC_ROOT')
  check('★★ 目录存在但无源码 ⇒ 源码根**不是** ✓（不许把空壳当可用）', rb && rb.ok === false, JSON.stringify(rb))
  check('★★ 判据：目录存在但内容不对 ⇒ **绝不出现"可用"**',
    rb && !/可用/.test(rb.value + rb.note), JSON.stringify(rb))
  check('★ 降级措辞明说"内容未验证"，并守住"没扫到 ≠ 没有"',
    rb && /内容未验证/.test(rb.value + rb.note) && /≠|不等于/.test(rb.note || ''), JSON.stringify(rb))
  const badLine = renderToolchainStatus(bad).split('\n').find((l) => /DSH_PERF_SRC_ROOT（源码根）/.test(l)) || ''
  check('★ 渲染给 agent 读的那一行也不含"可用"', !/可用/.test(badLine), badLine)

  // 存在且含 .csproj ⇒ 内容哨兵通过 ⇒ ✓ 且 note 说"可用"
  const good = buildToolchainStatus({ env: { DSH_HANG_SRC_ROOT: srcRootWithCs }, exec: fakeExec })
  const rg = good.items.find((i) => i.key === 'DSH_HANG_SRC_ROOT')
  check('★★ 目录存在且含 .csproj ⇒ 源码根为 ✓ 且 note 含"可用"',
    rg && rg.ok === true && /可用/.test(rg.note || ''), JSON.stringify(rg))
  check('★ ✓ 时把摸到的哨兵文件带出来（让人知道凭什么判"可用"）',
    rg && /Demo\.csproj/.test(rg.value), JSON.stringify(rg))
}

// ---------------------------------------------------------------------------
// 10. ★ R1-10（2026-09-15 用户裁决：**保留 junction**，但工具必须**自报**它的代价）
//
// 背景：本机把 `~/.dsh-agent-toolchain/*` 做成了指向 E: 的 junction（省 C 盘）。代价是
//   **搜索不穿 junction** —— r61 实测：对链接路径用 `glob` 搜 `**/*.etl` ⇒ **静默返回 "No files found"**；
//   同一 pattern 打在**真实路径**（E 盘）⇒ 找得到（r61-diag.etl / r61-dumped.etl）。
//   ⇒ 在那儿看到"没有"，其实是**"没读到"** —— 正是本仓最硬那条口径的反面，会直接把结论带偏。
// 所以自检必须自己说三件事：① 这是链接；② 真实位置在哪；③ 那句口径。
// ⚠ 用**临时目录里现造的 junction** 测，不读本机任何真实配置（换台机器结论不变）。
// ⚠ 也**不**断言"未配置时的内置默认目录一定是/不是链接" —— 那会变成"断言机器全局状态"（本仓第 3 类教训）。
// ---------------------------------------------------------------------------
{
  const real = mkdtempSync(join(tmpdir(), 'tcs-ev-real-'))
  writeFileSync(join(real, 'r61-diag.etl'), 'x', 'utf8')          // 放个真文件：用来证明收尾没顺着链接删目标
  const linkParent = mkdtempSync(join(tmpdir(), 'tcs-ev-link-'))
  const link = join(linkParent, 'perf-evidence')
  let made = false
  try { symlinkSync(real, link, 'junction'); made = true } catch (e) {
    // 造不出 junction ⇒ 这条判据**没被验证**。按本仓口径报红，**绝不静默跳过**（"没跑" ≠ "通过"）。
    failures++
    console.log('  FAIL 无法创建 junction（本机权限？）：' + String((e && e.message) || e) + ' ⇒ R1-10 的判据本轮未被验证')
  }
  if (made) {
    const st = buildToolchainStatus({ env: { DSH_PERF_EVIDENCE_DIR: link }, exec: fakeExec })
    const it = st.items.find((i) => i.key === 'DSH_PERF_EVIDENCE_DIR')
    const note = String((it && it.note) || '')
    check('★★ junction 被认出来（值里仍是用户配的那条链接路径）', it && it.value.includes(link), JSON.stringify(it))
    check('★★ 印出**真实位置**（只说"是链接"而不说指到哪儿 = 没用）', note.includes(real), note.slice(0, 220))
    check('★★ 把"搜索不穿 junction"这句口径印出来，并守住"没读到 ≠ 没有"',
      /不穿 junction/.test(note) && /没读到/.test(note), note.slice(0, 300))
    check('★ 链接**不是缺陷**：ok 仍为 true（不制造假警报 —— 假警报与假绿灯一样有害）',
      it && it.ok === true, JSON.stringify(it && it.ok))
    // ⚠ 这条要**钉在"用户配的那条路径"上**：只断言"渲染文本里有这句话"是不够的 ——
    //   本机未配置的那一项（内置默认目录）本身就是 junction，会让这条断言**靠机器状态**变绿
    //   （本仓明令：测试不许依赖机器全局状态）。所以取**含这条链接路径的那一行**，再看它**紧随的 note 行**。
    const lines = renderToolchainStatus(st).split('\n')
    const idx = lines.findIndex((l) => l.includes(link))
    check('★ 渲染给 agent 读的那段里也有（且就挂在**这条**证据目录的 note 行上）',
      idx >= 0 && /不穿 junction/.test(String(lines[idx + 1] || '')),
      idx < 0 ? '(渲染里找不到那条路径)' : String(lines[idx] + ' /// ' + (lines[idx + 1] || '(没有 note 行)')).slice(0, 240))

    // ★★ 反向对照：**真实目录不许**出现这句 —— 否则这条提醒就是"恒真的噪声"，等于没提醒
    const st2 = buildToolchainStatus({ env: { DSH_PERF_EVIDENCE_DIR: real }, exec: fakeExec })
    const it2 = st2.items.find((i) => i.key === 'DSH_PERF_EVIDENCE_DIR')
    check('★★ 反向对照：真实目录**不许**报 junction 提醒（否则它恒真 = 等于没报）',
      it2 && !/junction/.test(String(it2.note || '')), JSON.stringify(it2 && it2.note))

    // ★ 目录不存在 ⇒ 报"目录不存在"，**不许**臆造链接属性（也不许写"不是链接"这种没依据的话）
    const st3 = buildToolchainStatus({ env: { DSH_PERF_EVIDENCE_DIR: join(linkParent, 'nope-not-here') }, exec: fakeExec })
    const it3 = st3.items.find((i) => i.key === 'DSH_PERF_EVIDENCE_DIR')
    check('★ 目录不存在 ⇒ 明说"目录不存在"，且**不**宣称它是/不是链接',
      it3 && it3.ok === false && /目录不存在/.test(String(it3.note)) && !/junction/.test(String(it3.note)), JSON.stringify(it3))
  }
  // 收尾：先摘 reparse point（rmdir 只摘链接本身），再删两个临时目录
  try { if (made) rmdirSync(link) } catch { /* 摘不掉不影响结论 */ }
  try { rmSync(linkParent, { recursive: true, force: true }) } catch { /* 同上 */ }
  check('★ 收尾后真实目录里的文件**还在**（确保清理没顺着 junction 把目标删掉）', existsSync(join(real, 'r61-diag.etl')), '')
  try { rmSync(real, { recursive: true, force: true }) } catch { /* 同上 */ }
}

// 清理临时源码根（测试进程退出前顺手删掉）
try { rmSync(srcRootWithCs, { recursive: true, force: true }); rmSync(srcRootEmpty, { recursive: true, force: true }) } catch { /* 删不掉不影响结论 */ }

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : '\nPASS: toolchain_status（E3/F-042：环境自检 —— 且它自己不许说谎）')
process.exit(failures ? 1 : 0)
