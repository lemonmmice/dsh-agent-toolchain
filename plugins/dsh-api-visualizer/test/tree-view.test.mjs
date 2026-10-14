// dsh-api-visualizer 单测：P1-5 域名树（Fiddler 式「域名 → 路径段 → 单条请求」）
//
// 为什么用"vm 里跑真文件"而不是像 filter-drift 那样只扫源码：这个视图的核心是**一棵
// 折树的语义**（计数是子树合计、错误归到每一层、解析不出域名的 URL 不许被静默丢掉、
// 默认只展开最近命中的域）。源码级正则钉不住这些 —— 只有把 buildUrlTree 真的跑起来
// 才算证明。client.js 是 __ModuleLoader__ 包装的浏览器 bundle，直接 import 会碰
// document/localStorage，所以这里给一份最小 DOM 桩、在 vm 里求值。
//
// 三段：
//   1. 纯函数语义（buildUrlTree 真跑）；
//   2. **真渲染**（DOM 桩 + 假 fetch：点「域名树」→ 检查画出来的行，逐层展开到底）；
//   3. 接线哨兵（纯函数再对，没接到 refresh/setView 上也等于没做；这部分只能扫源码，
//      这里如实说明它是哨兵、不是行为证明）。
//
// 这一段真的抓到过**三个产品缺陷**（都已修，别再犯）：
//   · 路径节点的 children 只在"第一次下降"时转数组 → 第二个同级兄弟根本没进数组，
//     整条分支静默消失；
//   · 路径节点的 key 写成 `domain + '|' + cur.key` → 同域下所有路径段撞成同一串，
//     展开一个兄弟等于动了另一个（key 现在是完整路径）；
//   · renderTree 不清自己的容器（靠外面先清）→ 重入就叠出第二棵树。
// 另外记两条桩的坑（踩了半小时的对角线）：`el.textContent = ''` 在真 DOM 里会清空
// 子节点（桩里必须照做，否则"清空"变空操作，看着像产品缺陷）；有些 helper 是**外层
// realm** 的回调，读的是 Node 的全局 document（undefined 就早退），所以桩要同时挂全局。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

// ------------------------------------------------------------------ DOM 桩
// 只要面板渲染用得到的那点：createElement/appendChild/textContent/dataset/style/hidden/
// classList/addEventListener + 能被查的子树。**带 children 数组**是必须的 —— 少了它
// "分支有没有挂上去"就查不出来（而这正是上面那个真缺陷的形状）。
function makeNode(tag = 'div') {
  let textContent = ''
  const node = {
    tagName: String(tag).toUpperCase(), className: '', title: '', hidden: false,
    dataset: {}, style: { cssText: '' }, _attrs: {},
    childNodes: [], children: [], parentNode: null, firstChild: null, lastChild: null, _listeners: {},
    // 真 DOM 里 `el.textContent = ''` 会**清空子节点**（面板清容器就靠这一招）。
    // 桩里只当普通属性写过，会让"清空"变成空操作 —— 于是旧内容留在树上，
    // 看上去像"点一次多一棵树"的产品缺陷（实际是桩的偏差）。
    get textContent() {
      return node.childNodes.length === 0 ? textContent : node.childNodes.map((c) => (c.tagName === '#TEXT' ? c.textContent : '')).join('')
    },
    set textContent(v) {
      textContent = String(v)
      node.childNodes = []
      node.children = []
      node.firstChild = null
      node.lastChild = null
    },
    appendChild(c) {
      c.parentNode = node
      node.childNodes.push(c)
      if (c.tagName !== '#TEXT') node.children.push(c)
      node.firstChild = node.childNodes[0]
      node.lastChild = node.childNodes[node.childNodes.length - 1]
      return c
    },
    insertBefore(c) { c.parentNode = node; node.childNodes.unshift(c); if (c.tagName !== '#TEXT') node.children.unshift(c); node.firstChild = c; return c },
    removeChild(c) { node.childNodes = node.childNodes.filter((x) => x !== c); node.children = node.children.filter((x) => x !== c); c.parentNode = null; return c },
    remove() { if (node.parentNode !== null) node.parentNode.removeChild(node) },
    setAttribute(k, v) { node._attrs[k] = String(v) },
    getAttribute(k) { return node._attrs[k] ?? null },
    removeAttribute(k) { delete node._attrs[k] },
    addEventListener(type, fn) { (node._listeners[type] ??= []).push(fn) },
    removeEventListener() {},
    dispatch(type, event = {}) { for (const fn of node._listeners[type] ?? []) fn({ stopPropagation() {}, preventDefault() {}, target: node, ...event }) },
    querySelector(sel) { return collectAll(node, (n) => n !== node && matchesSelector(n, sel))[0] ?? null },
    querySelectorAll(sel) { return collectAll(node, (n) => n !== node && matchesSelector(n, sel)) },
    classList: {
      add(c) { const set = new Set(node.className.split(/\s+/).filter(Boolean)); set.add(c); node.className = [...set].join(' ') },
      remove(c) { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' ') },
      toggle(c, on) { if (on === true) node.classList.add(c); else if (on === false) node.classList.remove(c); else if (node.className.split(/\s+/).includes(c)) node.classList.remove(c); else node.classList.add(c) },
      contains(c) { return node.className.split(/\s+/).includes(c) },
    },
    focus() {}, blur() {}, click() { node.dispatch('click') }, scrollIntoView() {}, closest() { return null },
  }
  return node
}
const textNode = (t) => ({ tagName: '#TEXT', textContent: String(t), childNodes: [], children: [], dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} })

