// r54 单测：`lib/callee-wiring.mjs` —— 「工具 → 被调模块 → 具体函数」的静态接线。
//
// 为什么值得单独一个测试文件：这一轮我在**同一个模块里连踩 6 个 bug**，而它们**全都只表现为
// "什么都证不出来"**（不是报错、不是崩溃）：
//   ① `stripComments` 删注释 ⇒ 长度变了 ⇒ 拿它算出的下标去切原文全部错位（实测证到 0/356 个参数）；
//   ② `blankStrings` 遇到转义序列 2 个字符只吐 1 个 ⇒ 长度又变了；
//   ③ 只认字符串、**不认正则字面量** ⇒ `/['"]/g` 里的引号被当串首，一口吞掉半张文件（driver.mjs 78 个函数只认出 6 个）；
//   ④ `patternInfo` 没按逗号切分 ⇒ `{ runId, task, claims = [], … }` 只认出 runId；
//   ⑤ 不认可选链 `args?.P` ⇒ `hang_run` 明明读了却被判"没读到"；
//   ⑥ 不认识 handler 的 **method 简写** `async execute(args) {}` ⇒ 所有 DSH 工具的 callee 都解成 `execute`。
// 每一条都配一个断言钉在这里。第 19/44 类的老话：**判据放松一点就假绿、收紧一点就假红**，
// 而"看起来在跑、其实什么都没查"是最贵的一种失败。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripComments, blankStrings, functionDefs, rawDeclaredFunctionNames, patternInfo, patternBindings,
  paramIdentifier, fieldReadIndex, fieldReadIn, firstShadowIndex, bindingUsedInBody, callsIn, forwardsIn,
  splitTopLevel, handlerBodyOf, defineToolHandlerBody, buildScope, resolveCallee, analyzeParams, proveRead,
  reconstructsWholeArg,
  SCOPE_EXCLUSIONS,
} from './callee-wiring.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL = (abs) => relative(REPO, abs).replace(/\\/g, '/')
const exclusionTarget = 'plugins/dsh-api-visualizer/lib/client.js'
check('★ client.js 是单文件登记且理由可见', SCOPE_EXCLUSIONS[exclusionTarget] && /嵌套反引号\/模板内容导致简易扫描器失同步/.test(SCOPE_EXCLUSIONS[exclusionTarget]))
check('★ 登记不是目录/插件级放大', Object.keys(SCOPE_EXCLUSIONS).length === 1 && Object.keys(SCOPE_EXCLUSIONS)[0] === exclusionTarget)
const visibleScope = buildScope({ entryAbs: join(REPO, 'plugins/dsh-api-visualizer/lib/index.js'), extraDirs: [join(REPO, 'plugins/dsh-api-visualizer/lib')] })
check('★ 工具输出可见 excludedFiles，且明确不是无接线问题', visibleScope.excludedFiles.some((x) => x.file === exclusionTarget && /这不是/.test(x.reason)))
check('★ 其他 api-visualizer 文件仍参与候选集', visibleScope.files.has(join(REPO, 'plugins/dsh-api-visualizer/lib/index.js')) && !visibleScope.files.has(join(REPO, 'plugins/dsh-api-visualizer/lib/client.js')))

/** 本仓语料（lib + plugins，排除 node_modules / 测试文件）。 */
function corpusFiles() {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!['node_modules', '.git', 'bin', 'obj'].includes(e.name)) walk(join(d, e.name)) }
      else if (/\.(mjs|js)$/i.test(e.name) && !/\.test\.(mjs|js)$/i.test(e.name)) out.push(join(d, e.name))
    }
  }
  walk(join(REPO, 'lib'))
  walk(join(REPO, 'plugins'))
  walk(join(REPO, 'mcp'))
  return out
}

