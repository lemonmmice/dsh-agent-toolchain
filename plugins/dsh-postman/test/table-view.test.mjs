// dsh-postman 单测：响应区「表格视图」tab（口径同 dsh-api-visualizer 的「排序视图」）
//
// 为什么在 vm 里跑真文件而不是只扫源码：这一栏的价值全在「行集认不认得出来、列挑得对不对、
// 值按什么口径印」——源码里写着 pickListRows/pickListColumns ≠ 榜单一来就真挑对了。
// client.js 是 __ModuleLoader__ 包裹的浏览器 bundle，直接 import 会碰 document/localStorage，
// 所以给一份最小 DOM 桩 + 假 fetch：**真挂面板、真点「发送」、真点 tab**，再检查画出来的表。
//
// 四段：
//   1. 真渲染：假 fetch 回一份榜单响应（数据形状抄自接口捕获里那条 RankingStrategyPositions）
//      → 点发送 → 检查 tab / 表头 / 列 / 单元格 / 「未重排」的顺序；
//   2. tab 行为：常驻 tab、角标行数、切 tab 只显示一栏、连发两次保持选中、没表时退回「响应体」；
//   3. 不猜：非行集 / 非 JSON / 已截断 / 空行集 / 无可用列 / 请求失败 → **不铺表**，
//      并在那一栏里写明原因（宁可不显示，也不许编一张表出来）；
//   4. 接线哨兵（只扫源码，如实说明它不是行为证明）：渲染派发、tab 接线、CSS 的 [hidden] 规则、
//      以及热重载时 CSS 必须跟着换（这条真踩过：见 injectStyle 的注释）。
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
// classList/addEventListener + 能被查的子树（带 children 数组，否则"格子挂没挂上"查不出来）。
function makeNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(), className: '', title: '', hidden: false, value: '', innerHTML: '',
    dataset: {}, style: { cssText: '' }, _attrs: {},
    childNodes: [], children: [], parentNode: null, _listeners: {}, isConnected: true,
    // 真 DOM 里 `textContent` 读的是**全部子节点**（文本 + 后代元素的文本），
    // 而 `el('button', 'pm-tab', '查询参数')` 之后再 appendChild 一个角标，文字仍在。
    // 桩里若把初始文字当普通属性存、又让 appendChild 覆盖读取口径，标题就会"消失"
    // （第一版就是这么误判的：tab 文本读出来是 ' (0)'）。
    get textContent() {
      return node.childNodes.map((c) => c.textContent).join('')
    },
    set textContent(v) {
      const text = textNode(v)
      text.parentNode = node
      node.childNodes = [text]
      node.children = []
    },
    appendChild(c) { c.parentNode = node; node.childNodes.push(c); if (c.tagName !== '#TEXT') node.children.push(c); return c },
    insertBefore(c) { c.parentNode = node; node.childNodes.unshift(c); if (c.tagName !== '#TEXT') node.children.unshift(c); return c },
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
    focus() {}, blur() {}, click() { node.dispatch('click') }, scrollIntoView() {},
    closest() { return null }, contains(other) { return collectAll(node, (n) => n === other).length > 0 },
    matches(sel) { return matchesSelector(node, sel) },
    get firstElementChild() { return node.children[0] ?? null },
    get nextElementSibling() { return null },
  }
  return node
}
const textNode = (t) => ({ tagName: '#TEXT', textContent: String(t), childNodes: [], children: [], dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} })

// 最小选择器匹配：[attr] / [attr="v"] / .cls / tag —— 面板与断言只用这些。
// （不支持的选择器宁可返回 null，也不假装匹配上。）
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
const byClass = (root, cls) => collectAll(root, (n) => typeof n.className === 'string' && n.className.split(/\s+/).includes(cls))
const byTag = (root, tag) => collectAll(root, (n) => n.tagName === String(tag).toUpperCase())
// 桩的 textContent 只拼**直接文本子节点**（真 DOM 会连后代元素一起拼）—— 容器节点的文字
// 必须自己递归取，否则「表头写了什么」永远读到空串（这是桩的偏差，不是产品缺陷）。
const deepText = (n) => (n.tagName === '#TEXT' ? n.textContent : (n.childNodes.length === 0 ? n.textContent : n.childNodes.map(deepText).join('')))

