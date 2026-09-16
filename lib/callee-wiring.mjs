/**
 * 「工具 → 被调模块 → 具体函数」的静态接线（r54）。
 *
 * ## 为什么要有它
 *
 * 现行「被调方读取点」闸（`toolface-params.test.mjs` 1d 节）是**对整目录语料按名字搜**：
 * 只要语料里**别处**也有同名参数被读过，它就认为"有读取点"。PROGRESS §39.3 的证伪把这件事钉死了 ——
 * 删掉 `lib/failure-corpus.mjs` 里 `failure_query.q` 的真实读取（`q.q`），**闸没红**，
 * 因为 `lib/capture-store.mjs` 里另有一个也叫 `q` 且真被读的参数。
 * ⇒ 它只能证"整个语料里这名字没有任何读取痕迹"，**不能**证"是这条工具的参数被读了"。
 *
 * ## 这一版怎么证明
 *
 * 把范围从「目录」收成「**接收这个整包的那一个函数体**」：
 *
 *   1. 在工具 handler 块里找**整包转发**那一次调用（`callee(args)` / `callee({ ...args })`），
 *      记下实参序号 `k`；找不到 ⇒ `no-forward`（如实报，不当成通过）。
 *   2. 解出被调方（`resolveCallee`）。**候选集不是全仓库**，而是从入口文件真实引用得到的闭包：
 *      `index.js` 自己 + 它静态 import 的模块 + 它 `import('...')` **动态**引用的模块字面量
 *      + 共享 `lib/`（薄壳插件的实现在那儿：`dsh-verify` → `lib/failure-corpus.mjs`）。
 *      候选集里**恰好一个**同名函数才认；**零个或 ≥2 个都记 unresolved**（歧义不许猜）。
 *   3. 取被调函数**第 k 个形参**：
 *      · 形参本身就是解构模式 `{ P, Q = 1 } = {}` ⇒ 顶层绑定名**就是**从这个整包上读的（规则 A，最硬）；
 *      · 形参是标识符 `opts` ⇒ 在该函数体里找 `opts.P` / `opts['P']`（规则 B）；
 *      · 该函数体又把整包转出去 ⇒ 递归（规则 C，深度上限 `MAX_DEPTH`，返回调用链）。
 *   4. 三条都不中 ⇒ `unresolved`。**不是通过** —— 调用方（闸）必须把它当红的或显式登记，二选一。
 *
 * ## 边界（写清楚，不假装覆盖）
 *
 * * **跨语言不覆盖**：`ui-drive-batch.ps1` 那类 PowerShell 被调方不在本模块范围内
 *   （它由 `param-forwarding-completeness` 单独覆盖）。
 * * **不做作用域数据流**：规则的判据是"**在这个函数体里**"出现字段访问/解构绑定，
 *   不是完整的 def-use 分析。缩小到函数体已经消掉了 §39.3 那类同名碰撞（这正是它的存在理由），
 *   但同一函数体内若有**同名局部变量**仍可能误判为已读 —— 所以失败侧永远报 unresolved，不报"不存在"。
 * * `unresolved` 只是"**这里证不出来**"，不等于"参数是幽灵"。幽灵判定要由闸结合工具自己的块一起下。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'

export const MAX_DEPTH = 4

export const SCOPE_EXCLUSIONS = Object.freeze({
  'plugins/dsh-api-visualizer/lib/client.js': '嵌套反引号/模板内容导致简易扫描器失同步；这不是“它没有接线问题”',
})

/** 保留开/闭引号，把**内容**抹成空格（含转义序列，逐字符等长）。返回闭引号之后的下标。 */
function blankQuoted(src, out, i, q) {
  out[i] = q
  i++
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') {
      out[i] = ' '
      i++
      if (i < src.length) { out[i] = ' '; i++ }
      continue
    }
    if (src[i] !== '\n') out[i] = ' '
    i++
  }
  if (i < src.length) { out[i] = q; i++ }
  return i
}

/** 上一个有意义的字符是否**允许**用 `/` 起一个正则字面量（否则 `/` 是除号）。 */
function regexCanStart(prev) {
  if (!prev) return true
  return !/[A-Za-z0-9_$)\]'"`]/.test(prev)
}

/** 把正则字面量整体抹空（含两侧斜杠；字符类 `[...]` 内的 `/` 不算结束）。返回其后下标。 */
function blankRegex(src, out, i) {
  out[i] = ' '
  i++
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { out[i] = ' '; i++; if (i < src.length) { out[i] = ' '; i++ } continue }
    if (c === '\n') break                       // 未闭合的正则字面量：不吞换行
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) { out[i] = ' '; i++; break }
    out[i] = ' '
    i++
  }
  while (i < src.length && /[a-z]/i.test(src[i])) { out[i] = ' '; i++ }   // 标志位 gimsuy
  return i
}

/**
 * **唯一的扫描器**（本仓第 38 类：同一逻辑许两份必然漂移）。三种用法都由它派生：
 *   `stripComments(src)` = 只挖注释、**保留字符串**（输出与输入**等长**）
 *   `blankStrings(src)`  = 先挖注释、再把字符串内容抹空（**等长**）
 *
 * 三条硬要求（每一条都是被真实的 0% 解析率教出来的）：
 *   ① **等长** —— 本模块要在"挖干净"的文本上找位置、再拿位置去切**原文**；长度一变下标全错位，
 *      而症状只是"什么都解析不出来"，不报错。
 *   ② **先挖注释** —— 注释里的英文撇号（`don't`）会被当成字符串开头，一路吞掉真正的代码。
 *   ③ **认正则字面量** —— `/['"]/g` 里的引号同样会当成字符串开头（driver.mjs 这类文件满屏正则）。
 */
