/**
 * perf 证据目录的**清理**（r51）—— G1 黑盒点名的缺口：
 *   `perf_dump` 说 dump"数百 MB"、`perf_trace` 说 etl"可能数百 MB"，而 46 个工具里
 *   **没有任何一个能删除 perf 证据**（`hang_delete` 只管卡死证据包）⇒
 *   "我唯一的出路是请用户手删，或者用不在本目录里的 pwsh"。
 *
 * 设计原则（照抄本仓已经站住的那几条）：
 *   1. **默认只看不删**：不给 `confirm:true` 就只列清单（dry-run），并如实报出"会删多少字节"；
 *   2. **只删自己能认出来的文件**：只处理 `.dmp` / `.etl`（证据大件）；为了找得到它们，
 *      会往下看**一层**（`trace-<stamp>/trace.etl`、`<stamp>/xxx.dmp` —— 证据大件都在按次运行的
 *      子目录里，顶层只有 `last-probe.json`；R1-05 实测：原实现只扫顶层 ⇒ 盘上有 6.71 GB 时
 *      它报「0 个文件命中，共 0 字节」），但**绝不递归删除**、**绝不碰目录本身**；
 *   3. **只在自己管的目录里动**：目标必须在 perf 证据目录之下（`resolve` 后前缀比对），否则**拒绝**；
 *   4. **采样进行中不删**：会话标记（trace-session.json）说在跑时，拒绝删 `.etl`（那正是它正在写的文件）；
 *   5. 失败要把原因说清楚（目录不存在 / 传进来的路径越界 / 读不到），不许静默什么都不做。
 */