// ---------------------------------------------------------------- ① 扫描器：等长 + 正则字面量
//
// ⚠ 已知盲区（**必须登记，不许当成通过**）：简易扫描器没有做代码级作用域/模板嵌套解析，
//   在**把一整段带反引号的 HTML/JS 当成字符串嵌进自己文件**的那种源文件上会失同步。
//   影响面：该文件靠后的函数声明与字段读解析不到 ⇒ 相关工具只会被判 **unresolved**（假红方向），
//   不会把"没读"说成"读了"（假绿方向是安全的）。表**只许缩小**；哪天接上真解析器就该变空。
const SCANNER_BLIND_SPOTS = {
  'plugins/dsh-api-visualizer/lib/client.js': '文件里嵌了一整段带反引号的 HTML/JS 字符串（面板页面），简易扫描器在其中失同步；未接 AST 前如实登记',
  // 2026-09-23：同一根因的第二张面板（超大 JSON 折叠那批代码）。**不是"一直如此"** —— 实测
  //   HEAD 上该文件 missing=0（raw=93 / parsed=105），改动后 missing=87（raw=99 / parsed=14）。
  //   触发点已定位到 `isJsonOpenLine` 里那个正则字面量
  //   （`/^\s*(?:"(?:[^"\\]|\\.)*":\s*)?[\[{],?$/`）：把它单独换成常量后 parsed 立刻回到 111 /
  //   missing=0（因果已证）⇒ 是**扫描器被正则字面量骗到整片失同步**，不是那些函数真的没了。
  //   同一批改动也让上面 api-visualizer 的 missing 从 2 涨到 14（两张面板同一形状）。
  // ⚠ 而该文件还进 `buildScope` 的语料（`lib/callee-wiring.mjs` 的 SCOPE_EXCLUSIONS 只登记了
  //   api-visualizer）⇒ 它在**接线分析**里也只剩 14 个 def（HEAD 是 105）。当前没有 handler 转发到
  //   这个文件里的函数，所以没有工具因此掉进 unresolved；但那是**未证**，不等于"没问题"。
  'plugins/dsh-postman/lib/client.js': '内嵌面板页面 + 折叠代码里的正则字面量 ⇒ 简易扫描器整片失同步：99 个函数声明里 87 个解析不到（HEAD 上为 0）；未接 AST 前如实登记',
}
{
  const files = corpusFiles()
  check('★ 语料非空（读到 0 个文件 = 下面几条全变空断言）', files.length > 40, String(files.length))
  let lenBad = [], swallowed = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    // ① 等长是**硬要求**：本模块在"挖干净"的文本上找位置、再拿位置去切原文
    if (stripComments(src).length !== src.length) lenBad.push(REL(f) + '/stripComments')
    if (blankStrings(src).length !== src.length) lenBad.push(REL(f) + '/blankStrings')
    // ③ 扫描器被正则字面量/模板串骗到时，函数会成片丢失 —— 用"行首朴素正则"当对照组
    const raw = rawDeclaredFunctionNames(src)
    const got = functionDefs(src)
    const missing = [...raw].filter((n) => !got.has(n))
    if (missing.length && !SCANNER_BLIND_SPOTS[REL(f)]) swallowed.push(REL(f) + ':' + missing.slice(0, 5).join(','))
  }
  check('★★ 每个源文件的 stripComments/blankStrings 输出**与输入等长**（长度一变，所有下标错位 → 全盘证不出来）',
    lenBad.length === 0, lenBad.slice(0, 5).join(' , '))
  check('★★ 除了已登记的盲区，解析器认出了**全部**函数声明（对照：行首朴素正则）',
    swallowed.length === 0, swallowed.slice(0, 5).join(' , ') + '（要么修好，要么加进 SCANNER_BLIND_SPOTS 并写理由）')
  const healed = Object.keys(SCANNER_BLIND_SPOTS).filter((rel) => {
    const got = functionDefs(readFileSync(join(REPO, rel), 'utf8'))
    return [...rawDeclaredFunctionNames(readFileSync(join(REPO, rel), 'utf8'))].every((n) => got.has(n))
  })
  check('★ 盲区登记只许缩小：已经修好的应从 SCANNER_BLIND_SPOTS 删掉', healed.length === 0, healed.join(', '))
  console.log('       （扫描器盲区登记：' + Object.keys(SCANNER_BLIND_SPOTS).join(', ') + '；**未接 AST** —— Codex r54 §4-R1 的建议，列为下一步）')
  // 具体回归：这一条就是当时那个 bug 的最小复现
  const tricky = "const re = /['\"]/g\nfunction after() { return 1 }\n"
  check('★ 正则字面量 `/[\'"]/g` 之后声明的函数必须仍被认出（当时它整片丢了）',
    functionDefs(tricky).has('after'), [...functionDefs(tricky).keys()].join(','))
  check('★ 带转义序列的字符串不会让输出变短（反斜杠+引号 / 反斜杠+n）',
    blankStrings("const a = 'x\\'y\\nz';").length === "const a = 'x\\'y\\nz';".length)
}