function scan(src, { blankStrings: doStrings = true } = {}) {
  const out = src.split('')
  let i = 0
  let prevSig = ''
  const n = src.length
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      if (doStrings) i = blankQuoted(src, out, i, c)
      else {   // 保留字符串：只推进（仍然要正确跳过转义，避免把 `\'` 当成串尾）
        i++
        while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++ }
        if (i < n) i++
      }
      prevSig = c
      continue
    }
    if (c === '/' && regexCanStart(prevSig)) { i = blankRegex(src, out, i); prevSig = ''; continue }
    if (!/\s/.test(c)) prevSig = c
    i++
  }
  return out.join('')
}

/** 挖掉注释（**保留字符串**，输出与输入等长）。 */
export function stripComments(src) {
  return scan(src, { blankStrings: false })
}

/**
 * 挖掉注释 **并** 把字符串内容抹空（等长）。标识符匹配必须用它 —— 否则提示语/正则字面量里的
 * `.字段名` 会冒充读取点（§39 证伪时实测过）。
 */
export function blankStrings(src) {
  return scan(src, { blankStrings: true })
}

/** 括号配对取原文（跳过字符串字面量）。 */
export function sliceBalanced(src, from, open, close) {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      continue
    }
    if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return src.slice(from, i + 1) }
  }
  return src.slice(from, from + 8000)
}

/**
 * 收集一个文件里所有**可解析的函数定义**：`function f(a)` / `async function f` /
 * `const f = (a) => {…}` / `const f = async (a) => …` / 对象字面量方法 `f(a) {`。
 *
 * 名字 → 定义列表（**同名多个全部保留**，由调用方按"唯一"裁决 —— 不许我在这里替它挑）。
 * 每条定义带 **`depth`**（声明处的花括号深度），供调用方按"**最浅的那个才是模块级候选**"取舍 ——
 * 见 `resolveCallee`。**嵌套函数也收**是刻意的（本仓的真实被调方就写在工厂函数里，
 * 例如 `makeDriver(cfg) { async function drive(args) {…} }`），所以不能要求 depth 0。
 */
export function functionDefs(src) {
  const out = new Map()
  const push = (name, def) => {
    if (!out.has(name)) out.set(name, [])
    out.get(name).push(def)
  }
  const code = blankStrings(stripComments(src))   // 只在"代码骨架"上找声明位置
  // 花括号深度的前缀和：用来算"这个声明在第几层"
  const depthAt = new Array(code.length + 1)
  depthAt[0] = 0
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    depthAt[i + 1] = depthAt[i] + (c === '{' ? 1 : (c === '}' ? -1 : 0))
  }
  // function f(...) { ... }
  for (const m of code.matchAll(/(?:^|[\s;}])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    const parenAt = code.indexOf('(', m.index + m[0].length - 1)
    const paramsRaw = sliceBalanced(src, parenAt, '(', ')')
    const braceAt = code.indexOf('{', parenAt + paramsRaw.length)
    if (braceAt < 0) continue
    push(name, { name, kind: 'function-decl', paramsRaw, bodyRaw: sliceBalanced(src, braceAt, '{', '}'), depth: depthAt[m.index] })
  }
  // const f = (…) => …   /  const f = async (…) => { … }
  for (const m of code.matchAll(/(?:^|[\s;}])const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    const name = m[1]
    const parenAt = code.indexOf('(', m.index + m[0].length - 1)
    const paramsRaw = sliceBalanced(src, parenAt, '(', ')')
    const after = code.slice(parenAt + paramsRaw.length).match(/^\s*=>/)
    if (!after) continue
    const bodyStart = parenAt + paramsRaw.length + after[0].length
    const braceAt = code.indexOf('{', bodyStart)
    const nl = code.indexOf('\n', bodyStart)
    const isBlock = braceAt >= 0 && (nl < 0 || braceAt < nl)
    const bodyRaw = isBlock ? sliceBalanced(src, braceAt, '{', '}') : code.slice(bodyStart, nl < 0 ? undefined : nl)
    push(name, { name, kind: 'arrow-const', paramsRaw, bodyRaw, depth: depthAt[m.index] })
  }
  // 对象字面量方法：`  query(q = {}) {`（本仓 lib/failure-corpus.mjs 就是这个形状）
  for (const m of code.matchAll(/(?:^|\n)\s{2,}([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
    const name = m[1]
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(name)) continue
    const braceAt = code.indexOf('{', m.index + m[0].length - 1)
    push(name, { name, kind: 'method', paramsRaw: m[2], bodyRaw: sliceBalanced(src, braceAt, '{', '}'), depth: depthAt[m.index] })
  }
  return out
}

/** 这个文件**引用**了哪些模块（静态 import + 动态 `import('…')` 的字面量）。 */
export function importSpecifiers(src) {
  const out = new Set()
  const code = stripComments(src)
  for (const m of code.matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)) out.add(m[1])
  for (const m of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1])       // 动态 import('…')
  for (const m of code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1])
  return [...out]
}