// 最小选择器匹配：只要 [attr] / [attr="v"] / .cls / tag 这几种 —— 面板与我们的定位都用这些。
// （真实浏览器有完整 CSS 选择器；这里是桩，不支持的选择器宁可返回 null，也不假装匹配上。）
function matchesSelector(node, selector) {
  for (const part of String(selector).split(',').map((s) => s.trim()).filter(Boolean)) {
    const attrEq = /^\[([\w-]+)="([^"]*)"\]$/.exec(part)
    const attrHas = /^\[([\w-]+)\]$/.exec(part)
    const cls = /^\.([\w-]+)$/.exec(part)
    if (attrEq !== null) { if (node._attrs?.[attrEq[1]] === attrEq[2]) return true; continue }
    if (attrHas !== null) { if (node._attrs?.[attrHas[1]] !== undefined) return true; continue }
    if (cls !== null) { if (String(node.className).split(/\s+/).includes(cls[1])) return true; continue }
    if (new RegExp(`^${part}$`, 'i').test(node.tagName)) return true
  }
  return false
}
function collectAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node)
  for (const child of node.children) collectAll(child, predicate, out)
  return out
}

/** 在 DOM 桩里求值 client.js 并挂载面板，返回可操作的句柄。 */
function mountPanel(records) {
  const html = makeNode('html')
  const byId = new Map()
  // 假 postman 面板：只为让 injectPostmanBackBtn 接线成功 —— 它的「← 接口捕获」按钮
  // 是外部唯一能直接调 setOpen(true) 的入口，有了它才能不靠轮询、确定性地驱动面板。
  const pmToolbar = makeNode('div')
  pmToolbar.className = 'pm-toolbar'
  pmToolbar.appendChild(makeNode('button')).className = 'pm-close'
  const pmView = makeNode('div')
  pmView._attrs['data-dsh-postman-view'] = ''
  pmView.appendChild(pmToolbar)
  const documentStub = {
    createElement: (tag) => makeNode(tag),
    createTextNode: textNode,
    createDocumentFragment: () => makeNode('fragment'),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector(sel) {
      // 真 document.querySelector 搜的是整棵树；这里只需要覆盖两个用法：
      // 面板自己的 centerColumn()（[data-pane=…]/[class*=centerCol] → 回退 body）
      // 与 injectPostmanBackBtn 找的假 postman 面板。
      const hit = collectAll(pmView, (n) => matchesSelector(n, sel))[0]
      return hit === undefined ? null : hit
    },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: makeNode('body'), head: makeNode('head'), documentElement: html,
  }
  // 有些 helper 是**外层 realm**（本测试进程）在跑的回调，它们读的是 Node 的全局
  // document（undefined → 直接早退，桩看起来"没被调用"）。把桩同时挂到全局，
  // 让"哪个 realm 调的"不再影响结果。
  globalThis.document = documentStub
  // injectStyle 会把 <style> 挂到 head 并靠 getElementById 去重 —— 桩里得真的记住它
  const realAppend = documentStub.head.appendChild
  documentStub.head.appendChild = (child) => { if (child.id) byId.set(child.id, child); return realAppend.call(documentStub.head, child) }
  const fetchLog = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { sandbox.__spec = spec } },
      addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    document: documentStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node-test', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1:3080/' },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: async (url) => {
      const href = String(url)
      fetchLog.push(href)
      const body = href.includes('/records') ? { total: records.length, items: records, hasMore: false }
        : href.includes('/stats') ? { total: records.length, lastTs: records[0]?.ts ?? 0, byMethod: {}, byStatus: {}, bySource: {} }
          : {}
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }
    },
    console, URL, URLSearchParams, TextEncoder, TextDecoder,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Map, Set, WeakMap, RegExp, Error, TypeError, Promise, Symbol, Intl,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox.window
  vm.runInNewContext(source, sandbox, { filename: clientPath })
  const mod = sandbox.__spec.factory(() => { throw new Error('test: require 不该被调用') })
  // 面板被挂到 centerColumn() 上，而它在 querySelector 返回 null 时回退到 document.body ——
  // 所以"面板在哪"要问 document，不是问 documentElement。
  return { mod, document: documentStub, fetchLog }
}