// ---------------------------------------------------------------- ④ 解构模式：按顶层逗号切分
{
  const info = patternInfo('{ runId, task, claims = [], context = {}, recordFailures = true } = {}')
  check('★★ 形参解构的**每个**顶层名都认出来（当时漏了 task / claims）',
    info.names && ['runId', 'task', 'claims', 'context', 'recordFailures'].every((n) => info.names.has(n)),
    JSON.stringify([...(info.names || [])]))
  check('★ 重命名解构读的是**属性名**（`{ P: alias }` → P）', patternBindings('{ P: alias, Q = 1 }').has('P'))
  check('★ `...rest` 被识别出来（收下了 ≠ 用了，所以它**不算**读取点）',
    patternInfo('{ a, ...rest }').hasRest === true && patternInfo('{ a }').hasRest === false)
  check('★ 非解构形参返回 null（交给字段访问规则），而不是空集合冒充"没有"',
    patternBindings('args = {}') === null && patternBindings('args') === null)
  check('★ 形参标识符提取：`args` / `args = {}` / `...args` 都 → args',
    paramIdentifier('args') === 'args' && paramIdentifier('args = {}') === 'args' && paramIdentifier('...args') === 'args')
}

// ---------------------------------------------------------------- ⑤ 字段访问：可选链
{
  check('★ `args.p` 认', fieldReadIn('const x = args.p', 'args', 'p'))
  check('★★ `args?.p` 也认（可选链 —— `hang_run` 就是这样读 maxSeconds 的）',
    fieldReadIn('hang.startRun({ maxSeconds: args?.maxSeconds ?? 0 })', 'args', 'maxSeconds'))
  check('★ `args["p"]` 认', fieldReadIn("const x = args['p']", 'args', 'p'))
  check('★★ 没有接收者的裸字段名**不认**（否则提示语里的 `.p` 会冒充读取点）',
    !fieldReadIn('const s = ".p"', 'args', 'p') && !fieldReadIn('p: { type: "number" }', 'args', 'p'))
  check('★ 认的是**位置**（要拿它跟遮蔽位置比）', fieldReadIndex('const a=args.p', 'args', 'p') === 8)
}

// ---------------------------------------------------------------- 遮蔽：只信"重新声明之前"
{
  const body = 'const a = args.p\nconst args2 = 1\nconst args = {}\nconst b = args.q\n'
  const shadow = firstShadowIndex(body, 'args')
  check('★ 找得到重新声明的位置', shadow > 0, String(shadow))
  check('★★ 重新声明**之前**的读取点采信、之后的**不采信**（没有 AST 就不猜作用域）',
    fieldReadIndex(body, 'args', 'p') < shadow && fieldReadIndex(body, 'args', 'q') > shadow)
  check('★ 没有重新声明时返回 -1', firstShadowIndex('const b = args.q', 'args') === -1)
}

// ---------------------------------------------------------------- ⑦ 转发：多个目标 + 实参序号
{
  const body = 'const res = await driveInner(args); return attachEvidence(res, args)'
  const fwds = forwardsIn(body, 'args')
  check('★★ 一次函数体里**所有**转发都要找到（当时只取了第一个）', fwds.length === 2, JSON.stringify(fwds))
  check('★★ 实参序号要准：`attachEvidence(res, args)` 的整包在**第 1 个**实参',
    fwds.some((f) => f.name === 'attachEvidence' && f.argIndex === 1), JSON.stringify(fwds))
  check('★ `f({ ...args })` 认（转发的仍是整包）', forwardsIn('fn({ ...args, x: 1 })', 'args').length === 1)
  check('★★ `f({ x: args.x })` **不认** —— 那是按字段重建对象，参数在不在链上静态不可知（Codex r54 §1.5）',
    forwardsIn('fn({ x: args.x })', 'args').length === 0)
  check('★ `callsIn` 不会把关键字当函数名', callsIn('if (a) { for (;;) {} }').length === 0)
}

