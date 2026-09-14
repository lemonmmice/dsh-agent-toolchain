/**
 * 「这个源码文件到底进没进编译」—— 一个**只读**的核对器。
 *
 * 为什么单独做（两个 G1 黑盒 agent 里的场景 B 直接点名）：
 *   agent 的原话是「`kind:"file"` 只验文件**存在**，一个根本没被任何工程引用的 `.cs` 也会判 pass
 *   ⇒ **裁决器给了一份假安全感**」。而本仓已知的坑正是这个：
 *   **legacy .csproj 不会自动包含 .cs**，漏写 `<Compile Include>` 时**构建通过、文件根本没编**。
 *   于是"编译 0 错误"与"我改的文件生效了"是**两件事**，而当时没有任何工具能区分。
 *
 * 设计上的四条硬规则（都是本仓踩出来的）：
 *   1. **只报能证明的**：能确定"在里面"才说 true；能确定"不在"才说 false；
 *      **解析不了就返回 ok:false + 原因**（"没读到" ≠ "没有"）。
 *   2. **口径写清楚**：SDK 风格默认 glob 包含（除非显式关掉默认项），legacy 风格必须显式列出。
 *   3. **忽略 MSBuild 条件**：`Condition=` 我们不求值 —— 这一点**必须写进结果**，
 *      否则调用方会以为"包含"是无条件的。宁可说"我没看条件"，也不假装有条件求值能力。
 *   4. （r43）**编译项不止在 .csproj 里**：`Directory.Build.props` / `.targets` / `<Import>` 都能加
 *      `<Compile Include>`，还能关掉 `EnableDefaultCompileItems`。只读 .csproj 会把"其实会编译"
 *      误判成"不会编译"（假 fail）。所以要把这些文件**一起读**；读不动的（路径里有 `$(...)` 宏）
 *      **必须**让步给"判不了"，绝不许当成"它没列"。
 *
 * ⚠ r43 的一条**未证实**的假设，如实写在结果里（`pathSemanticsNote`）：
 *   MSBuild 对"导入文件里相对路径按谁的目录解析"这件事有版本差异，本工具**不站队** ——
 *   一个 Include 模式只要按**工程目录**或**该文件自己的目录**任一解释能命中，就算命中，
 *   并在 `matchedVia` 里说明是按哪种解释命中的。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative, basename, isAbsolute } from 'node:path'

const PROJECT_EXT = /\.(csproj|vbproj|fsproj)$/i
const PROPS_FILE = /^Directory\.Build\.(props|targets)$/i

/** MSBuild 宏：路径里出现它就说明我们**无法**静态解析这个路径。 */
const MSBUILD_MACRO = /\$\([^)]*\)/

/**
 * **标准框架导入**（r43）：`<Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />` 这类
 * 是每个 legacy 工程都有的样板导入 —— 路径里有宏、解析不了，但它指的是 **.NET 自带的 targets/props**，
 * 不会给本项目加业务源码。
 *
 * 为什么必须单独处理（这是个真实的取舍，不是偷懒）：如果把它们也算作"解析不了 ⇒ 判不了"，
 * 那么**每一个 legacy 工程的"没列进编译"结论都会变成"判不了"** —— 工具的主要价值当场归零
 * （r41 那次真实仓库审计的 29 个文件会全部变成"判不了"）。
 * 所以：这类导入**登记在 `ignoredStandardImports` 里如实报出来**（不是藏起来），
 * 而且**只有**同时满足"以标准 MSBuild 属性开头 + 文件名是 Microsoft.*.targets/props"才算数；
 * 任何其它带宏的导入（例如 `$(SolutionDir)…`）仍然让步给"判不了"。
 */
const STANDARD_MACRO_IMPORT = /^\$\((MSBuildToolsPath|MSBuildBinPath|MSBuildExtensionsPath\d*|MSBuildProgramFiles32|VSToolsPath|MSBuildThisFileDirectory)\)/i
const STANDARD_IMPORT_FILE = /^Microsoft\..*\.(targets|props)$/i
const isStandardFrameworkImport = (raw) =>
  STANDARD_MACRO_IMPORT.test(String(raw).trim()) && STANDARD_IMPORT_FILE.test(basename(String(raw).trim()))