/** 相对说明符 → 真实文件（补 .mjs/.js/index 三种后缀）。解析不出来返回 null。 */
export function resolveModuleFile(fromFile, spec) {
  if (!spec.startsWith('.')) return null          // 裸包名不接（不属于本仓源码）
  const base = resolvePath(dirname(fromFile), spec)
  const cands = [base, base + '.mjs', base + '.js', join(base, 'index.mjs'), join(base, 'index.js')]
  for (const c of cands) {
    try { if (existsSync(c) && statSync(c).isFile()) return c } catch { /* ignore */ }
  }
  return null
}

/**
 * 自校验用：用**只认行首**的朴素正则，从**原文**里数出函数声明名。
 *
 * 它存在的唯一目的是**给扫描器配一条不变量**：`functionDefs` 必须至少找到这些名字。
 * 没有这条自校验时，扫描器一旦被正则字面量/模板串骗到，症状只是"少解析出几个函数"——
 * 看起来一切正常，而检查悄悄变空（实测过：111KB 的 driver.mjs 一度只解析出 6 个，
 * 三个 `drive*` 函数全丢了）。行首锚定让它不受"字符串里出现 function"影响。
 */
export function rawDeclaredFunctionNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1])
  return names
}

/**
 * 建"候选集闭包"：入口文件 + 它引用的模块（**一跳**）+ 显式给的额外目录（共享 `lib/`）。
 *
 * ⚠ 只走**一跳**是刻意的：走多跳会把语料放大回"全仓库按名字搜"，那就退回 §39.3 的假绿了。
 */
export function buildScope({ entryAbs, extraDirs = [], extraFiles = [], maxFiles = 80 }) {
  const files = new Map()   // abs → { src, defs }
  const excludedFiles = []
  const add = (abs) => {
    if (!abs || files.has(abs) || files.size >= maxFiles) return false
    try { if (!existsSync(abs) || !statSync(abs).isFile()) return false } catch { return false }
    let src = ''
    try { src = readFileSync(abs, 'utf8') } catch { return false }
    const rel = abs.replace(/\\/g, '/').split('/').slice(-4).join('/')
    const reason = Object.entries(SCOPE_EXCLUSIONS).find(([file]) => rel.endsWith(file))
    if (reason) { excludedFiles.push({ file: reason[0], reason: reason[1] }); return false }
    files.set(abs, { src, defs: functionDefs(src) })
    return true
  }
  add(entryAbs)
  const entrySrc = files.get(entryAbs) ? files.get(entryAbs).src : ''
  for (const spec of importSpecifiers(entrySrc)) {
    const f = resolveModuleFile(entryAbs, spec)
    if (f) add(f)
  }
  for (const f of extraFiles) add(f)
  for (const dir of extraDirs) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() && /\.(mjs|js)$/i.test(e.name) && !/\.test\.(mjs|js)$/i.test(e.name)) add(join(dir, e.name))
    }
  }
  // 名字 → 定义位置（**同名全部保留**，交给调用方按"唯一"裁决）
  const byName = new Map()
  for (const [abs, { defs }] of files) {
    for (const [name, list] of defs) {
      if (!byName.has(name)) byName.set(name, [])
      for (const d of list) byName.get(name).push({ abs, def: d })
    }
  }
  return { entryAbs, files, byName, excludedFiles }
}

/** 顶层逗号切分参数列表 / 实参列表。 */
export function splitTopLevel(s) {
  const parts = []
  let depth = 0, buf = '', quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { buf += c; if (c === '\\') { buf += s[++i] || ''; continue } if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue }
    if ('{([<'.includes(c)) depth++
    else if ('})]>'.includes(c)) depth--
    else if (c === ',' && depth <= 0) { parts.push(buf); buf = ''; continue }
    buf += c
  }
  if (buf.trim()) parts.push(buf)
  return parts.map((x) => x.trim()).filter((x) => x !== '')
}

/**
 * 形参切片 → 它**从整包上读出**的顶层绑定名（+ 有没有 `...rest` 把剩下的全收走）。
 *
 * 只认"形参本身就是解构模式"这一种（`{ P, Q = 1 } = {}`）—— 这正是最硬的一条：
 * 调用方把整个 args 对象当实参传进来，模式里的每个顶层名字**必然**来自它。
 * 形参是普通标识符 ⇒ `names` 为 null（交给规则 B 去函数体里找字段访问）。
 *
 * ⚠ 第一版**没有按逗号切分**，是把每个名字攒进一个 buf、到下个 `{`/`[`/`}`/`]` 才 flush ——
 *   于是 `{ runId, task, claims = [], context = {}, recordFailures = true }` 只认出
 *   `runId / context / recordFailures`，**漏掉 task 与 claims**（症状同样是"什么都证不出来"）。
 */