// ---------------------------------------------------------------- ⑥ handler 体的两种写法
{
  const arrow = handlerBodyOf('async (args) => jtext(await trc().trace(args))')
  check('★ 表达式体箭头函数', arrow.kind === 'arrow-expr' && arrow.argsIdent === 'args' && /trace\(args\)/.test(arrow.bodyRaw))
  const block = handlerBodyOf('async (args) => { return 1 }')
  check('★ 块体箭头函数', block.kind === 'arrow-block' && block.bodyRaw === '{ return 1 }')
  const method = defineToolHandlerBody("{ name: 'x', async execute(args) { return drive(args) } }")
  check('★★ DSH 面的 **method 简写** `async execute(args) {}` 要认（不认的话所有 DSH 工具的 callee 都解成 execute）',
    method.kind === 'method' && method.argsIdent === 'args' && /drive\(args\)/.test(method.bodyRaw), JSON.stringify(method))
  const prop = defineToolHandlerBody("{ name: 'x', execute: async (args) => foo(args) }")
  check('★ DSH 面的属性箭头函数也要认', /foo\(args\)/.test(prop.bodyRaw), JSON.stringify(prop))
}

// ---------------------------------------------------------------- 端到端（用真实仓库的结构）
{
  const entry = join(REPO, 'plugins', 'dsh-verify', 'index.js')
  check('★ 薄壳插件（入口只有 index.js、实现动态 import lib/）能建出候选集', existsSync(entry))
  const scope = buildScope({ entryAbs: entry, extraDirs: [join(REPO, 'lib')] })
  const r = resolveCallee(scope, 'query')
  check('★★ 被调方能被解出来（`query` 在 lib/failure-corpus.mjs 里定义；入口是**动态** import）',
    r.ok && /failure-corpus\.mjs$/.test(r.abs), r.ok ? r.abs : r.reason)
  check('★ 同名多个定义时**拒答**而不是乱挑一个（把猜的部分变成 unresolved）',
    (() => { const sc = buildScope({ entryAbs: entry, extraDirs: [join(REPO, 'lib')] }); sc.byName.set('dup', [{ abs: 'a', def: {} }, { abs: 'b', def: {} }]); return resolveCallee(sc, 'dup').ok === false })())
}

// ---------------------------------------------------------------- 反向自证：这几条必须**判不出**
{
  const scope = buildScope({ entryAbs: join(REPO, 'lib', 'callee-wiring.mjs'), extraDirs: [] })
  // 造一个真实的解构消费函数，再验证 proveRead 只在"确实读不到"时才给 unresolved
  // ⚠ 体内必须**真的引用** alpha/beta —— 规则 A 现在要核"被引用过"（见下面 Claude §Q1 那组）。
  const def = { name: 'fake', paramsRaw: '({ alpha = 1, beta = 2 } = {})', bodyRaw: '{ return alpha + beta }' }
  const res = proveRead({ scope, fromFile: 'fake.mjs', def, params: ['alpha', 'beta', 'gamma'], repoRel: REL })
  check('★★ 解构里有的参数证到、**没有的必须 unresolved**（否则这条规则会变成"什么都通过"）',
    res.reads.has('alpha') && res.reads.has('beta') && !res.reads.has('gamma') &&
      /not-a-top-level-binding/.test(res.reasons.get('gamma')), JSON.stringify([...res.reads.keys()]) + ' / ' + res.reasons.get('gamma'))
  const restDef = { name: 'fake2', paramsRaw: '({ alpha, ...rest } = {})', bodyRaw: '{ return alpha }' }
  const res2 = proveRead({ scope, fromFile: 'fake2.mjs', def: restDef, params: ['alpha', 'zeta'], repoRel: REL })
  check('★★ `...rest` 收下的参数**不算证到**（"接了然后悄悄丢掉"正是本闸要抓的假实现）',
    res2.reads.has('alpha') && !res2.reads.has('zeta') && /destructured-into-rest/.test(res2.reasons.get('zeta')),
    JSON.stringify([...res2.reads.keys()]) + ' / ' + res2.reasons.get('zeta'))
}

