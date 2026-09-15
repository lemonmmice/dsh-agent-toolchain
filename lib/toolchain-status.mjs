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
import { existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { envValue } from './env-fallback.mjs'
import { resolveDumpTools } from './dump-tools.mjs'

// ⚠⚠ **生产路径也必须 fresh**（2026-09-14 夜 R1-01 实测踩到，不是理论风险）：
//   `envValue` 有一个**按名字**的模块级缓存，而它**把负结果（source=missing）也缓存**。
//   宿主是**长活进程**（当晚实测：同一个 node 宿主已跑数小时），于是出现这样一串时序：
//     18:25 调 `toolchain_status`（当时三个证据目录确实没配）⇒ 负结果入缓存
//     18:31 我把 `DSH_PERF_EVIDENCE_DIR` 等写进 HKCU\\Environment
//     18:32 再调 `toolchain_status` ⇒ **仍报「(未配置，来源：missing)」**
//     18:33 同进程直接读注册表 ⇒ 三个值都在
//   ⇒ 工具在拿**几分钟前的缓存**当"现状"回答，而这恰恰是本模块存在的理由（第 17 类：工具在说谎）。
//   诊断类工具是**按需调用**的，多几次 reg query 的代价远小于报一个过期结论 —— 所以这里恒 fresh。
const defaultEv = (n) => { try { return envValue(n, { fresh: true }) } catch { return { name: n, value: '', source: 'missing' } } }

// 进程列表查询（可注入，便于测试 —— 与 envValue 的注入同理）。返回 `tasklist /FO CSV /NH` 的**全量**文本。
//   查不到列表本身时**抛**，让调用方能区分"没查成"与"列表里没有它" ——
//   这正是 r61 要修的口径：**"没查成" ≠ "没在跑"**（"没读到"不许写成"没有"）。
const defaultProcList = () => execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })

/** 解析 tasklist CSV 全量输出为 [{image, pid}]（大小写由调用方处理）。 */
function parseTasklist(txt) {
  const procs = []
  for (const line of String(txt).split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    if (m) procs.push({ image: m[1], pid: Number(m[2]) })
  }
  return procs
}

/** 进程名 basename（去尾部分隔符、取最后一段、剥 .exe）——两种分隔符都吃，不依赖运行平台。 */
function procBaseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/\.exe$/i, '')
}

/**
 * 内容哨兵：**目录存在 ≠ 里面真有源码**（r61 实测：DSH_PERF_SRC_ROOT 指到一个存在、
 *   却不含 AppMain.cs 的目录，旧实现只查 existsSync 就报"可用/能映射 文件:行号"）。
 * 至少要能摸到一个 .sln / .csproj / .cs 才算"像源码根"。限深 + 限量、命中即止：
 *   好目录几乎立刻命中（.sln 通常就在根上），坏目录也只多花有限几次 readdir。
 * 返回 { hit, sample, visited, exhausted }：
 *   · hit=true  找到哨兵文件；
 *   · hit=false 在限深/限量内**没扫到**（注意：是"没扫到" ≠ "确定没有"，措辞要如实）；
 *   · hit=null  连目录内容都读不了（权限等）——同样是"未验证"，不是"空"。
 */
function findSourceSentinel(root, { maxDirs = 200, maxDepth = 6 } = {}) {
  const skip = new Set(['node_modules', '.git', 'bin', 'obj', '.vs', 'packages'])
  const queue = [[root, 0]]
  let visited = 0
  let readAny = false
  while (queue.length) {
    if (visited >= maxDirs) return { hit: false, sample: null, visited, exhausted: true }
    const [dir, depth] = queue.shift()
    visited++
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    readAny = true
    const subdirs = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !skip.has(e.name)) subdirs.push([join(dir, e.name), depth + 1])
      } else if (/\.(sln|csproj|cs)$/i.test(e.name)) {
        return { hit: true, sample: e.name, visited }
      }
    }
    for (const s of subdirs) queue.push(s)      // BFS：先扫浅层（.sln/.csproj 通常就在浅层）
  }
  return { hit: readAny ? false : null, sample: null, visited }
}

/**
 * 目录是不是 **junction / 符号链接**？（R1-10）**三态**：true / false / **null（没读到）**。
 *
 * 为什么必须三态：本仓最硬的那条口径 —— "没读到"不许写成"没有"。
 *   `lstat` 抛（不存在、权限）时返回 null；调用方**不许**把 null 当成 false（"不是链接"）。
 * 为什么用 lstat 而不是 stat：`stat` 会**跟随链接**，永远看不出它是个链接（这正是这个坑难发现的原因）。
 * `realpathSync.native` 拿真实位置 —— junction 与 symlink 都能解析出来。
 */