/** 从某个文件往上找它所属的工程文件（到 repoRoot 为止）。 */
export function findProjectFor(filePath, { repoRoot } = {}) {
  const startDir = statSync(filePath).isDirectory() ? filePath : dirname(filePath)
  const stop = repoRoot ? resolve(repoRoot) : null
  let dir = resolve(startDir)
  for (;;) {
    let entries = []
    try { entries = readdirSync(dir) } catch { return null }
    const projects = entries.filter((e) => PROJECT_EXT.test(e))
    if (projects.length === 1) return join(dir, projects[0])
    if (projects.length > 1) {
      // 多个工程在同一层：无法判定"该看哪个" ⇒ 交给调用方显式指定（这里如实说清）
      return { ambiguous: true, candidates: projects.map((p) => join(dir, p)) }
    }
    if (stop !== null && dir === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 在 `repoRoot` 下**扫描所有工程**，找出"哪一个工程把这个文件列进了编译"（r43）。
 *
 * 为什么要它：跨目录的 `<Compile Include="..\..\Shared\Widget.cs" />` 里，源码文件**在工程目录之外** ——
 * 从文件往上找 .csproj **永远找不到**（这就把自己写的一条测试用例当场证伪了）。
 * 而 r41 那次真实仓库审计用的正是"扫全仓、看有没有哪个工程引用它"的逻辑，只是当时写在一次性脚本里。
 * 现在把它收进共享 lib：判定器与审计脚本用**同一份**逻辑，不再有两份实现漂移（第 38 类）。
 *
 * 边界与诚实：① 只扫 repoRoot 之下；② 跳过 bin/obj/node_modules/.git 等目录；
 * ③ 有工程数上限与时间上限，**被截断时必须报出来**（截断时"没找到"不是结论）。
 */
export function findProjectsIncluding(file, { repoRoot, maxProjects = 800, maxMs = 3000 } = {}) {
  const abs = resolve(file)
  const root = resolve(repoRoot)
  const skip = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'packages', 'dist', '.dsh-agent-toolchain'])
  const started = Date.now()
  const projects = []
  let truncated = null
  const stack = [root]
  while (stack.length) {
    if (projects.length >= maxProjects) { truncated = 'project-cap'; break }
    if (Date.now() - started > maxMs) { truncated = 'time-budget'; break }
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue
        stack.push(join(dir, e.name))
      } else if (PROJECT_EXT.test(e.name)) {
        projects.push(join(dir, e.name))
      }
    }
  }
  const matches = []
  for (const p of projects) {
    let xml = ''
    try { xml = readFileSync(p, 'utf8') } catch { continue }
    const projDir = dirname(p)
    const rel = relative(projDir, abs).replace(/\\/g, '/')
    for (const it of parseCompileItems(xml)) {
      if (it.kind !== 'include') continue
      if (MSBUILD_MACRO.test(it.pattern)) continue
      for (const cand of [rel, './' + rel]) {
        if (globToRegExp(it.pattern).test(cand)) { matches.push({ project: p, matchedItem: it.pattern, via: 'project-dir' }); break }
      }
    }
  }
  return { matches, scannedProjects: projects.length, truncated }
}

/** 极简 glob → RegExp：支持 `**`、`*`、`?`，其余字符字面量。路径分隔符统一成 `/`。 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').trim()
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++ } else { re += '[^/]*' }
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i')
}

/** 取工程里所有 `<Compile Include="…">` / `Remove` / `Update`（不求值 Condition，见文件头说明）。 */
export function parseCompileItems(xml) {
  const items = []
  const re = /<Compile\b([^>]*?)\/?>/gi
  let m
  while ((m = re.exec(String(xml))) !== null) {
    const attrs = m[1]
    const inc = /\bInclude\s*=\s*"([^"]*)"/i.exec(attrs)
    const rem = /\bRemove\s*=\s*"([^"]*)"/i.exec(attrs)
    const upd = /\bUpdate\s*=\s*"([^"]*)"/i.exec(attrs)
    const cond = /\bCondition\s*=\s*"([^"]*)"/i.exec(attrs)
    if (inc) items.push({ kind: 'include', pattern: inc[1], condition: cond ? cond[1] : null })
    else if (rem) items.push({ kind: 'remove', pattern: rem[1], condition: cond ? cond[1] : null })
    else if (upd) items.push({ kind: 'update', pattern: upd[1], condition: cond ? cond[1] : null })
  }
  return items
}