export function patternInfo(paramSlice) {
  if (!paramSlice) return { names: null, hasRest: false }
  let s = paramSlice.trim()
  // 去掉默认值 `= {}`：在**深度 0** 处找 `=`（排除 `=>` 与 `==`）
  {
    let depth = 0
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if ('{([<'.includes(c)) depth++
      else if ('})]>'.includes(c)) depth--
      else if (c === '=' && depth === 0 && s[i + 1] !== '>' && s[i - 1] !== '=') { s = s.slice(0, i).trim(); break }
    }
  }
  if (!s.startsWith('{')) return { names: null, hasRest: false }
  const close = s.lastIndexOf('}')
  const inner = s.slice(1, close >= 0 ? close : s.length)
  // 按**顶层逗号**切成片，每片取最前面的绑定名（`P` / `P: alias` / `P = def` 都读的是 `P`）
  const pieces = []
  let depth = 0, buf = ''
  for (const ch of inner) {
    if ('{(['.includes(ch)) depth++
    else if ('})]'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { pieces.push(buf); buf = ''; continue }
    buf += ch
  }
  pieces.push(buf)
  const names = new Set()
  let hasRest = false
  for (const piece of pieces) {
    const t = piece.trim()
    if (!t) continue
    if (/^\.\.\./.test(t)) { hasRest = true; continue }
    const mm = t.match(/^([A-Za-z_$][\w$]*)/)
    if (mm) names.add(mm[1])
  }
  return { names, hasRest }
}

/** 只要名字集合的便捷入口（`patternInfo` 的薄壳 —— 单一实现仍在上面的 `patternInfo`）。 */
export function patternBindings(paramSlice) {
  return patternInfo(paramSlice).names
}

/** 把一个形参切片里的**标识符形参名**取出来（`args` / `args = {}` / `...args` 都 → `args`）。 */
export function paramIdentifier(paramSlice) {
  const s = (paramSlice || '').trim().replace(/^\.\.\./, '')
  const m = s.match(/^([A-Za-z_$][\w$]*)\s*(?:=|$)/)
  return m ? m[1] : ''
}

/**
 * 这个绑定名在函数体里**被引用**过吗（不是只出现在形参模式里）？
 *
 * 用途：规则 A 的"解构成了就算读到"要加这一道。
 * **Claude r54 §Q1 的实测反驳**：`{ runId, task, claims = [], … } = {}` 这种写法，
 * 只解构、不使用（或重构时把某个字段的**使用**删了、模式为了 API 兼容留着）—— 旧规则照样判绿，
 * 而那正是本闸声称要抓的"接了参数悄悄丢掉"。而且它与紧邻的 `...rest` 处理**自相矛盾**
 * （那边写着"收下了 ≠ 用了"）。
 *
 * 判据：名字以**标识符**身份出现，且**前面不是 `.`**（`x.p` 里的 `p` 是属性名，不算引用）。
 */
export function bindingUsedInBody(body, name) {
  const code = blankStrings(body)
  return new RegExp('(?:^|[^\\w$.])' + name + '\\b').test(code)
}

/**
 * 在函数体里找"`ident` 的 `P` 字段被读"的**第一个位置**；找不到返回 -1。
 * 认 `.P` / `?.P` / `.['P']` / `['P']`（可选链是实测漏掉的一整族：
 * `hang_run` 的 handler 是 `hang.startRun({ maxSeconds: args?.maxSeconds ?? 0 })`）。
 *
 * ⚠ 两种写法要**在不同的视图**上找，且两个视图都必须与输入等长（下标才能互相比较）：
 *   · `.P` 的写法要在**抹掉字符串内容**之后找 —— 否则提示语/正则里的 `.p` 会冒充读取点；
 *   · `['P']` 的写法**不能**抹字符串 —— `args["p"]` 里的 `"p"` 是语法的一部分，抹掉就再也认不出来了
 *     （实测：`args["p"]` 一直判成"没读到"）。所以它只在"只挖注释、保留引号"的视图上找。
 */
export function fieldReadIndex(body, ident, p) {
  const blanked = blankStrings(body)          // 注释 + 字符串内容都空格化（等长）
  const commentsOnly = stripComments(body)    // 只挖注释、保留引号（等长）
  let min = -1
  // ⚠ 这个局部函数**不能叫 `probe`**：`plugins/dsh-perf/lib/perf.mjs` 的被调方就叫 `probe`，
  //   而同名会让 `resolveCallee` 判歧义（虽然现在有"按深度取舍"兜底，但少一处撞名少一处麻烦）。
  const takeMin = (re, text) => { const m = re.exec(text); if (m && (min < 0 || m.index < min)) min = m.index }
  takeMin(new RegExp('\\b' + ident + '\\s*\\??\\s*\\.\\s*' + p + '\\b', 'g'), blanked)
  takeMin(new RegExp('\\b' + ident + '\\s*\\??\\s*\\.\\s*\\[\\s*[\'"]' + p + '[\'"]\\s*\\]', 'g'), commentsOnly)
  takeMin(new RegExp('\\b' + ident + '\\s*\\??\\s*\\[\\s*[\'"]' + p + '[\'"]\\s*\\]', 'g'), commentsOnly)
  return min
}

/** 布尔薄壳（单一实现仍在 `fieldReadIndex`）。 */
export function fieldReadIn(body, ident, p) {
  return fieldReadIndex(body, ident, p) >= 0
}

/**
 * 函数体里**重新声明**接收参数这个名字的位置（遮蔽）；没有则 -1。
 *
 * Codex r54 §2/§4-R1 点名：`const { q } = opts` 之后的 `q` 可能是嵌套函数、闭包或被遮蔽的同名标识符，
 * "在函数体里搜到这个名字"并**不能**证明读的就是形参。没有 AST 就没有完整的词法作用域 ——
 * 所以这里不去"猜作用域"，而是**发现同名重新声明就只信它之前的部分**：文本上位于重新声明**之前**
 * 的读取点，其名字只可能指向形参；之后的**一律拒答**（→ unresolved）。
 *
 * ⚠ 第一版"只要函数体里出现同名声明就整条拒答"**过严**：`driver.mjs` 的 `driveOnce`（59KB）里
 *   第 26388 个字符处有一个无关的局部 `const args`，而真正的 `args.X` 读取在第 1815 ——
 *   一刀切把 172 个参数全判成"遮蔽"，症状同样是"什么都证不出来"。
 *
 * 保守方向仍然是对的：多报 unresolved 只是"证不出来"，误报已读才是**假绿**。
 */