function dirLinkInfo(p) {
  let st
  try { st = lstatSync(p) } catch { return { isLink: null, target: null } }
  if (!st.isSymbolicLink()) return { isLink: false, target: null }
  let target = null
  try { target = realpathSync.native(p) } catch { target = null }
  return { isLink: true, target }
}

/**
 * junction/符号链接的**代价**说明（R1-10，2026-09-15 用户裁决：**保留 junction**，但工具必须自己说清代价）。
 * 这句话是可复跑的（r61 实测，两次调用同 pattern 对照）：
 *   `glob` 对**链接路径**搜「递归通配 + .etl」（`**` 加 `/*.etl`）⇒ **静默返回 "No files found"**；
 *   同一 pattern 打在**真实路径**（E 盘）⇒ 找得到（r61-diag.etl / r61-dumped.etl）。
 * ⇒ 在链接路径下看到"没有"，是**"没读到"**，不是"不存在"。这个坑不该靠人记住 —— 由自检自己报。
 */
function linkNote(target) {
  return '⚠ 这是 **junction/符号链接**（真实位置：' + (target || '**没读到**（不等于没有）') + '）—— ' +
    '`glob`/`grep` 这类**搜索工具不穿 junction**：对本条路径搜 `**/*.etl` 会**静默返回 "No files found"**（r61 实测），' +
    '同一 pattern 打在真实路径上**找得到**。⇒ 在这里看到"没有"，要读成**"没读到"**，不是"不存在"；要检索请用**真实路径**。'
}

/**
 * 收集一次完整自检。
 *
 * `opts.env` / `opts.exec` 透传给 `envValue` —— **这是为了可测**：
 *   "配了但当前进程没继承"（来源=user）与"从没配过"（来源=missing）必须能分别构造出来验证，
 *   否则那条诚实性承诺就只是注释里的一句话（F-037 的教训：不可测 = 缺陷的温床）。
 * @param {{deep?: boolean, env?: object, exec?: Function, toolsRoot?: string}} [opts]
 */
