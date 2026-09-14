/**
 * 环境/前置条件自检（`toolchain_status`）—— **两个面共用这一份实现**。
 *
 * ★ 为什么有它（2026-09-12 r35→r36，**两个互相隔离的黑盒 agent 独立提出同一个要求**）：
 *   ① 我派一个全新会话的子 agent、只给它"agent 能看到的一切"（工具名+description+schema），
 *      它对三个真实场景走完之后的原话是：
 *      「散落着 `DSH_HANG_SRC_ROOT` / `DSH_PERF_SYMBOL_PATH` / `DSH_UI_CLIENT_EXE` / `DSH_UI_DENY_RE`
 *       以及"需管理员"硬前置，**却没有任何工具能查其当前值** → 想要 `toolchain_status` / `doctor`。」
 *   ② @codex 的 P0 普查把清单里的 **E3（统一 health 工具）** 标成 **"能力缺失，不是测试没找到"**。
 *
 *   后果很具体、而且正好打在用户的核心诉求上：
 *   **源码根没配 ⇒ `hang_analyze` 只能给方法名、给不出 `文件:行号`** —— 而用户最想要的就是那一行。
 *   在此之前 agent 只能**反复试错**，或者干脆告诉用户"拿不到代码级证据"，却说不清缺什么。
 *
 * 设计原则（沿用本仓一贯的诚实口径）：
 *   ① **每个值都带来源**（进程环境 / 用户级注册表 / 机器级 / 未配置）——
 *      不把"配了但当前进程没继承"说成"没配过"（那是 F-010/G2 那类"工具在说谎"）；
 *   ② **每个"缺"都给下一步**（该设哪个变量、设成什么形态）；
 *   ③ **检查不到就说检查不到**，不假装 ✓；
 *   ④ 默认**浅查**（只确存在性）；`deep=true` 才做计数这类重活。
 *
 * 为什么放在 `lib/` 而不是某个插件里：DSH 面与 MCP 面都要有（清单 E4 要求两面一致），
 * 而**同一件事不许有第二份实现**（第 24 类缺陷）。两面的壳各自 import 这一份。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { envValue } from './env-fallback.mjs'
import { resolveDumpTools } from './dump-tools.mjs'

const defaultEv = (n) => { try { return envValue(n) } catch { return { name: n, value: '', source: 'missing' } } }

/**
 * 收集一次完整自检。
 *
 * `opts.env` / `opts.exec` 透传给 `envValue` —— **这是为了可测**：
 *   "配了但当前进程没继承"（来源=user）与"从没配过"（来源=missing）必须能分别构造出来验证，
 *   否则那条诚实性承诺就只是注释里的一句话（F-037 的教训：不可测 = 缺陷的温床）。
 * @param {{deep?: boolean, env?: object, exec?: Function, toolsRoot?: string}} [opts]
 */