export function firstShadowIndex(body, ident) {
  const code = blankStrings(body)
  let min = -1
  for (const re of [
    new RegExp('\\b(?:const|let|var|function|class)\\s+' + ident + '\\b', 'g'),
    new RegExp('\\b(?:const|let|var)\\s*\\{[^}]*\\b' + ident + '\\b[^}]*\\}', 'g'),
    new RegExp('\\b(?:const|let|var)\\s*\\[[^\\]]*\\b' + ident + '\\b[^\\]]*\\]', 'g'),
    // **嵌套函数的形参**也遮蔽：`arr.map((args) => args.P)` / `arr.map(function (args) { … })` ——
    // 里面的 `args.P` 读的是**内层**那个对象，不是外层整包。
    // Claude r54 §Q1 实测指出：只认 `const/let/var/function/class` 重声明会漏掉这一族 ⇒ 真·假绿。
    new RegExp('\\([^()]*\\b' + ident + '\\b[^()]*\\)\\s*=>', 'g'),
    new RegExp('\\bfunction\\s*[A-Za-z_$\\w$]*\\s*\\([^()]*\\b' + ident + '\\b[^()]*\\)', 'g'),
  ]) {
    const m = re.exec(code)
    if (m && (min < 0 || m.index < min)) min = m.index
  }
  return min
}

/** 函数体里所有 `name(...)` 形状的调用（含实参原文与位置）。 */
export function callsIn(body) {
  const code = blankStrings(body)
  const out = []
  const re = /([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const name = m[1]
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'async'].includes(name)) continue
    const parenAt = m.index + m[0].length - 1
    const raw = sliceBalanced(body, parenAt, '(', ')')
    out.push({ name, argv: splitTopLevel(raw.slice(1, -1)), at: m.index })
  }
  return out
}

/**
 * 函数体里"把整包 `ident` 又交出去"的**所有**调用（不是只取第一个）。
 *
 * 为什么要全部：`drive(args)` 的真实体是
 * `const res = await driveInner(args); return attachEvidence(res, args)` ——
 * **两个**被调方，且第二个的整包在**第 1 个实参**上。只取第一个会漏掉另一半读点，
 * 而且会把"整包永远在第 0 个形参"这个假设用错地方。
 *
 * ⚠ 刻意**不认** `f({ x: ident.x })` —— 那是"按字段重建对象"，参数是否还在链上取决于字段是否被搬全，
 *   静态上不可知（Codex r54 §1.5 点名的陷阱）。宁可不认（→ unresolved）也不误认成整包传递。
 */
export function forwardsIn(body, ident) {
  const out = []
  for (const c of callsIn(body)) {
    const i = c.argv.findIndex((a) => {
      const t = a.trim()
      return t === ident || t === ('...' + ident) || new RegExp('^\\{[^{}]*\\.\\.\\.\\s*' + ident + '\\b').test(t)
    })
    if (i >= 0) out.push({ name: c.name, argIndex: i, at: c.at })
    else if (c.argv.some((a) => new RegExp('^\\{[^{}]*\\b' + ident + '\\s*[,}]').test(a.trim()))) {
      // `f({ x: 1, args })` 这类"把整包当属性塞进去"——静态上分不清是哪个位置，**不认**
    }
  }
  return out
}

/**
 * 被调方是不是把整包 `ident` **泛枚举地拆开重建**了（`Object.entries/keys/values(ident)` /
 * `Object.assign(x, ident)` / `for (… in ident)`）—— 这类构造**不按字段名读**，读点落在
 * **重建出来的新对象**上，链条静态跟不过（`api_capture_query`：`paramsFromObj(args)` 用
 * `Object.entries` 枚举成 `URLSearchParams`，真正的读在 `applyFilters` 的 `params.get('P')`，
 * 键名还可能被 `FILTER_PARAM_ALIASES` 改写 ⇒ 就算跟过去也不可信）。
 *
 * ⚠ 它**不制造读取点**（不 return proof）——沿用本模块"宁可 unresolved 也不假绿"的底线。
 *   唯一用途是把 unresolved 的**理由写准**：把"整包被泛枚举重建、读点搬走了"与"这个参数根本
 *   没人读"分开（本仓口径：原因不许糊成一句"未查"，D.3 / r61）。返回命中的构造名，否则 ''。
 *
 * 只在**代码骨架**（`blankStrings` 之后）上判，否则提示语/注释里的 `Object.entries(...)` 会冒充命中。
 */
