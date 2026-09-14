/**
 * 代码新鲜度自检 —— 「我正在跑的是不是我磁盘上那份代码？」
 *
 * 为什么需要它（F-007，全轮最贵的一个坑）：
 *   DSH 宿主是**长活进程**，插件代码只在启动时加载一次，**不热加载**。
 *   于是「改完 → 部署到 profile → 工具行为却还是旧的」这件事没有任何信号：
 *   agent 会拿着旧行为当真，把它当成"修复没生效/功能不存在"，用户也会看到旧界面。
 *   本轮的每一个修复都撞在这堵墙上 —— 只有把这件事变成**工具自己说出来的事实**，
 *   才不会再有人（人或 agent）误读。
 *
 * 判据（刻意保持朴素、可证伪）：
 *   本进程的启动时间 = Date.now() - process.uptime()*1000。
 *   如果插件目录里有文件的 mtime **晚于**进程启动时间，那么那份文件就是在加载之后才写下的 →
 *   进程里跑的**一定不是**它。
 *
 * 判据二（Claude 第九轮 Q2 抓到的真漏洞，2026-09-11）：
 *   **Windows 上 copyFileSync/CopyFileW 会保留源文件的 mtime** —— 部署到 profile 时，
 *   profile 里那份文件的 mtime 等于**仓库里被编辑的时刻**，不是部署时刻。于是
 *   「改码 → 重启宿主 → 再部署」这种顺序下，mtime 判据会**漏报**（改码时间早于宿主启动时间）。
 *   所以部署脚本会写一份**部署戳**（profile/.dsh-toolchain-deploy.json，含部署时刻）；
 *   只要 `部署时刻 > 进程启动时刻`，就说明**磁盘上的这份内容比进程加载的更新**，与 mtime 无关。
 *   两条判据各自独立，任一条成立即判陈旧，并回报是**哪一条**成立的。
 *
 * 边界（诚实标注）：
 *   · 只看 mtime + 部署戳，无法判断"内容是否真的有变化"。宁可多报"可能陈旧"，
 *     也不要用内容哈希猜 —— 猜错的方向是"以为是最新的"，那正是要防的。
 *   · 老文件被**删除**、或代码被改在**别处**，本检查看不见（所以要扫多个根目录，见 moduleRoots）。
 *   · 本检查只对**当前进程**成立：MCP server 是短命进程（每次连接新起），它自己的检查永远是"新"，
 *     而**长活的 DSH 宿主**是否陈旧它看不见 —— 这种情况必须由 `surface: 'mcp'` 显式说明（见 staleCodeInfo）。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 本进程的启动时间（毫秒）。 */
export function processStartedAtMs() {
  const up = typeof process.uptime === 'function' ? process.uptime() : 0
  return Date.now() - Math.round(up * 1000)
}

/**
 * 这份代码被加载时要扫的**所有**根目录。
 *
 * 为什么不能只扫插件自己的目录（Q2 的第二半）：工具实际加载的代码是三处 ——
 *   ① 插件目录（plugins/dsh-x/…）；② **共享 lib/**（code-freshness 自己、dump-tools、decode…）；
 *   ③ MCP 面的 mcp/server.mjs。只扫 ① 时，改了共享 lib 或 MCP 入口却报"代码是最新的"。
 * 传进来的 pluginDir 通常是 `plugins/dsh-x/lib` 或 `plugins/dsh-x`，其 `../..` 就是仓库/profile 根。
 */
export function moduleRoots(pluginDir) {
  const roots = [pluginDir]
  // 目录层级因调用方而异（真机验证过一次"看起来对、其实少扫一层"）：
  //   · profile：`<profile>/plugins/dsh-x/lib` → 根是 lib 的**三级**上（`<profile>/lib` 才是共享 lib）
  //   · 仓库  ：`<repo>/plugins/dsh-perf/lib`  → 同样三级上（`<repo>/lib`、`<repo>/mcp`）
  //   · 直接传插件根 `<...>/dsh-x`            → 根是两级上
  // 所以三个层级都试，**只收真实存在的目录**（不存在的不收，免得报一堆假根）。
  for (const up of ['..', join('..', '..'), join('..', '..', '..')]) {
    for (const sub of ['lib', 'mcp']) {
      const p = join(pluginDir, up, sub)
      if (!roots.includes(p) && existsSync(p)) roots.push(p)
    }
  }
  return roots
}

/** 部署戳的候选位置：从每个扫描根往上找 1~3 层（部署脚本写在**根**上：`<profile>/.dsh-toolchain-deploy.json`）。 */
export function deployStampCandidates(roots) {
  const out = []
  for (const r of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
    for (const up of ['..', join('..', '..'), join('..', '..', '..')]) {
      const p = deployStampPath(join(r, up))
      if (!out.includes(p)) out.push(p)
    }
  }
  return out
}

/** 部署戳路径（由 scripts/deploy-plugins.mjs 写入）。 */
export function deployStampPath(rootDir) {
  return join(rootDir, '.dsh-toolchain-deploy.json')
}