/** 语义断言用同一套遍历（只有一份实现，避免两处遍历口径漂移） */
const collect = collectAll
const byClass = (root, cls) => collect(root, (n) => typeof n.className === 'string' && n.className.split(/\s+/).includes(cls))
const byText = (root, t) => collect(root, (n) => n.tagName !== '#TEXT' && n.textContent === t)
const indentOf = (node) => Number((/padding-left:\s*(\d+)px/.exec(node?.style?.cssText ?? '') ?? [])[1] ?? NaN)

let buildUrlTree = null
let mount = null
try {
  mount = mountPanel([])
  buildUrlTree = mount.mod?.__buildUrlTree ?? null
} catch (error) {
  console.log('  FAIL client.js 在 vm 里求值失败 — ' + error.message)
  failures++
}
check('client.js 能在最小桩下求值并导出 __buildUrlTree（没导出则整棵树的语义无法被验证）', typeof buildUrlTree === 'function')

// ------------------------------------------------------------------ 语义
if (typeof buildUrlTree === 'function') {
  const rec = (id, ts, method, url, status, durationMs = 1) => ({ id, ts, method, url, status, durationMs })
  const records = [
    rec('a1', 100, 'GET', 'https://api.example.com/quant/BacktestStrategy/GetStrategyLogic?packType=2000&version=1.2.3', 200, 12),
    rec('a2', 110, 'GET', 'https://api.example.com/quant/BacktestStrategy/GetStrategyLogic?packType=2001&version=1.2.3', 500, 30),
    rec('a3', 120, 'POST', 'https://api.example.com/quant/BacktestStrategyMall/GetStock?packType=2000', 404, 7),
    rec('b1', 200, 'GET', 'https://push.example.com/api/v1/list', 200, 5),
    rec('c1', 300, 'GET', '/relative/no-host', 200, 2),
    rec('c2', 310, 'GET', 'about:blank', 200, 2),
  ]
  const tree = buildUrlTree(records)

  const byDomain = new Map(tree.domains.map((d) => [d.domain, d]))
  check('域名分桶：2 个真域名 + 1 个「(无法归簇)」桶', tree.domains.length === 3 && byDomain.has('api.example.com') && byDomain.has('push.example.com') && byDomain.has('(无法归簇)'), tree.domains.map((d) => d.domain).join(','))
  check('合计 = 入参条数（一条都没被吃掉）', tree.total === records.length, String(tree.total))
  check('计数是子树合计（apicore 3 条）', byDomain.get('api.example.com')?.count === 3, String(byDomain.get('api.example.com')?.count))
  check('错误计数归到域名层（apicore 2 个 4xx/5xx）', byDomain.get('api.example.com')?.errors === 2, String(byDomain.get('api.example.com')?.errors))
  check('无法归簇桶标了 noHost + 计数照算（2 条）', byDomain.get('(无法归簇)')?.noHost === true && byDomain.get('(无法归簇)')?.count === 2, JSON.stringify(byDomain.get('(无法归簇)')))

  // 渲染层直接 `for (const child of node.children)` —— 残留 Map 会迭代出 [key,value] 对，
  // 于是整层路径静默不渲染（这正是一次真缺陷：只有域名层被统一转过数组）。
  const arrayShape = []
  const walkShape = (node, where) => {
    if (!Array.isArray(node.children)) arrayShape.push(`${where}.children 不是数组`)
    if (node.records !== undefined && !Array.isArray(node.records)) arrayShape.push(`${where}.records 不是数组`)
    for (const child of node.children) walkShape(child, `${where}/${child.label}`)
  }
  for (const domain of tree.domains) walkShape(domain, domain.domain)
  check('每一层的 children/records 都是数组（渲染层 for..of 的前提）', arrayShape.length === 0, arrayShape.slice(0, 3).join('; '))

  const urlSegments = (domain, ...segments) => {
    let node = byDomain.get(domain)
    for (const seg of segments) {
      if (node === undefined) return undefined
      node = node.children.find((c) => c.label === seg)
    }
    return node
  }
  // 展开态是按 key 记的 —— key 必须唯一标识"哪一支"，否则展开一个兄弟等于动了另一个。
  // （真缺陷：key 曾写成 domain + '|' + cur.key，同域下所有路径段撞成同一串。）
  {
    const keys = []
    const walkKeys = (node) => { if (node.kind === 'path') keys.push(node.key); for (const c of node.children) walkKeys(c) }
    for (const d of tree.domains) walkKeys(d)
    check('每个路径节点的 key 唯一（展开态不会互相串）', new Set(keys).size === keys.length, keys.join(' | '))
    check('路径 key = 完整父路径 + 本级段（可读、可定位）',
      keys.includes('api.example.com|quant') && keys.includes('api.example.com|quant|BacktestStrategy') && keys.includes('api.example.com|quant|BacktestStrategyMall'),
      keys.join(' | '))
  }
  check('路径按 / 分段：quant → BacktestStrategy', urlSegments('api.example.com', 'quant', 'BacktestStrategy') !== undefined)
  check('同一段下两个 packType 变体归到同一个节点（路径层不管 query）', urlSegments('api.example.com', 'quant', 'BacktestStrategy')?.count === 2, String(urlSegments('api.example.com', 'quant', 'BacktestStrategy')?.count))
  const strategyNode = urlSegments('api.example.com', 'quant', 'BacktestStrategy')
  check('该节点 errors = 1（只有 500 那条）', strategyNode?.errors === 1, String(strategyNode?.errors))
  // 末端才是装记录的节点（路径段级节点只带计数）
  const leaf = urlSegments('api.example.com', 'quant', 'BacktestStrategy', 'GetStrategyLogic')
  check('叶子是**原始记录对象**（点它才能拿到 id 去开详情）', leaf?.records?.[0]?.id === 'a1' && leaf?.records?.[1]?.id === 'a2', JSON.stringify(leaf?.records?.map((r) => r?.id)))
  check('叶子顺序 = 入参顺序（不重排，列表本来就是新→旧）', leaf?.records?.map((r) => r.id).join(',') === 'a1,a2', leaf?.records?.map((r) => r.id).join(','))
  check('不同末端各归各的叶子（GetStock 不在 GetStrategyLogic 下）', urlSegments('api.example.com', 'quant', 'BacktestStrategyMall', 'GetStock')?.records?.map((r) => r.id).join(',') === 'a3', JSON.stringify(urlSegments('api.example.com', 'quant', 'BacktestStrategyMall', 'GetStock')?.records?.map((r) => r.id)))

  // 解析不出域名/路径的 URL：必须**挂在树上**，不许被静默丢掉
  const noHost = byDomain.get('(无法归簇)')
  check('解析不出域名的 URL 记为 unparsableUrls', tree.unparsableUrls === 2, String(tree.unparsableUrls))
  check('且它们仍在树里，第一层按整串 URL 分开（相对路径 + about:blank 各一个节点）', noHost?.children?.length === 2 && noHost.children.every((c) => c.records.length === 1), JSON.stringify(noHost?.children?.map((c) => c.label)))
  check('不编造域名：about:blank 不会被塞进某个真域名', tree.domains.every((d) => d.domain !== 'blank'), tree.domains.map((d) => d.domain).join(','))

  // 默认展开：最近命中的域（ts 最大），不是字母序第一个
  const openDomains = tree.domains.filter((d) => d.defaultOpen === true).map((d) => d.domain)
  check('defaultOpen 只给「最近命中的域」（本样本是 (无法归簇)，ts=310）', openDomains.length === 1 && openDomains[0] === '(无法归簇)', openDomains.join(','))
  check('默认展开是**整棵子树**（域 + 其下每一段都标 defaultOpen）', noHost?.children?.every((c) => c.defaultOpen === true) === true)

  const latest = buildUrlTree([
    rec('x', 10, 'GET', 'https://old.example.com/a', 200),
    rec('y', 20, 'GET', 'https://new.example.com/b', 200),
  ])
  check('最近命中的域跟着数据走（这里换成 new.example.com）', latest.domains.filter((d) => d.defaultOpen === true).map((d) => d.domain).join(',') === 'new.example.com')

  check('空列表不炸、返回空树', buildUrlTree([]).domains.length === 0 && buildUrlTree([]).total === 0)
  check('非数组入参不炸（面板拿到 null 时不该把视图打崩）', buildUrlTree(null).total === 0 && buildUrlTree(undefined).domains.length === 0)
  check('时间范围取自记录（newest/oldest）', tree.newestTs === 310 && tree.oldestTs === 100, `${tree.oldestTs}→${tree.newestTs}`)
  check('重复 URL 各算一条（不去重 —— 重复检测是另一个视图的事）', buildUrlTree([rec('d1', 1, 'GET', 'https://a.example.com/x', 200), rec('d2', 2, 'GET', 'https://a.example.com/x', 200)]).domains[0].count === 2)
}

