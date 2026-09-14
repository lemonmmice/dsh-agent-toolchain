/**
 * dsh-perf srcmap — 把**托管栈帧**映射到**源码文件:行号**。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 为什么需要这个模块（F-009，2026-09-11 真机实测确证）
 *
 * 用户对这套工具链的核心要求是：「用户报卡死/卡顿时，**拿到实质性的代码证据**，
 * 而不是凭自己硬猜测」。而实测发现这条链**当时并不存在**：
 *
 *   1. ClrMD/DumpStack 输出的栈帧只有 `module / type / method` 三个字段
 *      （见工具源码 `DumpStack Program.cs`：`frames.Add(new { type, method, module, … })`）
 *      —— 它**不吐文件与行号**，因为 ClrMD 的托管帧本来就没有 IL 偏移到源行号的映射。
 *   2. 渲染层把帧打成 `模块!类型.方法`（`perf.mjs` 的 `frameLine`），例如
 *      `Contoso.App.ViewModels.dll!OrderListViewModel.OnTick`。
 *      这是**类型级**线索，不是文件级证据。
 *   3. 仓库里唯一做源码定位的函数 `locateType` 是**死代码**：全仓库零调用
 *      （`grep -rn locateType` 只命中它自己的定义与导出）。
 *      而且它写的是 `git grep -n -l` —— `-l` 只列文件名，**把 `-n` 产出的行号丢掉了**，
 *      即使被调用也拿不到行号。
 *
 * 于是"最有用的一句话"（哪个文件第几行）需要调用方自己去翻源码，退化成了猜。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 本模块的做法（以及它诚实的边界）
 *
 * `类型.方法` → 源码位置，用**客户端源树**（git 仓库）做两次查找：
 *   ① 批量 `git grep -n -E '\b(class|struct|interface|record)\s+(A|B|C)\b'`
 *      → 一次性得到 类型 → 「文件:类声明行」；
 *   ② 在该文件内（内存里正则，不再起进程）找方法声明行 → 「文件:方法声明行」。
 *
 * **诚实边界（必须如实呈现给调用方）**：
 *   返回的行号是**声明处**，不是崩溃瞬间正在执行的那一行。ClrMD 给不出后者。
 *   因此渲染时必须写明"声明行"，绝不能让它看起来像精确的执行位置。
 *   找不到就返回 null 并说明原因（源根未配 / 未命中 / 同名多解），**绝不猜一个行号**。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 从完整类型名取简单名：`A.B.C.D` → `D`；泛型 `Foo`1` → `Foo`。 */
export function simpleName(typeName) {
  let n = String(typeName || '')
  n = n.split('.').pop() || n
  const tick = n.indexOf('`')
  if (tick > 0) n = n.slice(0, tick)
  return n
}