// ---------------------------------------------------------------- ★ Claude r54 §Q1 的两条假绿通道（必须有断言堵住）
{
  const scope = buildScope({ entryAbs: join(REPO, 'lib', 'callee-wiring.mjs'), extraDirs: [] })

  // ① 解构成了但**从没被使用** ⇒ 不许算读到（否则"重构时把某个字段的使用删了、模式留着"会假绿）
  const unusedDef = { name: 'unused', paramsRaw: '({ alpha = 1, beta = 2 } = {})', bodyRaw: '{ return alpha }' }
  const r1 = proveRead({ scope, fromFile: 'u.mjs', def: unusedDef, params: ['alpha', 'beta'], repoRel: REL })
  check('★★ 解构了却**没被引用**的参数必须判 unresolved（rule A 现在要核"体内被引用过"）',
    r1.reads.has('alpha') && !r1.reads.has('beta') && /destructured-but-never-used/.test(r1.reasons.get('beta')),
    JSON.stringify([...r1.reads.keys()]) + ' / ' + r1.reasons.get('beta'))
  check('★ `x.alpha` 里的 `alpha` 不算"引用了绑定"（属性名不是标识符引用）',
    bindingUsedInBody('const v = row.alpha', 'alpha') === false)
  check('★ 正常引用认得出（`arr.push(alpha)` / `alpha + 1`）',
    bindingUsedInBody('arr.push(alpha)', 'alpha') && bindingUsedInBody('return alpha + 1', 'alpha'))

  // ② **嵌套函数的形参**遮蔽：`arr.map((args) => args.p)` 里的读属于内层对象，不是外层整包
  const nestedBody = '{ const src = spec; return list.map((args) => args.p) }'
  check('★★ 嵌套箭头函数的形参遮蔽要被认出来（否则内层的 `args.p` 会被记到外层整包上 ⇒ 真·假绿）',
    firstShadowIndex(nestedBody, 'args') > 0, String(firstShadowIndex(nestedBody, 'args')))
  check('★ `function (args) { … }` 形式的嵌套形参同样算遮蔽',
    firstShadowIndex('{ return list.map(function (args) { return args.p }) }', 'args') > 0)
  check('★ 不能把 `for (const k of args) {` 误判成遮蔽（那是**使用**，不是重声明）',
    firstShadowIndex('{ for (const k of args) { use(k) } }', 'args') === -1)
  const r2 = proveRead({ scope, fromFile: 'n.mjs', def: { name: 'nested', paramsRaw: '({ spec } = {})', bodyRaw: nestedBody }, params: ['spec'], repoRel: REL })
  const r3 = proveRead({ scope, fromFile: 'n2.mjs', def: { name: 'nested2', paramsRaw: '(args)', bodyRaw: nestedBody }, params: ['p'], repoRel: REL })
  check('★★ 内层形参遮蔽之后的 `args.p` **不许**被当成外层整包的读取点',
    !r3.reads.has('p'), JSON.stringify([...r3.reads.keys()]) + ' / ' + r3.reasons.get('p'))
  check('（对照）同一函数体里另一个解构参数仍应证到 —— 别把整条规则一起关掉', r2.reads.has('spec'))
}

// ---------------------------------------------------------------- 同名候选：按**最浅那层**取舍
{
  const entry = join(REPO, 'plugins', 'dsh-verify', 'index.js')
  const sc = buildScope({ entryAbs: entry, extraDirs: [join(REPO, 'lib')] })
  check('★★ 同名定义在**不同深度**时取最浅的那个（真实被调方写在工厂函数里，depth=1；'
    + '我自己模块里的局部小工具 depth=2 —— 若"有一个就冲突"会把它误判成歧义，'
    + '这正是全量自检当场抓到的那个红）',
    resolveCallee(sc, 'query').ok === true, JSON.stringify(resolveCallee(sc, 'query')))
  const sc2 = buildScope({ entryAbs: entry, extraDirs: [] })
  sc2.byName.set('dup', [{ abs: 'a.mjs', def: { depth: 2 } }, { abs: 'b.mjs', def: { depth: 2 } }])
  check('★ 同一层有 ≥2 个定义才叫歧义（拒答，不乱挑）', resolveCallee(sc2, 'dup').ok === false)
  sc2.byName.set('dup2', [{ abs: 'a.mjs', def: { depth: 1 } }, { abs: 'b.mjs', def: { depth: 3 } }])
  check('★ 深浅不同 ⇒ 取浅的，不算歧义',
    resolveCallee(sc2, 'dup2').ok === true && /a\.mjs$/.test(resolveCallee(sc2, 'dup2').abs))
}