export function buildToolchainStatus({ deep = false, env, exec, toolsRoot } = {}) {
  // ⚠ `fresh: true`：`envValue` 有一个**按名字**的模块级缓存，它**不看注入的 env/exec**。
  //   我第一版没传 fresh，于是"用 A 的 exec 读一次、再用 B 的 exec 读一次"时，
  //   第二次**直接命中缓存**拿到 A 的结果 —— 测试里表现为"没配也读到了值"（我自己的用例当场抓到）。
  //   凡是带注入的调用都必须 fresh，否则注入是假的。
  const injected = env !== undefined || exec !== undefined
  const ev = injected
    ? ((n) => { try { return envValue(n, { env, exec, fresh: true }) } catch { return { name: n, value: '', source: 'missing' } } })
    : defaultEv
  const out = { checkedAt: new Date().toISOString(), items: [], readyFor: {}, warnings: [], nextSteps: [] }
  const add = (key, label, value, source, ok, note, next) => {
    out.items.push({ key, label, value, source, ok, note })
    if (!ok && next) out.nextSteps.push(next)
  }

  // ---- 1. 目标客户端进程（只看，不动）----
  const procEnv = ev('DSH_UI_PROC_NAME')
  const procName = (procEnv.value || '').trim()
  if (!procName) {
    add('client', '目标客户端进程', '(未配置 DSH_UI_PROC_NAME)', procEnv.source || 'missing', false,
      '不知道要观察哪个进程',
      '设置 DSH_UI_PROC_NAME（你的客户端进程名，如 AcmeClient），或直接给 DSH_UI_CLIENT_EXE')
  } else {
    let pid = null
    try {
      const txt = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + procName + '.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true })
      const m = /"[^"]*\.exe","(\d+)"/.exec(txt)
      if (m) pid = Number(m[1])
    } catch { /* 拿不到就当没找到；下面 note 如实写 */ }
    add('client', '目标客户端进程',
      pid ? (procName + '.exe pid=' + pid) : (procName + '.exe 未在运行'),
      procEnv.source || 'missing', pid !== null,
      pid ? '抓 dump / 探针都打这个进程' : '进程不在，卡死/卡顿类诊断现在无从下手',
      pid ? '' : '先启动客户端；或确认 DSH_UI_PROC_NAME 与实际进程名一致（当前：' + procName + '）')
  }

  // ---- 2. 源码根（决定能不能给到「文件:行号」）----
  for (const name of ['DSH_HANG_SRC_ROOT', 'DSH_PERF_SRC_ROOT']) {
    const r = ev(name)
    if (!r.value) {
      add(name, name + '（源码根）', '(未配置)', r.source || 'missing', false,
        '没有它就只能给方法名，给不出 文件:行号',
        '设置 ' + name + ' 指向**客户端源码的根目录**（即包含各 .csproj 的那一层）—— 这是"代码级证据"的硬前提')
      continue
    }
    const exists = existsSync(r.value)
    let csCount = null
    if (exists && deep) {
      try {
        const walk = (d, acc) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) {
              if (!['node_modules', '.git', 'bin', 'obj'].includes(e.name)) walk(join(d, e.name), acc)
            } else if (/\.cs$/i.test(e.name)) acc.n++
          }
          return acc
        }
        csCount = walk(r.value, { n: 0 }).n
      } catch { csCount = null }
    }
    add(name, name + '（源码根）', r.value + (csCount !== null ? '（' + csCount + ' 个 .cs）' : ''),
      r.source || 'missing', exists,
      exists ? (name === 'DSH_PERF_SRC_ROOT'
      // r53：两个源根**能力不同**，不能用同一句话 —— perf 侧只有 **dump 通路**做源码映射，
      //   ETW 调用链不做（G1 黑盒正是把这句话读成「配了它 perf_hotstacks 就有行号」）。
      ? '可用：能把 **dump 通路**（perf_dump / perf_analyze 的栈帧）映射到 文件:行号（行号是**方法声明处**）；⚠ **ETW 调用链（perf_hotstacks）不做源码映射**，只到 模块!类型.方法'
      : '可用：能把栈帧映射到 文件:行号（行号是**方法声明处**）')
             : '**路径存在性检查失败** —— 配了但那个目录不在（这和"没配"是两回事）',
      exists ? '' : '核对 ' + name + ' 的实际值：' + r.value)
  }

  // ---- 3. dump 三件套 ----
  try {
    const tools = resolveDumpTools({
      procdumpEnv: ['DSH_HANG_PROCDUMP', 'DSH_PERF_PROCDUMP'],
      dumpstackEnv: ['DSH_HANG_DUMPSTACK', 'DSH_PERF_DUMPSTACK'],
      dacEnv: ['DSH_HANG_DAC_DIR', 'DSH_PERF_DAC_DIR'],
      toolsRoot: join(homedir(), '.dsh-agent-toolchain', 'tools'),
    })
    add('procdump', 'procdump（抓 dump）', tools.procdump || '(未解析到)', tools.origins.procdump || '',
      tools.procdumpExists,
      tools.procdumpExists ? '可抓全 dump（会让客户端挂起几秒）' : '抓不了 dump ⇒ 拿不到线程栈 ⇒ 卡死只能给模块级线索',
      tools.procdumpExists ? '' : '设 DSH_HANG_PROCDUMP / DSH_PERF_PROCDUMP 指向 procdump.exe')
    add('dumpstack', 'DumpStack（解线程栈）', tools.dumpstack || '(未解析到)', tools.origins.dumpstack || '',
      tools.dumpstackExists,
      tools.dumpstackExists ? '能把 dump 解成托管线程栈' : 'dump 抓到了也分析不了',
      tools.dumpstackExists ? '' : '把它放在 procdump 旁边的 dumpstack\\publish-x86\\ 下，或设 DSH_*_DUMPSTACK')
    add('dacDir', 'DAC 目录（匹配 CLR 版本）', tools.dacDir || '(未解析到)', tools.origins.dacDir || '',
      tools.dacDirExists,
      tools.dacDirExists ? '与客户端 CLR 版本匹配的 mscordacwks 就位' : '缺它可能解析不出托管栈',
      tools.dacDirExists ? '' : '设 DSH_*_DAC_DIR，或放在 procdump 同级的 dac\\ 下')
    for (const w of tools.warnings) out.warnings.push(w)
  } catch (e) {
    out.warnings.push('解析 dump 三件套时出错：' + String(e && e.message ? e.message : e))
  }

  // ---- 4. 符号（ETW 出调用链的关键）----
  {
    const r = ev('DSH_PERF_SYMBOL_PATH')
    // ★ `ok` 恒为 true：**不配符号不是"缺"** —— ETW 照样能跑（xperf 会去公网取）。
    //   我第一版写成 `Boolean(r.value)`，结果它报了一个 ✗ —— 那是在**制造假警报**，
    //   而假警报和假绿灯一样有害（会让人去修一个不需要修的东西）。代价写进 note 就够了。
    add('symbols', 'DSH_PERF_SYMBOL_PATH（符号，可选）', r.value || '(未配置)', r.source || 'missing', true,
      r.value ? 'ETW 报告能解析出函数名；**这个变量是整串替换、不是追加** —— 想把客户端自己的 pdb 一起加进来，' +
                '必须自己写成 `srv*<缓存>*https://msdl.microsoft.com/download/symbols;<pdb 目录>`，只写目录会把系统 DLL 的符号全部丢掉'
              : '**不配也能跑**：xperf 会去微软公网取符号（首次可能几十分钟、上 GB，且跨运行共享同一缓存）—— 配了会快很多；' +
                '客户端的 pdb 就在它的构建产物目录里（实测 16 个），要用它同样得**接在** srv* 链后面（该变量是整串替换）',
      '')
  }

  // ---- 5. 管理员（ETW 内核会话的前提）----
  {
    let isAdmin = false
    try {
      execFileSync('net', ['session'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
      isAdmin = true
    } catch { isAdmin = false }
    add('admin', '管理员权限（ETW 采样前提）', isAdmin ? '是' : '否', 'process', isAdmin,
      isAdmin ? 'perf_trace（ETW）可用' : '**perf_trace 会失败** —— ETW 需要内核会话',
      isAdmin ? '' : '以管理员身份运行 DSH（或用 perf_dump + perf_analyze 这条不需要管理员的路线）')
  }

  // ---- 6. 证据目录 ----
  for (const [name, label] of [['DSH_PERF_EVIDENCE_DIR', 'perf 证据目录'], ['DSH_HANG_EVIDENCE_DIR', '卡死证据目录']]) {
    const r = ev(name)
    if (!r.value) {
      add(name, label, '(未配置，用内置默认)', r.source || 'missing', true, '未配置时用工具内置默认目录，不影响使用', '')
      continue
    }
    const exists = existsSync(r.value)
    let entries = null
    if (exists && deep) { try { entries = readdirSync(r.value).length } catch { entries = null } }
    add(name, label, r.value + (entries !== null ? '（' + entries + ' 个条目）' : ''), r.source || 'missing', exists,
      exists ? '可用' : '目录不存在（工具会在写入时创建）', '')
  }

  // ---- 7. 汇总：**针对目标**回答"现在能不能拿到代码级证据" ----
  const by = (k) => out.items.find((i) => i.key === k)
  const okOf = (k) => Boolean(by(k) && by(k).ok)
  const clientOk = okOf('client')
  const rootOk = okOf('DSH_HANG_SRC_ROOT') || okOf('DSH_PERF_SRC_ROOT')
  const dumpOk = okOf('procdump') && okOf('dumpstack')
  const adminOk = okOf('admin')
  out.readyFor = {
    hangCodeEvidence: {
      ok: clientOk && rootOk && dumpOk,
      needs: { client: clientOk, sourceRoot: rootOk, dumpTools: dumpOk },
      note: '"卡死 → 线程栈 → 文件:行号"这条路',
    },
    etwCallChain: {
      ok: adminOk,
      needs: { admin: adminOk },
      note: '不带符号也能跑，但函数名多为 ***unknown***；要客户端方法名需给它带 pdb',
    },
    apiCallerAttribution: {
      ok: null,
      note: '**无法自检**：需要客户端侧提供 %TEMP%\\uiprobe-caller.log。查不到归因时，0 条 ≠ "没有这种调用"',
    },
  }
  if (!out.readyFor.hangCodeEvidence.ok) {
    out.nextSteps.push('要让「卡死 → 文件:行号」这条路通，逐项补齐上面标 ✗ 的前置条件（客户端在跑 / 源码根 / dump 三件套）')
  }
  return out
}

/** 把自检结果渲染成人读的一段话（agent 优先读这段）。 */
export function renderToolchainStatus(v) {
  if (!v) return '环境自检：无结果'
  if (v.error) return '环境自检不可用：' + v.error
  const line = (i) => (i.ok ? '  ✓ ' : '  ✗ ') + i.label + ' = ' + i.value
    + (i.source ? '（来源：' + i.source + '）' : '') + (i.note ? '\n      ' + i.note : '')
  const rf = v.readyFor || {}
  const yn = (b) => (b === true ? '可以' : b === false ? '**还不行**' : '无法自检')
  return [
    '环境自检（' + v.checkedAt + '）',
    '',
    '【能不能拿到代码级证据】',
    '  · 卡死 → 线程栈 → 文件:行号：' + yn(rf.hangCodeEvidence && rf.hangCodeEvidence.ok),
    '  · 卡顿 → ETW 调用链：' + yn(rf.etwCallChain && rf.etwCallChain.ok),
    '  · 接口 → 调用方 ViewModel：' + yn(rf.apiCallerAttribution && rf.apiCallerAttribution.ok)
      + (rf.apiCallerAttribution ? '（' + rf.apiCallerAttribution.note + '）' : ''),
    '',
    '【逐项】',
    ...(v.items || []).map(line),
    ...(v.nextSteps && v.nextSteps.length ? ['', '【下一步】', ...v.nextSteps.map((s, i) => '  ' + (i + 1) + '. ' + s)] : []),
    ...(v.warnings && v.warnings.length ? ['', '【警告】', ...v.warnings.map((s) => '  ⚠ ' + s)] : []),
  ].join('\n')
}