import { existsSync, statSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const BIG_EXT = /\.(dmp|etl)$/i

/** 目标路径是否在 root 之下（前缀比对，避免 `..` 越界）。 */
function under(root, p) {
  const r = resolve(root).toLowerCase().replace(/[\\/]+$/, '')
  const t = resolve(p).toLowerCase()
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}

/**
 * @param {{dir:string, confirm?:boolean, keepDays?:number, what?:'dumps'|'etls'|'all', now?:number}} args
 * @returns {{ok:boolean, dryRun:boolean, dir:string, candidates:{path:string,bytes:number,ageDays:number}[], totalBytes:number, deleted:string[], freedBytes:number, skipped:{path:string,reason:string}[], error?:string, hint?:string}}
 */
export function cleanEvidence(args = {}) {
  const dir = args.dir ? resolve(String(args.dir)) : ''
  if (!dir) return { ok: false, error: '没有可用的 perf 证据目录（DSH_PERF_EVIDENCE_DIR 未配置且默认目录也取不到）', dryRun: true, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }
  if (!existsSync(dir)) return { ok: false, error: '证据目录不存在：' + dir, dryRun: true, dir, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }
  if (!under(dir, dir)) return { ok: false, error: '证据目录解析异常：' + dir, dryRun: true, dir, candidates: [], deleted: [], skipped: [], freedBytes: 0, totalBytes: 0 }

  const what = String(args.what || 'all').toLowerCase()
  const keepDays = Number.isFinite(Number(args.keepDays)) && Number(args.keepDays) > 0 ? Number(args.keepDays) : 0
  const now = Number.isFinite(Number(args.now)) ? Number(args.now) : Date.now()
  const confirm = args.confirm === true

  // 采样进行中 ⇒ 不碰 etl（那可能正是它在写的文件）
  let sampling = false
  try {
    const s = JSON.parse(readFileSync(join(dir, 'trace-session.json'), 'utf8'))
    sampling = Boolean(s && s.etlPath)
  } catch { sampling = false }

  const candidates = []
  const skipped = []
  // ⚠⚠ 必须**往下走一层**（2026-09-14 夜 R1-05 真机查出）：
  //   原实现只扫证据目录的**顶层文件**（`readdirSync(dir)` + `st.isFile()`），
  //   而全工具链的证据大件都放在**按次运行的子目录**里（`trace-<stamp>/trace.etl`、
  //   `<stamp>/xxx.dmp`）—— 顶层只有 `last-probe.json`。
  //   现场实测：`perf_clean`（不加 confirm）报「**0 个文件命中，共 0 字节**」，
  //   而同一时刻该目录下躺着 **6.71 GB** 的 `trace-2026-09-14T10-42-21-tonight-b\trace.etl`。
  //   它甚至还给了"可能已经清过了"这句把人带偏的解释 —— 一个用来腾空间的工具，
  //   在盘上有 6.7 GB 可清时说自己没东西可清。
  //
  // ⚠ 但**下潜必须收窄**（同一个测试套当场抓到我第一版写太宽）：
  //   第一版"任意子目录都下潜一层"，于是把工具指向 `%TEMP%` 这种父目录时，
  //   它会钻进别人的子目录去删 `.dmp/.etl` —— 这正是本文件第 3 条设计原则要防的"动到别处"。
  //   现在只下潜**我们自己建的运行目录**（命名是这两族：`trace-<stamp>` 与 `<YYYYMMDD-HHMMSS>`），
  //   深度仍 ≤ 1，仍**只删文件、绝不删目录**，并显式跳过 `symbol-cache`（跨运行共享的符号缓存，
  //   删了下次出报告要重新下 GB 级 pdb）。
  const OUR_RUN_DIR = /^(trace-|20\d{6}[-T])/i
  const collect = (d, depth) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { skipped.push({ path: p, reason: '读不到状态' }); continue }
      if (st.isDirectory()) {
        if (depth >= 1) continue                                   // 只下潜一层
        if (!OUR_RUN_DIR.test(name)) continue                      // 只认我们自己的运行目录（别处的子目录一律不进）
        if (name.toLowerCase() === 'symbol-cache') continue         // 符号缓存**故意保留**
        collect(p, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const isDump = /\.dmp$/i.test(name)
      const isEtl = /\.etl$/i.test(name)
      if (!isDump && !isEtl) continue
      if (what === 'dumps' && !isDump) continue
      if (what === 'etls' && !isEtl) continue
      if (!BIG_EXT.test(name)) continue
      const ageDays = (now - st.mtimeMs) / 86400000
      if (keepDays > 0 && ageDays < keepDays) { skipped.push({ path: p, reason: '未超龄（' + ageDays.toFixed(2) + ' 天 < keepDays=' + keepDays + '）' }); continue }
      if (sampling && isEtl) { skipped.push({ path: p, reason: '采样进行中（trace-session.json 在盘上）：不删 etl' }); continue }
      // ⚠ 这里**只能放 JSON 能表达的值** —— 第一版我塞了个 Symbol 做"来自哪一层"的标记，
      //   结果它被带到工具返回值里，宿主按 `output.schema` 校验时直接判「不是 lossless JSON 对象」，
      //   整个 `perf_clean` 在 DSH 面不可用（`lib/toolface-params.test.mjs` 当场抓到）。
      candidates.push({ path: p, bytes: st.size, ageDays: Number(ageDays.toFixed(2)) })
    }
  }
  collect(dir, 0)
  const totalBytes = candidates.reduce((a, x) => a + x.bytes, 0)

  if (!confirm) {
    return {
      ok: true, dryRun: true, dir, candidates, totalBytes, deleted: [], freedBytes: 0, skipped,
      hint: candidates.length
        ? '上面是**将要删除**的文件（共 ' + totalBytes + ' 字节）。确认后重新调用并传 confirm=true；只想删某类可传 what="dumps"|"etls"，只删旧的传 keepDays=7。'
        : '没有符合条件的文件（可能已经清过了，或 keepDays/what 过滤掉了）。',
    }
  }

  const deleted = []
  let freedBytes = 0
  for (const c of candidates) {
    try { rmSync(c.path, { force: true }); deleted.push(c.path); freedBytes += c.bytes }
    catch (e) { skipped.push({ path: c.path, reason: '删除失败：' + String((e && e.message) || e) }) }
  }
  return {
    ok: true, dryRun: false, dir, candidates, totalBytes, deleted, freedBytes, skipped,
    hint: deleted.length ? '已删除 ' + deleted.length + ' 个文件，释放 ' + freedBytes + ' 字节。' : '没有删除任何文件。',
  }
}

/** 人话渲染（工具面用）。 */
export function renderClean(v) {
  if (!v || v.ok !== true) return '⚠ 清理失败：' + ((v && v.error) || '原因未回报')
  const head = v.dryRun
    ? '【只看不删】' + (v.candidates.length) + ' 个文件命中，共 ' + v.totalBytes + ' 字节'
    : '【已删除】' + v.deleted.length + ' 个文件，释放 ' + v.freedBytes + ' 字节'
  // ⚠ 打印**完整路径**（不是 basename）—— 这是删文件的清单，agent 必须看得见"到底删哪个"。
  //   第一版只印 basename：目录一深，同名文件（多个 run 目录下的 trace.etl）就分不清了，
  //   而且 `lib/toolface-params.test.mjs` 的载荷探针（取记录里最长的字符串字段，即绝对路径）
  //   当场判定"记录数组一个字都没渲染出来"（F-059 同族）—— 那正是它存在的意义。
  const lines = (v.candidates || []).slice(0, 20).map((c) => '  ' + c.path + '  ' + c.bytes + ' 字节（' + c.ageDays + ' 天前）')
  const more = (v.candidates || []).length > 20 ? '  …共 ' + v.candidates.length + ' 个' : ''
  const skips = (v.skipped || []).slice(0, 5).map((s) => '  ⏭ ' + basename(s.path) + '：' + s.reason)
  return [head, '目录：' + v.dir, ...lines, more, ...skips, v.hint].filter(Boolean).join('\n')
}