export function reconstructsWholeArg(body, ident) {
  if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) return ''
  const code = blankStrings(body)
  const probes = [
    ['Object.entries', new RegExp('\\bObject\\s*\\.\\s*entries\\s*\\(\\s*' + ident + '\\b')],
    ['Object.keys', new RegExp('\\bObject\\s*\\.\\s*keys\\s*\\(\\s*' + ident + '\\b')],
    ['Object.values', new RegExp('\\bObject\\s*\\.\\s*values\\s*\\(\\s*' + ident + '\\b')],
    ['Object.assign', new RegExp('\\bObject\\s*\\.\\s*assign\\s*\\([^)]*\\b' + ident + '\\b')],
    ['for-in', new RegExp('\\bfor\\s*\\([^)]*\\bin\\s+' + ident + '\\b')],
  ]
  for (const [tag, re] of probes) if (re.test(code)) return tag
  return ''
}

/**
 * 工具 handler 块里的**整包转发**：`callee(args)` / `callee({ ...args })`。
 * 返回 {callee, argIndex, style}；找不到返回 null。
 */
export function findWholeArgsForward(handlerBody, argsIdent = 'args') {
  const code = blankStrings(handlerBody)
  let m = code.match(new RegExp('([A-Za-z_$][\\w$]*)\\s*\\(\\s*' + argsIdent + '\\s*[,)]'))
  if (m) return { callee: m[1], argIndex: 0, style: 'positional' }
  m = code.match(new RegExp('([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\{[^{}]*\\.\\.\\.\\s*' + argsIdent + '\\b'))
  if (m) return { callee: m[1], argIndex: 0, style: 'spread-object' }
  m = code.match(new RegExp('\\.([A-Za-z_$][\\w$]*)\\s*\\(\\s*' + argsIdent + '\\s*[,)]'))
  if (m) return { callee: m[1], argIndex: 0, style: 'method-call' }
  return null
}

/**
 * 在候选集里解一个名字。
 *
 * 取舍规则：**只认"最浅那一层"的定义**；同一层里有 ≥2 个才叫歧义。
 *
 * 为什么不是"有一个就认"、也不是"要求 depth 0"：
 *   · 本仓的真实被调方**写在工厂函数里**（`makeDriver(cfg) { async function drive(args) {…} }`，depth 1），
 *     要求 depth 0 会把它们全丢掉 —— 实测所有 DSH 工具的 callee 都会解不出来；
 *   · 但嵌套在**函数体内部**的同名小工具也是真实存在的：我自己在 `lib/callee-wiring.mjs` 的
 *     `fieldReadIndex` 里写了个局部箭头函数 `probe`，于是 `DSH perf_probe` 的 callee `probe`
 *     被判成"两个定义（`lib/perf.mjs` 与 `lib/callee-wiring.mjs`）⇒ 歧义"，**被本闸当场抓住**
 *     （这一条也说明：闸真的会红，不是摆设）。
 *   ⇒ 用深度取舍最接近真实作用域：越浅越像"模块/工厂级"的候选。
 */
export function resolveCallee(scope, name) {
  const cands = scope.byName.get(name) || []
  if (cands.length === 0) return { ok: false, reason: 'callee-not-found-in-scope(' + name + ')' }
  const minDepth = Math.min(...cands.map((c) => (Number.isFinite(c.def.depth) ? c.def.depth : 1)))
  const shallow = cands.filter((c) => (Number.isFinite(c.def.depth) ? c.def.depth : 1) === minDepth)
  if (shallow.length > 1) {
    return {
      ok: false,
      reason: 'callee-ambiguous(' + name + ' 在**第 ' + minDepth + ' 层**有 ' + shallow.length + ' 个定义：' +
        shallow.map((c) => c.abs.split(/[\\/]/).slice(-2).join('/')).join(', ') + ')',
    }
  }
  return { ok: true, abs: shallow[0].abs, def: shallow[0].def }
}

/**
 * 证明"这个整包上的 `P` 被读了"。
 *
 * @returns {{where?: string, via?: string, chain?: string[], reason?: string}}
 *   `where` 形如 `lib/failure-corpus.mjs:query`；只有证明到了才给 `where`。
 */