export function makeSrcMap({ srcRoot = '', timeoutMs = 30000 } = {}) {
  const typeCache = new Map()  // simpleName -> { file, line, declText } | null | { error }
  const fileCache = new Map()  // file -> string[]

  const usable = () => Boolean(srcRoot) && existsSync(srcRoot)

  /**
   * 批量定位类型声明。一次 git grep 覆盖所有待查类型——
   * 逐帧起进程会在 32 帧的栈上退化到十几秒，批量后是 1 次。
   */
  function locateTypes(simpleNames) {
    const need = [...new Set(simpleNames.filter(Boolean))].filter((n) => !typeCache.has(n))
    if (!need.length) return
    if (!usable()) {
      for (const n of need) typeCache.set(n, null)
      return
    }
    const alt = need.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    // `-E` 扩展正则 + 词边界；只匹配声明，避免 `class XxxFactory` 之类误命中。
    const re = '\\b(class|struct|interface|record)\\s+(' + alt + ')\\b'
    let out = ''
    try {
      // stdio 显式 pipe 掉 stderr：源根不是 git 仓库时 git 会往 stderr 打
      // "fatal: not a git repository"，默认继承会把它漏进宿主进程的控制台日志里。
      //
      // UD-01（Claude 第三轮实测）：早期版本**不限扩展名**，于是与客户端无关的文件
      // （例如某个 .py 工具脚本里的 `class _NullContext:`）也会进候选池，污染同名判定。
      //
      // UD-01 勘误（Claude 第四轮复核）：我第一版只"排除非源码文件"，**却把 `*.py` 列进了允许集** ——
      // 实测一个 `tools/gen.py` 里的 `class ResourceHelper` 照样进 typeFiles、把 duplicates 从 2 推到 3。
      // 也就是说注释自称"排除非源码文件"与实际不符（.py 本就是源码，只是不是**本工具要映射的语言**）。
      //
      // 这个模块的用途是**把 CLR 栈帧映射回源码**（帧的 type 来自 .NET 元数据），
      // 所以默认只认 CLR 家族语言；别的语言即使同名也不是"同一个类型"，
      // 放进来只会制造假歧义。需要别的语言时用 DSH_PERF_SRC_EXTS 覆盖（逗号分隔的 pathspec）。
      const extEnv = String(process.env.DSH_PERF_SRC_EXTS || '').trim()
      const exts = extEnv
        ? extEnv.split(',').map((s) => s.trim()).filter(Boolean)
        : ['*.cs', '*.vb', '*.fs']
      out = execFileSync('git', ['-C', srcRoot, 'grep', '-n', '-E', '--', re, '--', ...exts],
      {
        encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      // git grep 无命中时退出码为 1 —— 这是正常结果，不是错误。
      out = e && e.stdout ? String(e.stdout) : ''
    }
    const found = new Map()
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue
      // 形如  path/to/File.cs:216:    public abstract class Foo<...> : Bar
      const m = line.match(/^(.+?):(\d+):(.*)$/)
      if (!m) continue
      const file = m[1]
      const lineNo = Number(m[2])
      const text = m[3]
      const nm = text.match(new RegExp('\\b(?:class|struct|interface|record)\\s+([A-Za-z_][A-Za-z0-9_]*)'))
      if (!nm) continue
      const key = nm[1]
      const rec = { file, line: lineNo, declText: text.trim() }
      // UD-01（Claude 第三轮）：**保留全部命中**而不是只留第一个。
      // 之前只留第一个 + 一个 duplicates 计数，导致两个真实反例：
      //   A) 同名类跨文件 + 方法重名（客户端里 `ResourceHelper.GetColor` 在 3 个策略文件里逐字节相同）
      //      → 方法路径又**不带** duplicates（见 mapFrames），于是给出一个满分自信的 file:line，
      //      agent 完全不知道还有两个候选，真凶在另一个文件时被**静默**送错。
      //   B) partial class（一个类 split 到 3 个文件）→ 被当成"3 个同名类"，
      //      而且 locateMethod 只搜第一个文件，方法在兄弟 partial 里就命不中。
      // 现在保留 candidates 全列表，让 locateMethod 能跨 partial 找，渲染层也能如实呈现歧义。
      const prev = found.get(key)
      if (prev) prev.all.push(rec)
      else found.set(key, { ...rec, all: [rec], duplicates: 0 })
    }
    for (const [key, rec] of found) rec.duplicates = rec.all.length - 1
    for (const n of need) typeCache.set(n, found.get(n) || null)
  }

  function readFileLines(file) {
    if (fileCache.has(file)) return fileCache.get(file)
    let lines = null
    try { lines = readFileSync(join(srcRoot, file), 'utf8').split(/\r?\n/) } catch { lines = null }
    fileCache.set(file, lines)
    return lines
  }

  /**
   * 在类型所在的**全部候选文件**里找方法声明行。
   *
   * 两个实测踩出来的约束（Claude 第三轮给的客户端真实反例）：
   *  a) 只在**类声明行之后**找，避免同文件里别的类的方法被误当成目标
   *     （实测：一个 .cs 里常放好几个类，盲搜方法名会指错）。
   *  b) **必须搜索全部候选文件**：`partial class` 会把一个类 split 到多个文件
   *     （实测客户端里 `HotspotLoopViewModel` 分成 3 个文件）。过去只搜第一个文件，
   *     方法在兄弟 partial 里就命不中，于是**退回错片段**的类声明行 —— 一个看着很自信、
   *     实际指错文件的答案。
   */
  function locateMethod(simple, methodName) {
    const t = typeCache.get(simple)
    if (!t || !methodName) return null
    const re = new RegExp('\\b' + String(methodName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[(<]')
    // 候选文件按声明行排序，保证结果稳定（git grep 已按路径排序）
    const cands = (t.all && t.all.length ? t.all : [{ file: t.file, line: t.line }])
    for (const c of cands) {
      const lines = readFileLines(c.file)
      if (!lines) continue
      const hits = []
      for (let i = Math.max(0, c.line - 1); i < lines.length; i++) {
        if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() })
        if (hits.length >= 5) break
      }
      if (hits.length) {
        return {
          file: c.file, line: hits[0].line, text: hits[0].text,
          candidates: hits.length, // 同文件内同名方法的个数
          // UD-01：方法路径过去**不带** duplicates，于是同名类跨文件时给出满分自信的错文件。
          // 现在把"这个类型名一共有几处声明"一并带出，让渲染层能如实提示歧义。
          duplicates: t.duplicates || 0,
          typeFiles: (t.all || []).map((x) => x.file),
        }
      }
    }
    return null
  }

  /**
   * 一组栈帧（`{ type, method, module }`）→ 带源码位置的帧。
   * 返回的新数组每项多一个 `src`：
   *   { file, line, where: 'type' | 'method', text, duplicates?, candidates?, typeFiles? }
   * 或 `null`（未配置源根 / 未命中）。
   */
  function mapFrames(frames) {
    const list = Array.isArray(frames) ? frames : []
    const types = list.map((f) => simpleName(f && f.type))
    locateTypes(types)
    return list.map((f, i) => {
      const simple = types[i]
      if (!simple) return { ...f, src: null }
      const byMethod = f && f.method ? locateMethod(simple, f.method) : null
      if (byMethod) {
        return {
          ...f,
          src: {
            file: byMethod.file, line: byMethod.line, where: 'method', text: byMethod.text,
            candidates: byMethod.candidates,
            // UD-01：方法路径也带 duplicates —— 这是"同名类跨文件时不要盲目自信"的关键信号
            duplicates: byMethod.duplicates,
            typeFiles: byMethod.typeFiles,
          },
        }
      }
      const t = typeCache.get(simple)
      if (t) {
        return {
          ...f,
          src: {
            file: t.file, line: t.line, where: 'type', text: t.declText,
            duplicates: t.duplicates || 0,
            typeFiles: (t.all || []).map((x) => x.file),
          },
        }
      }
      return { ...f, src: null }
    })
  }

  /** 供诊断/健康检查：源根是否可用、已解析出多少类型。 */
  function status() {
    return { srcRoot, usable: usable(), typesResolved: [...typeCache.values()].filter(Boolean).length, typesMissed: [...typeCache.values()].filter((v) => !v).length }
  }

  return { locateTypes, locateMethod, mapFrames, status, srcRoot }
}