// ------------------------------------------------------------------ 真渲染（DOM 桩 + 假 fetch）
// 纯函数对 ≠ 画出来对：这一段真的把面板挂起来、点「域名树」，再检查画出来的行。
{
  const rec = (id, ts, method, url, status, durationMs = 1) => ({ id, ts, method, url, status, durationMs })
  const live = [
    rec('r1', 1_800_000_000_010, 'GET', 'https://api.example.com/quant/BacktestStrategy/List?packType=1', 200, 12),
    rec('r2', 1_800_000_000_020, 'POST', 'https://api.example.com/quant/BacktestStrategy/List?packType=2', 500, 30),
    rec('r3', 1_800_000_000_030, 'POST', 'https://api.example.com/quant/Mall/GetStock?id=9', 404, 7),
    rec('r4', 1_800_000_000_040, 'GET', 'https://push.example.com/api/v1/list', 200, 5),
    rec('r5', 1_800_000_000_050, 'GET', '/relative/path', 200, 3),
  ]
  const page = mountPanel(live)
  const ctx = { effect() {} }
  let mountedOk = true
  try {
    page.mod.apply(ctx)
  } catch (error) {
    mountedOk = false
    console.log('  FAIL 面板挂载抛错 — ' + error.message)
    failures++
  }
  check('面板能在 DOM 桩里挂载（apply 不抛错）', mountedOk)

  const view = collect(page.document.body, (n) => n.dataset?.dshApivizView !== undefined)
  check('挂载后能找到面板根节点（挂在 centerColumn/document.body 下）', view.length === 1, String(view.length))
  const root = view[0] ?? makeNode('div')

  const treeButtons = byText(root, '域名树')
  check('工具栏出现「域名树」按钮', treeButtons.length === 1, String(treeButtons.length))
  const treeEntries = collect(root, (n) => n.dataset?.depth !== undefined)
  check('还没点之前，树是空的（按钮只切换视图，不预渲染）', treeEntries.length === 0, String(treeEntries.length))

  // 点「域名树」→ setView 立刻 refresh：树当场渲染好（面板开不开都一样，视图像素由 CSS 控制）
  treeButtons[0]?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // 顺手把面板真的打开一次（走 postman 的「← 接口捕获」→ setOpen(true) 这条外部入口）。
  // 说明：注入口令在 `document` 为 undefined 时早退，而客户端插件在**外层 realm** 的
  // 回调里读不到我们塞进 vm 的桩 —— 所以这条按钮在单测里可能注不进去。它是"顺手验证"，
  // 不是本视图的判据，因此**只报告、不断言失败**（真机验证留给面板自己）。
  const openBtn = page.document.querySelector('[data-apv-back-entry]')
  console.log(`  info postman「← 接口捕获」注入: ${openBtn === null ? '单测桩里读不到（不判失败）' : '已注入'}`)
  openBtn?.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // 注意：这里**不能**再点一次「域名树」按钮 —— 它是开关（开着再点就切回表格了，
  // 视图切回表格后树被隐藏，断言会误读成"树没渲染"。我第一版就踩了这个坑。）

  check('打开面板后确实拉了 /records?limit=300（树复用列表数据源）',
    page.fetchLog.some((u) => u.includes('/records?') && u.includes('limit=300')), page.fetchLog.filter((u) => u.includes('/records')).join(' | '))

  const leaves = byClass(root, 'apv-tree-leaf')
  const allBranches = byClass(root, 'apv-tree-branch')
  // 默认只展开「最近命中的域」= (无法归簇)（ts 最大）→ 叶子只有 r5 那一条
  check('默认只展开最近命中的域：叶子只有 r5（其余域折叠，不是没渲染）', leaves.length === 1 && leaves[0]?.dataset?.recordId === 'r5', leaves.map((l) => l.dataset?.recordId).join(','))
  check('域名层全都在（2 个真域名 + 无法归簇桶）', allBranches.filter((b) => b.dataset?.kind === 'domain').length === 3, allBranches.map((b) => b.dataset?.label).join(','))
  check('一棵树只渲染一份（重入 renderTree 不会叠出第二棵树）', byText(root, '域名树 · 3 个域名 / 5 条请求').length === 1, String(byText(root, '域名树 · 3 个域名 / 5 条请求').length))
  const collapsed = allBranches.find((b) => b.dataset?.label === 'api.example.com')
  check('折叠的域名行显示「▸ + 域名 + (条数)」，且带子树计数 3',
    collapsed !== undefined && byText(collapsed, '▸').length === 1 && byText(collapsed, 'api.example.com').length === 1 && byText(collapsed, '(3)').length === 1,
    collapsed === undefined ? '(没找到 api.example.com 行)' : `caret=${byText(collapsed, '▸').length} count=${byText(collapsed, '(3)').length}`)
  check('错误计数显示在域名行上（api.example.com 有 500/404 两条 → ✕2）', collapsed !== undefined && byText(collapsed, '✕2').length === 1)
  check('折叠的域**不渲染**它的子树（省 DOM：3 条记录一条都不在树里）', leaves.every((l) => l.dataset?.recordId !== 'r1'))
  const openBranch = allBranches.find((b) => b.dataset?.label === '(无法归簇)')
  check('默认展开的域用 ▾ 且标注「未识别出域名/路径」', openBranch !== undefined && byText(openBranch, '▾').length === 1 && byText(openBranch, '未识别出域名/路径').length === 1)

  // 逐层展开（每层展开子级，不再往下钻第二层）
  collapsed?.click()
  const afterDomain = byClass(root, 'apv-tree-branch')
  check('点域名行即展开，且只放出**下一层**（quant），不一次全摊开',
    byText(root, 'quant').length === 1 && byText(root, 'Mall').length === 0 && byText(root, 'BacktestStrategy').length === 0,
    afterDomain.map((b) => b.dataset?.label).join(' | '))
  const quantBranch = afterDomain.find((b) => b.dataset?.label === 'quant')
  check('展开后子树计数挂在路径段上（quant=(3)，含 500/404 两条 → ✕2）',
    quantBranch !== undefined && byText(quantBranch, '(3)').length === 1 && byText(quantBranch, '✕2').length === 1,
    quantBranch === undefined ? '(没找到 quant 行)' : `count=${byText(quantBranch, '(3)').length} err=${byText(quantBranch, '✕2').length}`)
  quantBranch?.click()
  const afterQuant = byClass(root, 'apv-tree-branch')
  check('再展开一层：BacktestStrategy 与 Mall 两个分支同时出现（同级兄弟一个都不能漏）',
    byText(root, 'BacktestStrategy').length === 1 && byText(root, 'Mall').length === 1,
    afterQuant.map((b) => b.dataset?.label).join(' | '))
  // 一路点到底（每点一次都要重新查：重渲染会换掉整棵 DOM）。
  // 注意按 **nodeKey** 定位而不是 label —— 同一层里可能有两个同名路径段
  // （…/quant/BacktestStrategy 与 …/quant/Mall/BacktestStrategy），
  // 用 label 找会点错那一支（我第一版就是这么错的）。
  // 逐支点到底（每点一次都要重新查：重渲染会换掉整棵 DOM）。
  // 注意按 **nodeKey** 定位而不是 label —— 同一层里可能有两个同名路径段
  // （…/quant/BacktestStrategy 与 …/quant/Mall/BacktestStrategy），
  // 用 label 找会点错那一支（我第一版就是这么错的）。
  const clickKey = (key) => { const b = byClass(root, 'apv-tree-branch').find((x) => x.dataset?.nodeKey === key); b?.click(); return b !== undefined }
  const api = 'api.example.com'
  check('按 nodeKey 能精确命中要展开的那一支（同名路径段不会点错）', clickKey(`${api}|quant|BacktestStrategy`))
  clickKey(`${api}|quant|BacktestStrategy|List`)
  clickKey(`${api}|quant|Mall`)
  clickKey(`${api}|quant|Mall|GetStock`)
  check('一路点到底后 r1/r2（同一路径、不同 query 两条）与 r3 都成了记录行',
    ['r1', 'r2', 'r3'].every((id) => byClass(root, 'apv-tree-leaf').some((l) => l.dataset?.recordId === id)),
    byClass(root, 'apv-tree-leaf').map((l) => l.dataset?.recordId).join(','))
  // 每次重渲染都会换掉整棵 DOM，所以句柄必须重新查（拿旧的会得到已脱离的节点）
  const leafR1 = byClass(root, 'apv-tree-leaf').find((l) => l.dataset?.recordId === 'r1')
  const branchApi = byClass(root, 'apv-tree-branch').find((b) => b.dataset?.label === 'api.example.com')
  check('叶子缩进比它所属的域名行更深（层级看得见，不是平铺）',
    leafR1 !== undefined && branchApi !== undefined && indentOf(leafR1) > indentOf(branchApi), `leaf=${indentOf(leafR1)} branch=${indentOf(branchApi)}`)
  check('叶子显示完整 URL + 状态 + 耗时（点开详情要用的信息都在）',
    leafR1 !== undefined && leafR1.title?.includes('GET https://api.example.com/quant/BacktestStrategy/List?packType=1') === true && /状态 200/.test(leafR1.title ?? '') && /12ms/.test(leafR1.title ?? ''), leafR1?.title)
  const failLeaf = byClass(root, 'apv-tree-leaf').find((l) => l.dataset?.recordId === 'r2')
  check('500 那条也真的渲染出来了（只统计错误、不渲染错误 = 白算）', failLeaf !== undefined && /状态 500/.test(failLeaf.title ?? ''), failLeaf?.title)
  check('不同 query 的两条各自成叶子（路径段相同也不合并成一行）', byClass(root, 'apv-tree-leaf').filter((l) => ['r1', 'r2'].includes(l.dataset?.recordId)).length === 2)

  // 全部收起 / 全部展开
  byText(root, '全部收起')[0]?.click()
  check('「全部收起」后一条叶子都不渲染', byClass(root, 'apv-tree-leaf').length === 0, String(byClass(root, 'apv-tree-leaf').length))
  byText(root, '全部展开')[0]?.click()
  check('「全部展开」后 5 条记录的叶子全在（一条不丢）', byClass(root, 'apv-tree-leaf').length === 5, String(byClass(root, 'apv-tree-leaf').length))

  // 覆盖范围必须写在表头与底部（"截断不许冒充没有"）
  const headerTexts = collect(root, (n) => n.tagName !== '#TEXT').map((n) => n.textContent ?? '')
  check('表头写明域名数/请求数/覆盖时间范围', headerTexts.some((t) => /域名树 · 3 个域名 \/ 5 条请求/.test(t)) && headerTexts.some((t) => /覆盖 \d\d:\d\d:\d\d\.\d\d\d – \d\d:\d\d:\d\d\.\d\d\d/.test(t)), headerTexts.find((t) => t.includes('域名树')) ?? '(没找到表头)')
  check('表头显式提示「1 条 URL 解析不出域名/路径」', headerTexts.some((t) => /⚠ 1 条 URL 解析不出域名\/路径/.test(t)))
  check('底部写明只覆盖这次列表请求（不是整库）', headerTexts.some((t) => /不是整库/.test(t) && /当前 300 条/.test(t)))
}