export function proveRead({ scope, fromFile, def, params, argIndex = 0, depth = 0, chain = [], repoRel }) {
  const out = new Map()          // param → {where, via, chain}
  const reasons = new Map()      // param → reason
  if (depth > MAX_DEPTH) {
    for (const p of params) reasons.set(p, 'depth-exceeded')
    return { reads: out, reasons }
  }
  const rel = (abs) => (repoRel ? repoRel(abs) : abs)
  const paramList = splitTopLevel(def.paramsRaw.replace(/^\(|\)$/g, ''))
  const recvIndex = Math.max(0, Number(argIndex) || 0)
  const recv = paramList[recvIndex] || ''    // 接收整包的形参（`attachEvidence(res, args)` 时是第 1 个）
  const pinfo = patternInfo(recv)
  const bound = pinfo.names
  const label = rel(fromFile) + ':' + def.name
  const nextChain = [...chain, label]

  if (bound) {
    // 规则 A：形参自身解构 —— 顶层绑定名是从这个整包上读的（最硬的一条）……
    //   ……**但必须再核一步"这个名字在体内被引用过"**（Claude r54 §Q1）：只解构不使用、
    //   或重构时把某个字段的**使用**删了而模式留着，旧写法照样判绿 —— 那正是本闸要抓的
    //   "接了参数悄悄丢掉"。这里与紧邻的 `...rest` 处理保持一致（"收下了 ≠ 用了"）。
    for (const p of params) {
      if (!bound.has(p)) continue
      if (bindingUsedInBody(def.bodyRaw, p)) out.set(p, { where: label, via: 'destructure', chain: nextChain })
      else reasons.set(p, 'destructured-but-never-used-in-body(' + p + ')')
    }
    if (pinfo.hasRest) {
      // `...rest` 把剩下的全收走：**收下了 ≠ 用了**。不把"被 rest 收走"当成读取点，
      // 否则"接了参数然后悄悄丢掉"这种最常见的假实现会一路绿灯（本闸存在的理由正是抓它）。
      for (const p of params) {
        if (!out.has(p) && !reasons.has(p)) reasons.set(p, 'destructured-into-rest(被 ...rest 收下，但没法证明被使用)')
      }
    }
  }
  // 剩余参数：规则 B（字段访问）/ 规则 C（再转发）
  const ident = bound ? '' : paramIdentifier(recv)
  let fwds = []
  if (ident && /^[A-Za-z_$][\w$]*$/.test(ident)) {
    const shadowAt = firstShadowIndex(def.bodyRaw, ident)
    for (const p of params) {
      if (out.has(p)) continue
      const at = fieldReadIndex(def.bodyRaw, ident, p)
      // 只信"重新声明**之前**"的读取点（见 firstShadowIndex 的说明）
      if (at >= 0 && (shadowAt < 0 || at < shadowAt)) out.set(p, { where: label, via: 'field', chain: nextChain })
    }
    // 遮蔽之前发生的转发仍然可信；之后的拒答
    fwds = forwardsIn(def.bodyRaw, ident).filter((f) => shadowAt < 0 || f.at < shadowAt)
    if (shadowAt >= 0) {
      for (const p of params) if (!out.has(p) && !reasons.has(p)) {
        reasons.set(p, 'receiving-param-shadowed-in-body(' + ident + ' @' + shadowAt + '，之前的读点已采信)')
      }
    }
  } else if (bound) {
    // 形参是解构模式、但 P 不在顶层：可能上面还有一层包装对象（`{ opts } = {}`）——
    // 本仓没有这种形状；**不猜**，留给 reason 说清楚。
  }
  let remaining = params.filter((p) => !out.has(p))
  for (const f of fwds) {
    if (!remaining.length) break
    const r = resolveCallee(scope, f.name)
    if (!r.ok) {
      for (const p of remaining) if (!reasons.has(p)) reasons.set(p, r.reason)
      continue
    }
    const sub = proveRead({ scope, fromFile: r.abs, def: r.def, params: remaining, argIndex: f.argIndex, depth: depth + 1, chain: nextChain, repoRel })
    for (const [p, v] of sub.reads) if (!out.has(p)) out.set(p, { ...v, via: 'chain:' + v.via })
    remaining = params.filter((p) => !out.has(p))
  }
  // 泛枚举重建（`Object.entries(ident)` 等）只用来把 unresolved 的**理由写准**，不制造读取点。
  const genericReconstruct = ident ? reconstructsWholeArg(def.bodyRaw, ident) : ''
  for (const p of remaining) {
    if (!reasons.has(p)) {
      reasons.set(p, bound ? 'not-a-top-level-binding-of-the-destructured-param'
        : (ident
            ? (genericReconstruct
                ? 'args-reconstructed-generically(' + genericReconstruct + '(' + ident + ') → 读点落在重建后的新对象上，静态跟不过；见 D.3)'
                : 'no-field-read-in-callee-function-body')
            : 'receiving-param-not-an-identifier'))
    }
  }
  return { reads: out, reasons }
}

/**
 * 从一个「函数/箭头函数实参」的原文里取出**函数体**，并给出它的第一个形参名（= 整包的名字）。
 *
 * 为什么需要它：MCP 面是 `server.tool(name, desc, schema, handler)`，handler 有时是块体箭头函数
 * （`async (args) => { … }`）、有时是表达式体（`async (args) => jtext(…, args)`）——
 * Codex r54 §1.1 点名两种体形都要支持。
 */
export function handlerBodyOf(argRaw) {
  const s = (argRaw || '').trim()
  // async (args) => …   /   (args) => …   /   args => …
  let m = s.match(/^(?:async\s*)?\(([^)]*)\)\s*=>\s*/) || s.match(/^(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>\s*/)
  if (m) {
    const argsIdent = (m[1] || '').trim().split(/\s*[,=]/)[0].replace(/^\.\.\./, '').trim()
    const bodyStart = m[0].length
    const braceAt = s.indexOf('{', bodyStart)
    const nl = s.search(/[\n;]/)
    const isBlock = braceAt === bodyStart
    const bodyRaw = isBlock ? sliceBalanced(s, braceAt, '{', '}') : s.slice(bodyStart, nl >= 0 && nl > bodyStart ? nl : undefined)
    return { argsIdent: /^[A-Za-z_$][\w$]*$/.test(argsIdent) ? argsIdent : 'args', bodyRaw, kind: isBlock ? 'arrow-block' : 'arrow-expr' }
  }
  // function (args) { … }  /  function name(args) { … }
  m = s.match(/^(?:async\s+)?function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)\s*/)
  if (m) {
    const argsIdent = (m[1] || '').trim().split(/\s*[,=]/)[0].replace(/^\.\.\./, '').trim()
    const braceAt = s.indexOf('{', m[0].length)
    return {
      argsIdent: /^[A-Za-z_$][\w$]*$/.test(argsIdent) ? argsIdent : 'args',
      bodyRaw: braceAt >= 0 ? sliceBalanced(s, braceAt, '{', '}') : s,
      kind: 'function',
    }
  }
  return { argsIdent: 'args', bodyRaw: s, kind: 'unknown' }
}