// ---------------------------------------------------------------- ★ D.3（r61）：对象重建链的**理由要写准**
//
// `api_capture_query`（DSH 面）的 handler 是 `const params = paramsFromObj(args); applyFilters(all, params)`。
// `paramsFromObj(obj)` 用 `Object.entries(obj)` 泛枚举重建成 URLSearchParams，真正的读在 `applyFilters`
// 的 `params.get('P')`（键名还可能被 FILTER_PARAM_ALIASES 改写）—— 静态**跟不过**，保持"未查"是对的。
// 但**理由**必须与"这个参数根本没人读"分开（本仓口径：原因不许糊成一句）。这一节把这条口径钉死：
//   ① 经 paramsFromObj 的参数仍 unresolved（不制造假绿）；
//   ② 但理由是 `args-reconstructed-generically`，不是 `no-field-read-in-callee-function-body`；
//   ③ 反向自证：真·没读到时理由**仍是** no-field-read（否则新理由会把真问题一起吞掉 ⇒ 假绿）。
// 证伪：把 lib/callee-wiring.mjs 里 `reconstructsWholeArg` 的判定还原掉，②必红。
{
  const apiEntry = join(REPO, 'plugins', 'dsh-api-visualizer', 'lib', 'index.js')
  check('★ dsh-api-visualizer 入口存在（读不到 = 下面几条变空断言）', existsSync(apiEntry))
  if (existsSync(apiEntry)) {
    const sc = buildScope({ entryAbs: apiEntry, extraDirs: [join(REPO, 'lib')] })
    const pf = resolveCallee(sc, 'paramsFromObj')
    check('★★ 能解出**真实的** paramsFromObj 被调方（api_capture_query 的整包就转发给它）',
      pf.ok && /dsh-api-visualizer\/lib\/index\.js$/.test(REL(pf.abs)), pf.ok ? REL(pf.abs) : pf.reason)
    if (pf.ok) {
      const rr = proveRead({ scope: sc, fromFile: pf.abs, def: pf.def, params: ['status', 'host', 'q'], repoRel: REL })
      check('★★ 经 paramsFromObj 的参数**证不到**（Object.entries 泛枚举 + 键名可能被改写 ⇒ 保持"未查"，不假绿）',
        !rr.reads.has('status') && !rr.reads.has('host') && !rr.reads.has('q'), JSON.stringify([...rr.reads.keys()]))
      check('★★ 但**理由写准**：是"整包被泛枚举重建"，不是"没读到"（D.3：不许糊成一句）',
        /args-reconstructed-generically/.test(rr.reasons.get('status') || ''), rr.reasons.get('status'))
    }
  }
  // helper 自证：命中泛枚举构造才给"重建"标记
  check('★ reconstructsWholeArg 认得出 Object.entries(obj)',
    reconstructsWholeArg('{ for (const [k, v] of Object.entries(obj)) f(k, v) }', 'obj') === 'Object.entries')
  check('★ 也认 for-in / Object.keys / Object.assign',
    reconstructsWholeArg('{ for (const k in obj) {} }', 'obj') === 'for-in' &&
    reconstructsWholeArg('{ return Object.keys(obj) }', 'obj') === 'Object.keys' &&
    reconstructsWholeArg('{ Object.assign(t, obj) }', 'obj') === 'Object.assign')
  check('★★ 字符串/注释里的 Object.entries(obj) **不算**（必须在 blankStrings 后的代码骨架上判）',
    reconstructsWholeArg('{ const s = "Object.entries(obj)"; return 1 }', 'obj') === '')
  // ★★ 反向自证：真·没读到（既不按字段读、也不泛枚举重建）⇒ 理由**仍是** no-field-read，两者必须分得开
  {
    const scope = buildScope({ entryAbs: join(REPO, 'lib', 'callee-wiring.mjs'), extraDirs: [] })
    const noop = { name: 'noop', paramsRaw: '(obj)', bodyRaw: '{ return 1 }' }
    const rn = proveRead({ scope, fromFile: 'noop.mjs', def: noop, params: ['status'], repoRel: REL })
    check('★★ （反向自证）真·没读到 ⇒ no-field-read，**不是** reconstructed（否则新理由会吞掉真问题 = 假绿）',
      /no-field-read-in-callee-function-body/.test(rn.reasons.get('status') || '') &&
      !/reconstructed-generically/.test(rn.reasons.get('status') || ''), rn.reasons.get('status'))
  }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: callee-wiring（扫描器等长 / 正则字面量 / 解构按逗号切分 / 可选链 / 遮蔽前后 / 多目标转发与实参序号 / handler 两种写法 / D.3 对象重建理由）')