// ------------------------------------------------------------------ 接线（源码哨兵）
const codeOnly = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const code = codeOnly(source)

check('dw1 视图注册：VIEW_MODES/viewWraps/viewButtons 都含 tree（漏一个就是按钮点了没反应）',
  /VIEW_MODES = \['tree'/.test(code) && /viewWraps = \{ tree: treeWrap/.test(code) && /viewButtons = \{ tree: treeBtn/.test(code))
check('dw2 按钮接线：域名树按钮走 setView 切换', /treeBtn\.addEventListener\('click', \(\) => setView\(state\.treeView \? 'table' : 'tree'\)\)/.test(code))
check('dw3 数据源：tree 视图复用 /records（与列表同一份数据，不另开一条聚合接口）', /active === 'tree'\)[\s\S]{0,320}?apiFetch\(`\/records\?\$\{tp\.toString\(\)\}`\)/.test(code))
check('dw4 渲染派发：refresh 里 tree 分支调 renderTree', /active === 'tree'\) \{\n\s+pendingTreeRecords = viewData\?\.items \?\? \[\]\n\s+renderTree\(\)/.test(code))
check('dw5 树叶子点开的是既有详情接口（不复制详情实现）', /buildTreeLeaf[\s\S]{0,1400}?apiFetch\(`\/records\/\$\{encodeURIComponent\(record\.id\)\}`\)/.test(code))

// 覆盖范围必须写在脸上：树只覆盖列表那次请求（LIMIT 条），这正是"截断不许冒充没有"那条规矩
const limit = Number((code.match(/const LIMIT = (\d+)/) ?? [])[1])
check('dw6 表头写明「域名/请求数 + 覆盖时间范围」', /域名树 · \$\{hosts\} 个域名 \/ \$\{leaves\.length\} 条请求/.test(code) && /覆盖 \$\{range\}/.test(code))
check('dw7 底部明说只覆盖这次列表请求（不是整库）', new RegExp(`只覆盖上面这次列表请求拉回的记录（当前 ${limit} 条`).test(code))
check('dw8 覆盖说明里的条数与 LIMIT 常量一致（改了 LIMIT 不同步改文案会被这里抓住）', Number.isInteger(limit) && new RegExp(`当前 ${limit} 条`).test(code), `LIMIT=${limit}`)
check('dw9 解析不出域名/路径的记录必须显式警告（不许静默消失）', /unparsableUrls > 0[\s\S]{0,200}?已按整串挂在「\(无法归簇\)」下（不是丢掉）/.test(code))
check('dw10 展开态覆盖默认值：用户点过的节点记进 overrides，重建后仍生效', /treeState\.overrides\.set\(node\.key, !treeState\.open\.has\(node\.key\)\)/.test(code) && /for \(const \[key, want\] of treeState\.overrides\)/.test(code))
check('dw11 全部展开/收起两个入口都在', /'全部展开'/.test(code) && /'全部收起'/.test(code))

if (failures > 0) {
  console.log(`\n域名树：${failures} 项未通过`)
  process.exit(1)
}
console.log('\n域名树：全部通过')
process.exit(0)