/**
 * 从 DSH 面的 `defineTool({ … })` 块里取 **execute 的 handler 体**。
 *
 * 为什么要专门取：直接在**整个块**上找"整包转发"会先撞到 handler 的形参表本身 ——
 * 实测所有 DSH 工具的 callee 都被解成 `execute`/`async`，于是 223 个参数全部 unresolved
 * （症状只是"证不出来"，看不出是匹配错了地方）。
 *
 * 本仓真实存在**两种**写法，都必须认（只认一种会静默丢掉一半工具）：
 *   · method 简写：`async execute(args) { … }`   ← dsh-ui-drive / dsh-perf 等
 *   · 属性箭头函数：`execute: async (args) => …`
 */
export function defineToolHandlerBody(blockRaw) {
  const s = blockRaw || ''
  const m = s.match(/\b(?:async\s+)?execute\b/)
  if (!m) return { argsIdent: 'args', bodyRaw: s, kind: 'none' }
  const after = s.slice(m.index + m[0].length)
  const trimmed = after.replace(/^\s+/, '')
  if (trimmed.startsWith(':')) return handlerBodyOf(trimmed.slice(1))          // execute: (args) => …
  if (trimmed.startsWith('(')) {                                              // async execute(args) { … }
    const parenAt = m.index + m[0].length + (after.length - trimmed.length)
    const paramsRaw = sliceBalanced(s, parenAt, '(', ')')
    const braceAt = s.indexOf('{', parenAt + paramsRaw.length)
    const ident = paramIdentifier(splitTopLevel(paramsRaw.replace(/^\(|\)$/g, ''))[0] || '')
    return {
      argsIdent: ident || 'args',
      bodyRaw: braceAt >= 0 ? sliceBalanced(s, braceAt, '{', '}') : s.slice(braceAt),
      kind: 'method',
    }
  }
  return { argsIdent: 'args', bodyRaw: s.slice(m.index), kind: 'unknown' }
}

/** 在 handler 体里，这个参数是不是被**具名读**过（`args.P` / `args['P']`）。 */
export function handlerReadsField(handlerBody, ident, p) {
  return fieldReadIn(handlerBody, ident, p)
}

/**
 * **按参数**分派（r54 的第二版判据 —— 第一版按工具分派，被 Codex §1.2 反驳掉了）：
 *
 *   harness 里真实存在**混合形态**：`drive({ action: 'state', match: args.match || '', … })`
 *   —— 同一条 handler 里既**具名读**了一些参数，又把**重建后的对象**转给被调方。
 *   按工具分类会二选一，两种分类都错：按"转发"分类会让具名读的参数也被要求去被调方证明（假红），
 *   按"具名"分类又会放过真正靠被调方读的参数（假绿）。
 *
 * 所以逐参数按顺序判：
 *   ① handler 里具名读到 ⇒ 证到（named）；
 *   ② 否则若 handler 把整包转出去 ⇒ 到**被调方那一个函数体**里证（wiring，见 `proveRead`）；
 *   ③ 都不中 ⇒ unresolved（**不是通过**，由闸决定是红还是显式登记）。
 */
export function analyzeParams({ scope, handlerBody, params, argsIdent = 'args', repoRel }) {
  const reads = new Map()
  const unresolved = []
  const viaHandler = []
  for (const p of params) {
    if (argsIdent && handlerReadsField(handlerBody, argsIdent, p)) {
      reads.set(p, { where: 'handler', via: 'named', chain: ['handler'] })
      viaHandler.push(p)
    }
  }
  const rest = params.filter((p) => !reads.has(p))
  if (!rest.length) return { reads, unresolved, callee: null, viaHandler }
  const sub = analyzeToolReads({ scope, handlerBody, params: rest, argsIdent, repoRel })
  for (const [p, v] of sub.reads) reads.set(p, v)
  for (const u of sub.unresolved) unresolved.push(u)
  return { reads, unresolved, callee: sub.callee, viaHandler }
}

/**
 * 端到端（单工具层）：在 handler 体里找整包转发，解出被调方，再**按函数**证明参数被读。
 * 一般由 `analyzeParams` 调用（它先剥掉具名读到的参数）。
 *
 * @returns {{reads: Map, unresolved: Array<{param, reason}>, callee: string|null}}
 */
export function analyzeToolReads({ scope, handlerBody, params, argsIdent = 'args', repoRel }) {
  const fwd = findWholeArgsForward(handlerBody, argsIdent)
  if (!fwd) {
    return { reads: new Map(), unresolved: params.map((p) => ({ param: p, reason: 'no-whole-args-forward-in-handler' })), callee: null }
  }
  const r = resolveCallee(scope, fwd.callee)
  if (!r.ok) {
    return { reads: new Map(), unresolved: params.map((p) => ({ param: p, reason: r.reason })), callee: fwd.callee }
  }
  const res = proveRead({ scope, fromFile: r.abs, def: r.def, params, repoRel })
  return {
    reads: res.reads,
    unresolved: params.filter((p) => !res.reads.has(p)).map((p) => ({ param: p, reason: res.reasons.get(p) || 'unknown' })),
    callee: fwd.callee,
  }
}