export function buildToolchainStatus({ deep = false, env, exec, toolsRoot, procList } = {}) {
  // ⚠ `fresh: true`：`envValue` 有一个**按名字**的模块级缓存，它**不看注入的 env/exec**。
  //   我第一版没传 fresh，于是"用 A 的 exec 读一次、再用 B 的 exec 读一次"时，
  //   第二次**直接命中缓存**拿到 A 的结果 —— 测试里表现为"没配也读到了值"（我自己的用例当场抓到）。
  //   凡是带注入的调用都必须 fresh，否则注入是假的。
  //   ⚠ 当时只修了**注入**这条路，把 `defaultEv`（生产路）漏了 —— 同一个坑在四个月后以
  //     "宿主长活 + 负缓存"的形态又咬了一次（R1-01）；两条路现在都 fresh。
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
  // ★ r61 头号缺陷：旧实现**只查 DSH_UI_PROC_NAME 这一个名字**，查不到就一口咬定"未在运行"——
  //   而真机上客户端（ClientApp, pid 7632）正在跑，只是 DSH_UI_PROC_NAME 漂成了 OtherApp。
  //   于是"没查到这个名字"被写成了"客户端没开"（本仓最硬的那条：**"没读到"被写成"没有"**）。
  // 修法：① 候补名**全从配置推导**（不硬编码任何产品名）—— DSH_UI_PROC_NAME / DSH_UI_CLIENT_EXE 的
  //   basename / DSH_BUILD_CLIENT_PROC / DSH_UI_PROC_CANDIDATES；② 扫一遍：配置名没中但候补中了 ⇒
  //   明说"配置可能不匹配"，**绝不等价于"没开"**；③ 真的一个都没中，才说"未发现候选进程"，且列出扫了哪些名；
  //   ④ 连进程列表都没查成（tasklist 失败）⇒ 说"没查成"，**不写成"没在跑"**。
  const listProcs = procList || defaultProcList
  const procEnv = ev('DSH_UI_PROC_NAME')
  const procName = (procEnv.value || '').trim()
  const candidates = []            // [{name, from}]，去重（大小写不敏感）
  const pushCand = (raw, from) => {
    const n = procBaseName(raw)
    if (n && !candidates.some((c) => c.name.toLowerCase() === n.toLowerCase())) candidates.push({ name: n, from })
  }
  pushCand(procName, 'DSH_UI_PROC_NAME')
  const exeEnv = ev('DSH_UI_CLIENT_EXE')
  if (exeEnv.value) pushCand(exeEnv.value, 'DSH_UI_CLIENT_EXE')      // 另一处配置里就藏着真实进程名
  const buildProcEnv = ev('DSH_BUILD_CLIENT_PROC')
  if (buildProcEnv.value) pushCand(buildProcEnv.value, 'DSH_BUILD_CLIENT_PROC')
  const candEnv = ev('DSH_UI_PROC_CANDIDATES')
  if (candEnv.value) for (const p of String(candEnv.value).split(/[,;]/)) pushCand(p, 'DSH_UI_PROC_CANDIDATES')

  if (candidates.length === 0) {
    add('client', '目标客户端进程', '(未配置 DSH_UI_PROC_NAME)', procEnv.source || 'missing', false,
      '不知道要观察哪个进程（DSH_UI_PROC_NAME / DSH_UI_CLIENT_EXE 都没给）',
      '设置 DSH_UI_PROC_NAME（你的客户端进程名，如 AcmeClient），或直接给 DSH_UI_CLIENT_EXE')
  } else {
    const scannedDesc = candidates.map((c) => c.name + '（来自 ' + c.from + '）').join('、')
    let procs = null              // null = 连进程列表都没查成（≠ "没在跑"）
    try { procs = parseTasklist(listProcs()) } catch { procs = null }
    if (procs === null) {
      add('client', '目标客户端进程', '进程列表查询失败（无法判断是否在运行）',
        procEnv.source || 'missing', false,
        '**没能执行进程列表查询（tasklist）** —— 这是"没查成"，**不等于"客户端没开"**；本应扫描：' + scannedDesc,
        '在目标主机上确认 tasklist 可用后复验（当前配置 DSH_UI_PROC_NAME=' + (procName || '未配置') + '）')
    } else {
      const hitOf = (name) => procs.find((p) => p.image.toLowerCase() === (name + '.exe').toLowerCase())
      const running = candidates.map((c) => ({ ...c, hit: hitOf(c.name) })).filter((c) => c.hit)
      const primaryHit = procName ? hitOf(procName) : null
      if (primaryHit) {
        // (b) 配置名对、进程在跑 ⇒ 正常报 pid
        add('client', '目标客户端进程', primaryHit.image + ' pid=' + primaryHit.pid,
          procEnv.source || 'missing', true, '抓 dump / 探针都打这个进程', '')
      } else if (running.length) {
        // (a) 配置名查不到、但候补在跑 ⇒ **配置可能不匹配**（绝不能说"没开"）
        const others = running.map((c) => c.hit.image + '(pid=' + c.hit.pid + '，候补来自 ' + c.from + ')').join('、')
        const fix = running.map((c) => procBaseName(c.hit.image)).join(' / ')
        add('client', '目标客户端进程',
          '配置的进程名 ' + (procName || '(未配置)') + ' 未检测到，但发现候选进程在跑：' + others,
          procEnv.source || 'missing', false,
          '**配置可能不匹配**：DSH_UI_PROC_NAME=' + (procName || '(未配置)') + ' 查不到，但 ' + others +
            ' 正在运行 —— 很可能就是目标客户端，只是进程名配置漂了（r61 实测：配了 OtherApp，实跑 ClientApp）。' +
            '这**不是**"客户端没开"；已扫描：' + scannedDesc,
          '把 DSH_UI_PROC_NAME 改成实际在跑的进程名（候选：' + fix + '）；或用 ui_* 的 procId 参数直接指定')
      } else {
        // 真扫遍了也没有 ⇒ 才能说"未发现候选进程在运行"，且写明扫了哪些名字
        add('client', '目标客户端进程',
          '未发现候选进程在运行（已扫描：' + candidates.map((c) => c.name).join(' / ') + '）',
          procEnv.source || 'missing', false,
          '下列名字都不在跑：' + scannedDesc + '。卡死/卡顿类诊断现在无从下手。' +
            '（"未发现" = 这几个名字都没查到 ≠ "机器上没有客户端"；若客户端用别的进程名，补进 DSH_UI_PROC_NAME 或 DSH_UI_PROC_CANDIDATES）',
          '先启动客户端；或确认进程名（当前 DSH_UI_PROC_NAME=' + (procName || '未配置') + '）')
      }
    }
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
    if (!existsSync(r.value)) {
      add(name, name + '（源码根）', r.value, r.source || 'missing', false,
        '**路径存在性检查失败** —— 配了但那个目录不在（这和"没配"是两回事）',
        '核对 ' + name + ' 的实际值：' + r.value)
      continue
    }
    // ★ r61 二号缺陷：目录**存在** ≠ 里面**有源码**。旧实现只查 existsSync 就报"可用/能映射 文件:行号"，
    //   而真机上 DSH_PERF_SRC_ROOT 指到一个存在、却不含 AppMain.cs 的目录 —— "可用" 是空头支票。
    //   现在必须过一个**内容哨兵**（.sln/.csproj/.cs）：deep 有精确 .cs 计数就用它，否则做一次限深探测。
    let csCount = null
    if (deep) {
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
    const sentinel = deep
      ? { hit: csCount === null ? null : csCount > 0, sample: null, visited: null }
      : findSourceSentinel(r.value)
    const contentOk = sentinel.hit === true
    const shown = csCount !== null ? '（' + csCount + ' 个 .cs）'
      : (contentOk && sentinel.sample ? '（含 ' + sentinel.sample + '）' : '')
    if (contentOk) {
      add(name, name + '（源码根）', r.value + shown, r.source || 'missing', true,
        name === 'DSH_PERF_SRC_ROOT'
        // r53：两个源根**能力不同**，不能用同一句话 —— perf 侧只有 **dump 通路**做源码映射，
        //   ETW 调用链不做（G1 黑盒正是把这句话读成「配了它 perf_hotstacks 就有行号」）。
        ? '可用：能把 **dump 通路**（perf_dump / perf_analyze 的栈帧）映射到 文件:行号（行号是**方法声明处**）；⚠ **ETW 调用链（perf_hotstacks）不做源码映射**，只到 模块!类型.方法'
        : '可用：能把栈帧映射到 文件:行号（行号是**方法声明处**）', '')
    } else {
      // 目录在、却摸不到任何 .sln/.csproj/.cs ⇒ **绝不报"可用"**。降级成"目录存在（内容未验证）"，
      //   并写清它意味着什么：既不等于"能映射行号"，也不等于"这里没有源码"（没扫到 ≠ 没有）。
      const why = sentinel.hit === null
        ? '目录内容读不了（权限等），无法确认里面是否有源码'
        : '在此目录下' + (sentinel.visited ? '（限深扫描 ' + sentinel.visited + ' 个子目录）' : '') +
          '没找到任何 .sln/.csproj/.cs' + (deep ? '（deep 全量计数：0 个 .cs）' : '')
      add(name, name + '（源码根）', r.value + '（内容未验证）', r.source || 'missing', false,
        '**目录存在，但内容未验证** —— ' + why + '。' +
        '"目录存在"**不等于**"能映射 文件:行号"：路径可能指错了层级、或指到了空壳（r61 实测踩到）。' +
        '这也**不等于**"这里没有源码"—— 没扫到 ≠ 没有，请核对是不是**真正含 .csproj 的那一层**',
        '核对 ' + name + ' 是否指向**真正含 .csproj 的源码根**（当前：' + r.value + '）；可用 deep=true 数一遍 .cs 进一步确认')
    }
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
  // ★ R1-10（2026-09-15 用户裁决：**保留 junction**，但工具必须自己说清它的代价）：
  //   本机把 `~/.dsh-agent-toolchain/*` 做成了指向 E: 的 junction（省 C 盘）。代价是**搜索不穿 junction**：
  //   在那儿搜 `**/*.etl` 会**静默返回空** —— 于是"没读到"极易被读成"不存在"（本仓最硬那条的反面）。
  //   这个坑靠人记是记不住的，所以由自检**自己报**：是链接就印真实位置 + 那句口径。
  //   ⚠ 三态：true=是 / false=不是 / null=**没读到**（null 不许写成 false）。
  //   ⚠ 未配置时也查**内置默认目录**（本机那个默认目录正好就是 junction —— 不查等于漏掉最常见的那个）。
  const DEFAULT_EVIDENCE = { DSH_PERF_EVIDENCE_DIR: 'perf-evidence', DSH_HANG_EVIDENCE_DIR: 'hang-evidence' }
  for (const [name, label] of [['DSH_PERF_EVIDENCE_DIR', 'perf 证据目录'], ['DSH_HANG_EVIDENCE_DIR', '卡死证据目录']]) {
    const r = ev(name)
    const configured = Boolean(r.value)
    const path = configured ? r.value : join(homedir(), '.dsh-agent-toolchain', DEFAULT_EVIDENCE[name])
    const exists = existsSync(path)
    let entries = null
    if (exists && deep) { try { entries = readdirSync(path).length } catch { entries = null } }
    const info = dirLinkInfo(path)
    const linkPart = info.isLink === true ? '；' + linkNote(info.target)
      : (info.isLink === null && exists ? '；⚠ 没能读到这个路径的链接属性（**"没读到" ≠ "不是链接"**）' : '')
    add(name, label, (configured ? path : '(未配置，用内置默认)') + (entries !== null ? '（' + entries + ' 个条目）' : ''),
      r.source || 'missing', configured ? exists : true,
      configured
        ? (exists ? '可用' : '目录不存在（工具会在写入时创建）') + linkPart
        : '未配置时用工具内置默认目录（' + path + '），不影响使用' +
          (info.isLink === true ? '；' + linkNote(info.target) : ''), '')
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