/** 取 `<Import Project="…">` 的目标（不看条件）。 */
export function parseImportPaths(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<Import\b([^>]*?)\/?>/gi)) {
    const p = /\bProject\s*=\s*"([^"]*)"/i.exec(m[1])
    if (p) out.push(p[1])
  }
  return out
}

/**
 * 收集"**可能贡献编译项的文件**"（r43）。
 *
 * MSBuild 里能加 `<Compile>` 的地方不止 .csproj：
 *   · `Directory.Build.props`（在工程之前求值）与 `Directory.Build.targets`（之后）—— 会**逐级向上**找；
 *   · `<Import Project="…">` 导入的文件（可递归）。
 * 只读 .csproj 会把"其实会被编译"的文件误判成"不会"（**假 fail**），所以这里一并收集。
 *
 * 两条如实声明的口径：
 *   ① 祖先 `Directory.Build.props/.targets` **全部**收集（MSBuild 实际上只取最近的一层，
 *      除非那层自己再 import 上层）⇒ 这是**超集**，可能比 MSBuild 多算几项；
 *   ② 解析不了的 Import（路径里有 `$(...)` 宏）**不猜**，单独列为 unresolved。
 */
export function collectItemSources(projectPath, { repoRoot, maxImports = 20 } = {}) {
  const proj = resolve(projectPath)
  const projDir = dirname(proj)
  const stop = repoRoot ? resolve(repoRoot) : null
  const sources = [{ path: proj, role: 'project' }]
  const ancestors = []

  // 逐级向上找 Directory.Build.props / .targets
  let dir = projDir
  for (;;) {
    for (const name of ['Directory.Build.props', 'Directory.Build.targets']) {
      const p = join(dir, name)
      if (existsSync(p) && statSync(p).isFile()) ancestors.push({ path: p, role: name })
    }
    if (stop !== null && dir === stop) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  sources.push(...ancestors)

  const unresolvedImports = []
  const ignoredStandardImports = []
  const seen = new Set([proj, ...ancestors.map((a) => a.path)])
  const queue = [proj, ...ancestors.map((a) => a.path)]
  let truncated = 0
  while (queue.length) {
    const from = queue.shift()
    let xml = ''
    try { xml = readFileSync(from, 'utf8') } catch { continue }
    for (const raw of parseImportPaths(xml)) {
      if (MSBUILD_MACRO.test(raw)) {
        if (isStandardFrameworkImport(raw)) ignoredStandardImports.push(raw)
        else unresolvedImports.push(raw)
        continue
      }
      // 相对路径两种解释都试（见文件头 pathSemanticsNote）：先按导入文件自己的目录，再按工程目录
      const cands = isAbsolute(raw)
        ? [resolve(raw)]
        : [resolve(dirname(from), raw), resolve(projDir, raw)]
      const hit = cands.find((c) => existsSync(c) && statSync(c).isFile())
      if (!hit) { unresolvedImports.push(raw); continue }
      if (seen.has(hit)) continue
      if (seen.size >= maxImports + 2) { truncated++; continue }
      seen.add(hit)
      sources.push({ path: hit, role: 'import' })
      queue.push(hit)
    }
  }
  return {
    sources,
    unresolvedImports: [...new Set(unresolvedImports)],
    ignoredStandardImports: [...new Set(ignoredStandardImports)],
    truncated,
  }
}

/**
 * 判定一个源码文件是否属于某个工程的**编译集**。
 *
 * @param file       源文件（绝对路径）
 * @param projectPath 工程文件（绝对路径）；不给则自动往上找
 * @param repoRoot   自动查找的边界
 */
export function checkCompileMembership(file, { projectPath, repoRoot } = {}) {
  const abs = resolve(file)
  if (!existsSync(abs)) {
    return { ok: false, reason: 'file-missing', error: '文件不存在：' + abs, hint: '先确认路径（相对路径按当前工作目录解析）。' }
  }
  let proj = projectPath ? resolve(projectPath) : null
  let projectFoundBy = projectPath ? 'explicit' : null
  if (proj === null) {
    const found = findProjectFor(abs, { repoRoot })
    if (found === null) {
      // 往上找不到工程，有两种可能：
      //   ① 这个文件真的不属于任何工程；② 它被**别的目录**的工程用 `..\..\` 引用（跨目录 include）。
      // ②在真实仓库里很常见（r41 审计就查出 6 个"同名不同目录"的陷阱），而只靠"往上找"永远找不到它。
      // 所以给了 repoRoot 就扫一遍：**这正是判定器需要的那个答案**，不能以"找不到工程"收场。
      if (repoRoot) {
        const scan = findProjectsIncluding(abs, { repoRoot })
        if (scan.matches.length === 1) {
          proj = scan.matches[0].project
          projectFoundBy = 'repo-scan'
        } else if (scan.matches.length > 1) {
          return {
            ok: false, reason: 'ambiguous-project',
            error: '这个文件被**多个**工程列进了编译，无法判定你问的是哪一个：' + scan.matches.map((m) => m.project).join('、'),
            hint: '用 project 参数显式指定工程（"没读到"不是"不在"。）',
            candidates: scan.matches.map((m) => m.project),
            scannedProjects: scan.scannedProjects,
          }
        } else if (!scan.truncated) {
          return {
            ok: true, file: abs, project: null, relativePath: null, style: null,
            included: false, basis: 'not-referenced-by-any-project',
            matchedItem: null, matchedVia: null, matchedIn: null,
            scannedProjects: scan.scannedProjects, sources: [],
            note: '在 repoRoot（' + resolve(repoRoot) + '）下扫描了 **' + scan.scannedProjects +
              ' 个工程文件**，**没有任何一个**把它列进编译 ⇒ 在**这个仓库范围内**它是"谁都不编译"的文件。' +
              '⚠ 这与"构建通过"完全相容（legacy 工程不会自动包含 .cs）。' +
              '（结论的边界就是 repoRoot：仓库外还有别的工程时本结论不覆盖。）',
          }
        } else {
          return {
            ok: false, reason: 'scan-truncated',
            error: '往上没找到工程，扫描 repoRoot 下的工程时又被上限截断（' + scan.truncated + '，已扫 ' + scan.scannedProjects + ' 个）⇒ **无法判定**。',
            hint: '缩小 repoRoot（指到这个文件所在的那个工程树），或显式传 project。',
            scannedProjects: scan.scannedProjects, truncated: scan.truncated,
          }
        }
      } else {
        return {
          ok: false, reason: 'no-project-found',
          error: '从这个文件往上没找到工程文件（*.csproj / *.vbproj / *.fsproj）—— **这说明不了它没被编译**。',
          hint: '两种可能：① 它被**别的目录**的工程用 `..\\..\\` 引用（跨目录 include）；② 它真的不属于任何工程。' +
            '**给我 repoRoot 我就去扫**"哪个工程引用了它"；或者直接传 project 指定工程文件。',
        }
      }
    }
    // ⚠ 注意：上面 `found === null` 的分支里，repo-scan 可能已经**自己把 proj 定好了**
    //   （跨目录 include 的情形）。所以这里必须先判 found 是不是对象，不能直接读 found.ambiguous
    //   —— 我第一版就是直接读，真机抛了 `Cannot read properties of null`（测试当场抓住）。
    if (found && typeof found === 'object' && found.ambiguous) {
      return {
        ok: false, reason: 'ambiguous-project',
        error: '同一层有多个工程文件，无法判定该看哪一个：' + found.candidates.join('、'),
        hint: '用 project 参数显式指定（"没读到"不是"不在"。）',
        candidates: found.candidates,
      }
    }
    if (found) {
      proj = found
      projectFoundBy = 'walk-up'
    }
  }
  if (!existsSync(proj)) {
    return { ok: false, reason: 'project-missing', error: '工程文件不存在：' + proj }
  }

  const projDir = dirname(proj)
  const { sources, unresolvedImports, ignoredStandardImports, truncated } = collectItemSources(proj, { repoRoot })
  const sourceList = sources.map((s) => s.path)
  const readErrors = []
  const all = []
  const sourceXmls = []
  for (const s of sources) {
    let xml = ''
    try { xml = readFileSync(s.path, 'utf8') } catch (e) {
      readErrors.push({ path: s.path, error: e && e.message ? e.message : String(e) })
      continue
    }
    sourceXmls.push(xml)
    for (const it of parseCompileItems(xml)) all.push({ ...it, source: s.path, role: s.role })
  }
  if (readErrors.some((r) => r.path === proj)) {
    return {
      ok: false, reason: 'project-unreadable',
      error: '工程文件读不出来：' + (readErrors.find((r) => r.path === proj).error || '未知错误'),
      sources: sourceList, readErrors,
    }
  }

  const projXml = (() => { try { return readFileSync(proj, 'utf8') } catch { return '' } })()
  const rel = relative(projDir, abs).replace(/\\/g, '/')
  const sdkStyle = /<Project\b[^>]*\bSdk\s*=/i.test(projXml) || /<Project\b[^>]*\bSdk\s*=\s*"[^"]*"/i.test(projXml)
  // `EnableDefaultCompileItems=false` 可能写在工程里，也可能写在 Directory.Build.props 里（r43）
  const disableDefault = sourceXmls.some((x) => /<EnableDefaultCompileItems\s*>\s*false\s*<\/EnableDefaultCompileItems>/i.test(x))
  const conditioned = all.filter((i) => i.condition !== null)

  /** 一个 Include/Remove 模式是否命中这个文件（两种相对路径解释任一命中即可，见文件头）。 */
  const matchOf = (it) => {
    if (MSBUILD_MACRO.test(it.pattern)) return null // 宏：解析不了，不是"没命中"
    const fromSourceDir = relative(dirname(it.source), abs).replace(/\\/g, '/')
    const variants = [
      { relPath: rel, via: 'project-dir' },
      { relPath: fromSourceDir, via: 'source-dir' },
    ]
    for (const v of variants) {
      for (const cand of [v.relPath, './' + v.relPath]) {
        if (globToRegExp(it.pattern).test(cand)) return { via: v.via, relPath: v.relPath }
      }
    }
    return null
  }

  const base = {
    ok: true, file: abs, project: proj, relativePath: rel, style: sdkStyle ? 'sdk' : 'legacy',
    sources: sourceList, itemSourceCount: sourceList.length, unresolvedImports, truncatedImports: truncated,
    ignoredStandardImports,
    ignoredStandardImportsNote: ignoredStandardImports.length
      ? '忽略了 ' + ignoredStandardImports.length + ' 处**标准框架导入**（路径带 $(…) 宏、文件名是 Microsoft.*.targets/props，' +
        '例如 $(MSBuildToolsPath)\\Microsoft.CSharp.targets）—— 它们是 .NET 自带样板，不会给本项目加业务源码。' +
        '若你怀疑本工程用了**自定义** targets，请显式看这些文件。'
      : null,
    conditionsIgnored: conditioned.length,
    pathSemanticsNote: '相对路径的两种解释（工程目录 / 声明文件自己的目录）任一命中即算命中；' +
      'MSBuild 在版本间对导入文件的相对路径解析不一致，本工具**不站队**（见结果里的 matchedVia）。',
  }

  // 先看 Remove（显式排除优先）
  for (const it of all) {
    if (it.kind !== 'remove') continue
    const m = matchOf(it)
    if (m) {
      return {
        ...base,
        included: false, basis: 'removed', matchedItem: it.pattern, matchedVia: m.via, matchedIn: it.source,
        note: '工程/导入文件里有一条 `<Compile Remove="' + it.pattern + '" />` 命中了这个文件 ⇒ **它被显式排除**，不会进编译。' +
          '（声明它的文件：' + basename(it.source) + '）' +
          (conditioned.length ? '（注意：有 ' + conditioned.length + ' 条编译项带 Condition，本工具**不**求值条件。）' : ''),
      }
    }
  }

  // 再看 Include（含目录级 props/targets 与导入文件里的）
  for (const it of all) {
    if (it.kind !== 'include') continue
    const m = matchOf(it)
    if (m) {
      return {
        ...base,
        included: true, basis: 'explicit-item', matchedItem: it.pattern, matchedVia: m.via, matchedIn: it.source,
        note: '命中显式编译项 `<Compile Include="' + it.pattern + '" />` ⇒ **会进编译**。' +
          '（声明它的文件：' + basename(it.source) + '，命中方式：' + m.via + '）' +
          (conditioned.length ? '（有 ' + conditioned.length + ' 条编译项带 Condition，本工具**不**求值条件。）' : ''),
      }
    }
  }

  if (sdkStyle && !disableDefault) {
    return {
      ...base,
      included: true, basis: 'sdk-default-glob', matchedItem: null, matchedVia: null, matchedIn: null,
      note: '这是 **SDK 风格**工程且没有关掉默认项（`EnableDefaultCompileItems`）⇒ .cs 默认被 glob 包含，**会进编译**。' +
        '（依据是"工程风格 + 未关闭默认项"，不是逐条列举。）',
    }
  }

  // ---- 到这里只能给"不包含"。但先检查**我们是不是其实没看全**（r43 的核心诚实点）----
  const unresolvedPatterns = all.filter((i) => i.kind === 'include' && MSBUILD_MACRO.test(i.pattern)).map((i) => i.pattern)
  const blind = [...new Set(unresolvedPatterns)]
  if (blind.length || unresolvedImports.length || truncated || readErrors.length) {
    return {
      ...base,
      ok: false, reason: 'unresolved-item-sources',
      included: null,
      error: '**无法判定（判不了）**：没有任何条目命中这个文件，但我们的输入不完整 —— 所以**不能**说"它不在编译集里"。',
      unresolvedPatterns: blind,
      readErrors,
      hint: '不完整的原因见 unresolvedPatterns（路径里的 $(…) 宏）/ unresolvedImports（导入了但解析不了的文件）/ ' +
        'truncatedImports（导入层数超限）/ readErrors（文件读不出来）。' +
        '要拿到确定结论：① 把宏展开成绝对路径后重试；② 或者直接用一次**增量构建 + 观察这个文件有没有被编译**来验证。',
      note: '未命中任何条目，但存在 **' + (blind.length + unresolvedImports.length + truncated + readErrors.length) +
        ' 处解析不了的东西** ⇒ 三态里的"**判不了**"（不是 false，也不是 true）。',
    }
  }

  return {
    ...base,
    included: false, basis: sdkStyle ? 'sdk-default-disabled' : 'not-listed',
    matchedItem: null, matchedVia: null, matchedIn: null,
    note: (sdkStyle
      ? '这是 SDK 风格工程，但显式写了 `<EnableDefaultCompileItems>false</EnableDefaultCompileItems>` ⇒ 默认 glob 被关掉，'
      : '这是 **legacy** 工程（不会自动包含 .cs）⇒ ') +
      '必须有一条 `<Compile Include="' + rel + '" />` 才会进编译，而**看过的 ' + sourceList.length + ' 个文件里没有命中它的条目**。' +
      '⚠ 结论是"**这个工程没有把这个文件列进编译**"，与"构建通过"完全相容（这正是那个经典陷阱）。' +
      (conditioned.length ? '（另有 ' + conditioned.length + ' 条编译项带 Condition，本工具**不**求值。）' : ''),
  }
}