/**
 * 当前进程是哪个面？'mcp' = 短命的 MCP server（每次连接新起）；'plugin' = 长活 DSH 宿主里的插件。
 *
 * 依据 `process.argv[1]`（MCP server 就是以 `node mcp/server.mjs` 起的，也可被 DSH 直接 spawn）。
 * 判错方向的代价不对称：把 plugin 判成 mcp 会多一句"宿主可能陈旧"的提示（无害）；
 * 把 mcp 判成 plugin 会让 MCP 面**静默地**给出"我不陈旧"的假安慰（有害）—— 所以拿不准时偏向 mcp。
 */
export function detectSurface(argv = process.argv) {
  const entry = String((argv && argv[1]) || '')
  return /[\\/]mcp[\\/]server\.mjs$/i.test(entry) ? 'mcp' : 'plugin'
}

/** 读部署戳；没有/坏了都返回 null（不是错误，只是没有这条判据）。 */
export function readDeployStamp(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const at = Date.parse(j.at || '')
    if (!Number.isFinite(at)) return null
    return { atMs: at, file, count: j.count ?? null, target: j.target ?? null }
  } catch {
    return null
  }
}

/** 递归取目录里最新的 mtime（跳 node_modules）。返回 { mtimeMs, file } 或 null。 */
function newestFileIn(dir, depth = 0) {
  if (depth > 6) return null
  let best = null
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    // **测试目录/测试文件不算**（2026-09-11，Codex 第十轮实测带出）：
    //   扫描 profile 时，最新文件常常是 `test/tree-empty.test.mjs` 这种 —— 它**永远不会被宿主加载**，
    //   却把"代码陈旧"的信号盖住：八个插件目录全部报陈旧，而真正决定行为的是 lib/ 下的那几个文件。
    //   一个抓陈旧的自检，如果被无关文件淹没，就等于没抓。
    if (e.isDirectory()) {
      if (e.name === 'test' || e.name === 'tests' || e.name === '__tests__') continue
      const sub = newestFileIn(join(dir, e.name), depth + 1)
      if (sub && (!best || sub.mtimeMs > best.mtimeMs)) best = sub
      continue
    }
    if (/\.test\.(mjs|js|cjs)$/.test(e.name)) continue
    try {
      const st = statSync(join(dir, e.name))
      if (!best || st.mtimeMs > best.mtimeMs) best = { mtimeMs: st.mtimeMs, file: join(dir, e.name) }
    } catch {
      // 文件在遍历中消失：忽略（它也不可能比进程启动更早被加载）
    }
  }
  return best
}

/**
 * @param {string} dir 插件目录（通常 `import.meta.dirname`）
 * @param {object} [opts]
 *   · graceMs        允许的时钟误差/写入延迟（默认 1500ms）
 *   · processStartMs 指定"加载时刻"（默认取本进程启动时间）。
 *     **外部检查器**用它：从另一个进程判断"**那个**长活进程是不是在跑旧代码"
 *     （例：宿主的启动时间来自 Get-Process，而不是我自己的 uptime）。
 * @returns {{stale:boolean, startedAtMs:number, newestFile:string|null, newestMtimeMs:number|null, graceMs:number}}
 */
export function codeFreshness(dir, opts = {}) {
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 1500
  // **fail loud**：明确传了 processStartMs 却不是有限数，绝不悄悄退回"本进程启动时间"。
  // 实测教训：外部检查器把宿主的 CreationDate 解析成 NaN 之后，这里静默改用了检查器自己的
  // 启动时刻 → 每个目录都报"一致"，一个 100% 错误的"一切正常"。
  // 一个用来抓陈旧的检查器，最不该做的就是自己给出假阴性。
  if (opts.processStartMs !== undefined && !Number.isFinite(opts.processStartMs)) {
    throw new TypeError('codeFreshness: processStartMs 必须是有限数（收到 ' + String(opts.processStartMs) + '）—— 不要退回本进程启动时间，那会给出假阴性')
  }
  const startedAtMs = Number.isFinite(opts.processStartMs) ? opts.processStartMs : processStartedAtMs()
  // dir 可以是数组（moduleRoots 的产物）：取所有根里最新的那个文件
  const dirs = (Array.isArray(dir) ? dir : [dir]).filter(Boolean)
  let newest = null
  for (const d of dirs) {
    const n = newestFileIn(d)
    if (n && (!newest || n.mtimeMs > newest.mtimeMs)) newest = n
  }
  const mtimeStale = !!(newest && newest.mtimeMs > startedAtMs + graceMs)

  // 判据二：部署戳（免疫 CopyFileW 保留 mtime）
  const stampFiles = Array.isArray(opts.stampFiles)
    ? opts.stampFiles
    : (opts.stampFile ? [opts.stampFile] : deployStampCandidates(dirs))
  let stamp = null
  for (const f of stampFiles) {
    const s = readDeployStamp(f)
    if (s && (!stamp || s.atMs > stamp.atMs)) stamp = s
  }
  const stampStale = !!(stamp && stamp.atMs > startedAtMs + graceMs)

  return {
    stale: mtimeStale || stampStale,
    // 哪条判据成立的（可证伪的诊断信息，别让调用方只能猜）
    reason: stampStale ? (mtimeStale ? 'mtime+deploy-stamp' : 'deploy-stamp') : (mtimeStale ? 'mtime' : null),
    startedAtMs,
    newestFile: newest ? newest.file : null,
    newestMtimeMs: newest ? newest.mtimeMs : null,
    deployStampAtMs: stamp ? stamp.atMs : null,
    deployStampFile: stamp ? stamp.file : null,
    scannedRoots: dirs,
    graceMs,
  }
}