/** 在 DOM 桩里求值 client.js 并挂载面板（假 fetch：只回这次 /send 的响应）。 */
function mountPanel(responseFactory) {
  const byId = new Map()
  const documentStub = {
    createElement: (tag) => makeNode(tag),
    createTextNode: textNode,
    createDocumentFragment: () => makeNode('fragment'),
    getElementById: (id) => byId.get(id) ?? null,
    // sidebarRoot()/centerColumn() 都走它：返回 null → 侧边栏入口不挂（本测不管它），
    // 面板回退挂到 document.body 上。
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: makeNode('body'), head: makeNode('head'), documentElement: makeNode('html'),
  }
  // 有些回调跑在**外层 realm**（本测试进程），读的是 Node 的全局 document；两处都挂上，
  // 让"哪个 realm 调的"不再影响结果。
  globalThis.document = documentStub
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
    location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: async (url) => {
      fetchLog.push(String(url))
      const body = responseFactory()
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
  mod.apply({ effect() {} })
  const view = collectAll(documentStub.body, (n) => n.dataset?.dshPostmanView !== undefined)[0]
  if (view === undefined) throw new Error('面板没挂上（找不到 [data-dsh-postman-view]）')
  documentStub.documentElement.dataset.dshPostmanActive = 'true'
  return {
    mod, document: documentStub, fetchLog, view,
    pane: byClass(view, 'pm-tblpane')[0],
    body: byClass(view, 'pm-body')[0],
    urlInput: byClass(view, 'pm-url')[0],
    sendBtn: byClass(view, 'pm-send').find((b) => b.textContent === '发送'),
    // 响应区的 tabs 是第二个 .pm-tabs（第一个是请求区的 查询参数/请求头/…）
    respTabs: byClass(view, 'pm-tabs')[1],
    // 把断言范围锁在响应区：gRPC 区里也有一个 .pm-pre，全视图扫会数错
    resp: byClass(view, 'pm-resp')[0],
    tab: (label) => byClass(byClass(view, 'pm-tabs')[1], 'pm-tab').find((b) => deepText(b).trim().startsWith(label)),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const tabLabel = (btn) => deepText(btn).trim()
const label = (page, name) => tabLabel(page.tab(name))
const activeTab = (page) => byClass(page.respTabs, 'pm-tab').filter((b) => b.dataset.active !== undefined).map(tabLabel)[0] ?? '(无)'
const visiblePres = (page) => byClass(page.resp, 'pm-pre').filter((p) => p.hidden === false).length
const tableRows = (page) => { const tb = byTag(page.pane, 'tbody')[0]; return tb === undefined ? [] : tb.children }
const hint = (page) => byClass(page.pane, 'pm-empty').map(deepText)[0] ?? ''

// ------------------------------------------------------------------ 榜单响应样本
// 样本里的域名一律用 example.com（仓库的隐私闸门会拦真实域名 —— 数据形状照抄，域名不抄）
const RANKING_URL = 'https://api.example.com/platform/api/Strategies/RankingStrategyPositions?UserToken=x&strategyId=228&sortField=7&sortType=2'
const ROWS = [
  { innerCode: 2638, stockCode: '601939', stockName: '建设银行', market: '1', nowv: 11.45, nowvTxt: '11.45', upDownRate: '+0.44%', cost: 11.05, costTxt: '11.05', totalProfit: 0.03619998050262444, totalProfitTxt: '+3.62%', profit: 0.0073, profitTxt: '+0.73%', positionTxt: '20.94%' },
  { innerCode: 2639, stockCode: '600919', stockName: '江苏金租', market: '1', nowv: 8.42, nowvTxt: '8.42', upDownRate: '-0.82%', cost: 8.49, costTxt: '8.49', totalProfit: 0.0569, totalProfitTxt: '+5.69%', profit: 0.0107, profitTxt: '+1.07%', positionTxt: '19.85%' },
  { innerCode: 2640, stockCode: '600177', stockName: '雅戈尔', market: '1', nowv: 7.61, nowvTxt: '7.61', upDownRate: '-1.17%', cost: 7.7, costTxt: '7.70', totalProfit: 0.0095, totalProfitTxt: '+0.95%', profit: 0.0019, profitTxt: '+0.19%', positionTxt: '20.28%' },
  { innerCode: 2641, stockCode: '002966', stockName: '苏州银行', market: '1', nowv: 8.44, nowvTxt: '8.44', upDownRate: '-1.29%', cost: 8.55, costTxt: '8.55', totalProfit: -0.0276, totalProfitTxt: '-2.76%', profit: -0.0055, profitTxt: '-0.55%', positionTxt: '19.50%' },
  { innerCode: 2642, stockCode: '301015', stockName: '百洋医药', market: '1', nowv: 26.34, nowvTxt: '26.34', upDownRate: '-8.67%', cost: 28.84, costTxt: '28.84', totalProfit: -0.0736, totalProfitTxt: '-7.36%', profit: -0.0148, profitTxt: '-1.48%', positionTxt: '18.60%' },
]
const okResp = (body, extra = {}) => ({ response: { ok: true, status: 200, statusText: 'OK', durationMs: 290, size: 4096, contentType: 'application/json; charset=utf-8', truncated: false, body, ...extra } })
const rankingBody = () => okResp(JSON.stringify({ status: 1, msg: null, total: ROWS.length, rows: ROWS }))

/** 挂面板 → 填 URL → 点「发送」→ 等渲染。 */
async function send(page, url = RANKING_URL) {
  page.urlInput.value = url
  page.sendBtn.dispatch('click')
  await tick()
  await tick()
}

// ------------------------------------------------------------------ 1. 真渲染
{
  let mounted = true
  let page
  try {
    page = mountPanel(rankingBody)
  } catch (error) {
    mounted = false
    console.log('  FAIL 面板在 DOM 桩里没挂起来 — ' + error.message)
    failures++
  }
  check('面板能在 DOM 桩里挂载', mounted)
  if (mounted) {
    check('tab 顺序 = 响应体 | 响应头 | 表格视图（新 tab 在响应头右边）',
      byClass(page.respTabs, 'pm-tab').map(tabLabel).map((t) => t.replace(/\s+\d+$/, '')).join('|') === '响应体|响应头|表格视图',
      byClass(page.respTabs, 'pm-tab').map(tabLabel).join('|'))
    check('还没发送时 tab 上没有角标，那一栏写「尚未发送请求」', label(page, '表格视图') === '表格视图' && hint(page) === '尚未发送请求', `${label(page, '表格视图')} / ${hint(page)}`)
    check('默认停在「响应体」', activeTab(page) === '响应体', activeTab(page))

    await send(page)
    check('发送后停在「响应体」（不抢用户正在看的栏）', activeTab(page) === '响应体', activeTab(page))
    check('tab 角标给出行数（表格视图 5）', label(page, '表格视图') === '表格视图 5', label(page, '表格视图'))

    page.tab('表格视图').dispatch('click')
    check('点「表格视图」→ 只有它这一栏显示（响应体/响应头都收起）',
      page.pane.hidden === false && visiblePres(page) === 0 && activeTab(page) === '表格视图 5', activeTab(page))
    check('切到「响应头」时表格栏收起（三栏互斥）', (() => {
      page.tab('响应头').dispatch('click')
      const ok = page.pane.hidden === true && visiblePres(page) === 1
      page.tab('表格视图').dispatch('click')
      return ok
    })())

    const heads = byClass(page.pane, 'pm-tbl-head').map(deepText)
    check('表头写明条数：表格视图 · 共 5 行', heads.some((t) => t.includes('表格视图 · 共 5 行')), heads.join(' | '))
    check('表头写明排序依据（从 URL 的 sortField/sortType 读，不猜）',
      heads.some((t) => t.includes('顺序 = 接口返回顺序（未重排）') && t.includes('sortField=7') && t.includes('sortType=倒序')), heads.join(' | '))

    const ths = collectAll(page.pane.querySelector('tr'), (n) => n.tagName === 'TH').map((n) => n.textContent)
    check('列模型 = 名称列 + 4 个值列（比率数字在前、百分比文本按字段顺序）',
      ths.join('|') === '顺序|股票名称|upDownRate|totalProfitTxt|profitTxt|positionTxt', ths.join('|'))
    check('名称列用中文表头（stockName → 股票名称，不是原字段名）', ths[1] === '股票名称')

    const rows = tableRows(page)
    check('5 行全渲染出来', rows.length === 5, String(rows.length))
    check('顺序列 = 1..5（顺序就是接口返回顺序，不重排）', rows.map((tr) => tr.children[0].textContent).join(',') === '1,2,3,4,5')
    check('第一行 = 建设银行 +0.44% +3.62% +0.73% 20.94%（值原样印，不做二次换算）',
      rows[0].children.map((td) => td.textContent).join('|') === '1|建设银行|+0.44%|+3.62%|+0.73%|20.94%',
      rows[0].children.map((td) => td.textContent).join('|'))
    check('最后一行也真的渲染了（只算不画 = 白算）',
      rows[4].children.map((td) => td.textContent).join('|') === '5|百洋医药|-8.67%|-7.36%|-1.48%|18.60%',
      rows[4].children.map((td) => td.textContent).join('|'))
  }
}

// ------------------------------------------------------------------ 2. tab 行为（连发 / 保持选中 / 没表退回）
{
  const page = mountPanel(rankingBody)
  await send(page)
  page.tab('表格视图').dispatch('click')
  await send(page)
  check('连发两次仍停在「表格视图」（不把人踢回响应体）', activeTab(page) === '表格视图 5' && page.pane.hidden === false, activeTab(page))
  check('连发两次只留一张表（那一栏先清空再画，不叠影）',
    byClass(page.pane, 'pm-tbl-table').length === 1 && tableRows(page).length === 5,
    `tables=${byClass(page.pane, 'pm-tbl-table').length}`)

  // 第二次响应没有表 → 自动退回「响应体」，但原因仍写在「表格视图」那一栏里
  let body = '{"a":1}'
  const page2 = mountPanel(() => okResp(body))
  await send(page2)
  page2.tab('表格视图').dispatch('click')
  check('有表时可以停在「表格视图」', page2.pane.hidden === false)
  body = '{"a":1}'
  await send(page2)
  check('这次没表 → 自动退回「响应体」（不对着一栏空表）', activeTab(page2) === '响应体' && page2.pane.hidden === true, activeTab(page2))
  check('退回后那栏的原因还在（切回去能看见为什么没表）', hint(page2).includes('没有「元素为对象的数组」'), hint(page2))
  check('没表时清掉角标（不留上一次的行数）', label(page2, '表格视图') === '表格视图', label(page2, '表格视图'))
}

// 数字比率（0.2085）要按百分比印 —— 榜单里同一个量有「比率数字」与「文本」两种下发形态
{
  const page = mountPanel(() => okResp(JSON.stringify({ rows: [{ stockName: 'A', positionRate: 0.2085, upDownRate: '+1.00%' }] })))
  await send(page, 'https://x.example.com/list')
  page.tab('表格视图').dispatch('click')
  const row = tableRows(page)[0]
  check('小数比率按百分比渲染（positionRate 0.2085 → +20.85%）',
    row.children.map((td) => td.textContent).join('|') === '1|A|+20.85%|+1.00%',
    row.children.map((td) => td.textContent).join('|'))
  check('URL 没有 sortField 时表头只写「顺序 = 接口返回顺序（未重排）」',
    byClass(page.pane, 'pm-tbl-head').map(deepText).join('|').includes('顺序 = 接口返回顺序（未重排）')
    && !byClass(page.pane, 'pm-tbl-head').map(deepText).join('|').includes('sortField='))
}

// 后端置顶的行要标出来（否则看着像排序坏了）
{
  const page = mountPanel(() => okResp(JSON.stringify({ rows: [{ stockName: '置顶股', handpick: '精选', isSubscribed: true, upDownRate: '+2.00%' }] })))
  await send(page, 'https://x.example.com/list')
  page.tab('表格视图').dispatch('click')
  const tags = byClass(page.pane, 'pm-tbl-tag').map((n) => n.textContent)
  check('置顶/已订阅的行带标记（精选 + 已订阅）', tags.join('|') === '精选|已订阅', tags.join('|'))
}

// 行数上限：铺前 300 行，并把"只铺了多少"写在脸上
{
  const many = Array.from({ length: 420 }, (_, i) => ({ stockName: 'S' + i, upDownRate: '+' + i + '.00%' }))
  const page = mountPanel(() => okResp(JSON.stringify({ rows: many })))
  await send(page, 'https://x.example.com/list')
  page.tab('表格视图').dispatch('click')
  check('420 行只渲染前 300 行（不把面板铺死）', tableRows(page).length === 300, String(tableRows(page).length))
  check('并在表头如实写明「只渲染前 300 行（共 420 行）」',
    byClass(page.pane, 'pm-tbl-head').map(deepText).join('|').includes('只渲染前 300 行（共 420 行）'),
    byClass(page.pane, 'pm-tbl-head').map(deepText).join('|'))
  check('角标仍写真实总行数（420，不是被截过的 300）', deepText(page.tab('表格视图')) === '表格视图 420', deepText(page.tab('表格视图')))
}

// ------------------------------------------------------------------ 3. 不猜：不是行集就不铺表，并写明原因
{
  const cases = [
    ['普通对象（没有对象数组）', okResp('{"a":1,"b":{"c":2}}'), '没有「元素为对象的数组」'],
    ['非 JSON 文本', okResp('hello world', { contentType: 'text/plain' }), '不是 JSON'],
    ['响应体已截断（无法整体解析，宁可说清楚也不铺半张表）', okResp('{"rows":[{"stockName":"A","upDownRate":"+1.00%"}]}', { truncated: true }), '已截断'],
    ['空数组行集', okResp('{"rows":[]}'), '没有「元素为对象的数组」'],
    ['行里没有可用列（只有 id）', okResp('{"rows":[{"id":1}]}'), '没有可展示的列'],
    ['请求失败', { response: { ok: false, error: 'ECONNREFUSED' } }, '请求失败'],
  ]
  for (const [label, responseBody, expectHint] of cases) {
    const page = mountPanel(() => responseBody)
    await send(page)
    page.tab('表格视图').dispatch('click')
    check(`不铺表并写明原因：${label}`,
      byClass(page.pane, 'pm-tbl-table').length === 0 && hint(page).includes(expectHint),
      `tables=${byClass(page.pane, 'pm-tbl-table').length} hint=${hint(page)}`)
  }
}

// ------------------------------------------------------------------ 4. 接线（源码哨兵）
// 说明：这一段只扫源码文本 —— 它是"有没有接上"的哨兵，不是行为证明（行为证据在上面三段）。
const codeOnly = (src) => src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const code = codeOnly(source)

check('w1 渲染派发：renderResponse 成功分支调 renderTablePane（没接上 = 那一栏永远空着）',
  /hasTable = renderTablePane\(\)/.test(code))
check('w2 失败分支也刷那一栏（上一次的表不许留在屏幕上）', /respBodyPre\.textContent = state\.respRaw\n\s+renderTablePane\(\)/.test(code))
check('w3 tab 接线：三个 tab 各自 selectRespTab，且 mode 是字符串而不是旧布尔',
  /tabRespBody\.addEventListener\('click', \(\) => selectRespTab\('body'\)\)/.test(code)
  && /tabRespHeaders\.addEventListener\('click', \(\) => selectRespTab\('headers'\)\)/.test(code)
  && /tabRespTable\.addEventListener\('click', \(\) => selectRespTab\('table'\)\)/.test(code))
check('w4 三栏互斥由 selectRespTab 一处控制（不许各切各的）',
  /respBodyPre\.hidden = mode !== 'body'\n\s+respHeadersPre\.hidden = mode !== 'headers'\n\s+tablePane\.hidden = mode !== 'table'/.test(code))
check('w5 CSS 必须让 [hidden] 真的不显示（.pm-tblpane 是 flex，不写这条藏不住）', /\.pm-tblpane\[hidden\]\{display:none\}/.test(code))
check('w6 热重载时 CSS 要跟着换（见到旧 <style> 就 return 会让新类名没样式 —— 实测踩过）',
  /const existing = document\.getElementById\('dsh-postman-style'\)\n\s+if \(existing !== null\) \{\n\s+existing\.textContent = CSS/.test(code))
check('w7 排序依据只从 URL 读（不做语义推断）', /function sortParamsOf\(url\)[\s\S]{0,400}?params\.get\('sortField'\)/.test(code))
check('w8 行集预算：全树遍历有节点上限与深度上限（MB 级响应不许全树扫）', /let budget = 300/.test(code) && /if \(depth >= 4\) return/.test(code))
check('w9 表格视图 tab 必须常驻（不许按响应有无而增删 tab —— 按钮会跳）',
  /respTabs\.appendChild\(tabRespTable\)/.test(code) && !/tabRespTable\.remove\(\)/.test(code))

if (failures > 0) {
  console.log(`\n表格视图：${failures} 项未通过`)
  process.exit(1)
}
console.log('\n表格视图：全部通过')
process.exit(0)