/** 人话渲染（工具面用）。 */
export function renderMembership(v) {
  if (!v || v.ok !== true) {
    const reasons = []
    if (v && v.unresolvedPatterns && v.unresolvedPatterns.length) reasons.push('带宏的编译项：' + v.unresolvedPatterns.join('、'))
    if (v && v.unresolvedImports && v.unresolvedImports.length) reasons.push('解析不了的 Import：' + v.unresolvedImports.join('、'))
    if (v && v.truncatedImports) reasons.push('导入层数被上限截断 ' + v.truncatedImports + ' 个')
    if (v && v.readErrors && v.readErrors.length) reasons.push('读不出来的文件：' + v.readErrors.map((r) => basename(r.path)).join('、'))
    return '⚠ **无法判定**：' + ((v && (v.error || v.reason)) || '原因未回报') +
      (reasons.length ? '\n  不完整的地方：' + reasons.join('；') : '') +
      (v && v.hint ? '\n下一步：' + v.hint : '')
  }
  const head = v.included
    ? '✅ **会进编译**：' + basename(v.file) + '（工程 ' + basename(v.project) + '，依据：' + v.basis + '）'
    : '❌ **不会进编译**：' + basename(v.file) + '（工程 ' + basename(v.project) + '，依据：' + v.basis + '）'
  const extra = []
  if (Array.isArray(v.sources) && v.sources.length > 1) extra.push('看过 ' + v.sources.length + ' 个文件：' + v.sources.map((s) => basename(s)).join('、'))
  if (v.matchedIn && v.matchedIn !== v.project) extra.push('条目声明在：' + basename(v.matchedIn))
  return head + '\n  ' + v.note + (extra.length ? '\n  ' + extra.join('\n  ') : '')
}