/**
 * 给调用方直接贴的说明行（不陈旧时返回 null —— 不刷噪音）。
 * @param {string} dir 插件目录
 * @param {string} [what] 这个插件/工具的名字，用于把话说清楚
 */
export function staleCodeNote(dir, what = '本插件', opts = {}) {
  let info
  try {
    info = codeFreshness(dir, opts)
  } catch {
    return null
  }
  if (!info.stale) return null
  const ageMin = info.newestMtimeMs ? Math.round((Date.now() - info.newestMtimeMs) / 60000) : null
  // 说清是**哪条判据**成立的：部署戳成立而 mtime 不成立，正是「改码→重启→再部署」这一序
  // （CopyFileW 保留源 mtime，所以只看 mtime 会漏报，见本文件顶部判据二）。
  const why = info.reason === 'deploy-stamp'
    ? '磁盘文件在本进程启动**之后**才被部署进来（部署时刻 ' +
      (info.deployStampAtMs ? new Date(info.deployStampAtMs).toISOString() : '?') + '，晚于进程启动 ' +
      new Date(info.startedAtMs).toISOString() + '；文件 mtime 因拷贝保留而看不出来）'
    : (info.deployStampAtMs
      ? '磁盘文件在**本进程启动之后**才被写入或部署（最新文件：' + String(info.newestFile || '?') +
        (ageMin === null ? '' : '，' + ageMin + ' 分钟前') + '；另有一次部署发生在进程启动之后：' +
        new Date(info.deployStampAtMs).toISOString() + '）'
      : '磁盘文件在**本进程启动之后**才被写入（最新：' + String(info.newestFile || '?') +
        (ageMin === null ? '' : '，' + ageMin + ' 分钟前') + '）')
  return '⚠ **代码可能不是最新的**：' + what + '的' + why +
    '，而宿主只在启动时加载一次插件代码（**不热加载**）。' +
    '也就是说：这次结果反映的是**旧代码**，不要据此判断"修复没生效"或"功能不存在"。' +
    '要让改动生效需要重启宿主（会中断当前会话）—— 需要本工具链的最新行为时，请先确认这一点。'
}

/**
 * 结构化版本（给 MCP/脚本消费，附带机器可判的字段）。
 *
 * @param dir  插件目录（或目录数组，见 moduleRoots）
 * @param opts · surface: 'plugin'（长活宿主，默认）| 'mcp'（短命进程）
 *             · processStartMs：外部检查器判断**别的**进程时用
 *
 * surface='mcp' 时**永远**附带 codeFreshnessScope：短命进程里的这份自检只能保证"我这个进程加载的是新代码"，
 * 而**长活的 DSH 宿主**可能仍在跑旧代码 —— 不说清这一点，MCP 面会把"我没问题"当成"全都没问题"
 * （Claude 第九轮 Q2：MCP 面结构上永远看不到 stale，这句自检在那里等于安慰剂）。
 */
export function staleCodeInfo(dir, opts = {}) {
  const info = codeFreshness(dir, opts)
  // surface 未显式给出时按 argv 自动判定（见 detectSurface）；拿不准偏向 'mcp'。
  const surface = opts.surface || detectSurface()
  const scope = surface === 'mcp'
    ? {
        codeFreshnessScope: 'mcp-process-only',
        codeFreshnessScopeNote: '这份自检只覆盖**当前 MCP server 进程**（短命，每次连接新起，因此它自己必然是新代码）。' +
          '**长活的 DSH 宿主**是否在跑旧插件代码，从这里看不出来 —— 宿主不热加载，只有重启才生效。' +
          '若插件工具（宿主面）的行为与本仓库代码不一致，先怀疑宿主未重启。',
      }
    : null
  if (!info.stale) return scope
  return {
    codeStale: true,
    codeStaleReason: info.reason,
    codeStaleNewestFile: info.newestFile,
    codeStaleNewestMtime: info.newestMtimeMs ? new Date(info.newestMtimeMs).toISOString() : null,
    codeStaleDeployStampAt: info.deployStampAtMs ? new Date(info.deployStampAtMs).toISOString() : null,
    codeStaleScannedRoots: info.scannedRoots,
    processStartedAt: new Date(info.startedAtMs).toISOString(),
    codeStaleNote: staleCodeNote(dir, '本插件', opts),
    ...(scope || {}),
  }
}
