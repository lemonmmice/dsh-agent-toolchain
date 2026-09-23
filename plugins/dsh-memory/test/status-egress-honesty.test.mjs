// F-054 回归：**隐私口径必须走"execute → render"整条链**，不能只拿合成值调 render。
//
// 真事故（2026-09-14 在真机上撞见）：`memory_status` 的渲染层靠 `value.embedEndpoint` 判 remote/local，
// 而 `execute` **只返回 {chunks, kvEntries, embed}** —— 字段从来没被带出来过。
// 于是它永远走 else 分支，对用户说「embedding **在本机完成：内容未离开本机**」，
// 而当时 embedding 实际走远程 API（我刚把 2578 个分块发到 api.minimax.chat）。**一条关于隐私的假承诺。**
//
// 为什么原来的测试抓不到：`bv07-privacy-honesty.test.mjs` 是**直接拿合成的 REMOTE/LOCAL 对象调 render** ——
// 它证明了"渲染层会正确处理 remote"，但**结构上不可能发现 execute 根本没给这个字段**。
// ⇒ 本文件的做法：**真装插件 → 真调 execute → 把它的真实返回喂给 render**，断言链路上不出现假承诺。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { prepareProfile, describeProfile } from './_test-profile.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPO_SRC = join(REPO, 'plugins', 'dsh-memory', 'index.js')

let failures = 0
let skips = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 同 search-render.test.mjs：装载来源三级解析，取不到就显式 skip 并计数（见 `_test-profile.mjs`）。
const prof = prepareProfile()
const DEPLOYED = prof.pluginPath
console.log('  info ' + describeProfile(prof))
if (prof.ok && prof.mode === 'host-profile') {
  check('★★ 部署副本与仓库源码逐字节一致（先跑 deploy）',
    Buffer.compare(readFileSync(DEPLOYED), readFileSync(REPO_SRC)) === 0)
}

const child = `
const mod = await import(${JSON.stringify('file:///' + DEPLOYED)})
const record = { tools: [] }
const stub = () => () => {}
const base = {
  effect: (fn) => { const d = fn(); return () => { try { if (typeof d === 'function') d() } catch {} } },
  tools: { register: (t) => { record.tools.push(t); return stub() } },
  webServer: { register: () => stub() },
  systemPrompt: { section: () => stub() },
}
const ctx = new Proxy(base, { get(t, p) { return p in t ? t[p] : stub() }, has: () => true })
mod.apply(ctx)
const t = record.tools.find((x) => x && x.name === 'memory_status')
const rendered = (v) => (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\\n')
const real = await t.execute({})                       // ← **真的调 execute**
console.log(JSON.stringify({
  realKeys: Object.keys(real).sort(),
  realEndpoint: String(real.embedEndpoint || ''),
  realText: rendered(t.output.render({}, real)),        // ← 真实返回喂给 render
  missingText: rendered(t.output.render({}, { chunks: 1, kvEntries: 1, embed: 'MiniMax embo-01' })),  // 字段缺失
  localText: rendered(t.output.render({}, { chunks: 1, kvEntries: 1, embed: 'bigram（本地降级）', embedEndpoint: 'local' })),
}))
`

if (prof.ok) {
  let raw = ''
  try {
    raw = execFileSync(process.execPath, ['--input-type=module', '-e', child], { cwd: prof.profile, encoding: 'utf8', timeout: 60000 })
  } catch (e) {
    failures++
    console.log('  FAIL 真装插件/真调 execute 失败 — ' + String((e.stdout || '') + (e.stderr || e.message)).slice(0, 400))
  }
  const line = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (line) {
    const r = JSON.parse(line)
    check('★★ execute 的返回里**必须**有 embedEndpoint（少了它，渲染层只能瞎猜，而它猜的是"本地/安全"）',
      r.realKeys.includes('embedEndpoint') && r.realKeys.includes('note'), JSON.stringify(r.realKeys))
    // 「真实链路」这一条必须**跟着本机配置走**（2026-09-23 修）：
    //   本机配了远端 embedding key ⇒ 必须报 remote；没配（CI runner / 干净机器）⇒ 后端本来就是 local，
    //   那时说"本机完成"是**真话**，不是假承诺。原来写死"不许出现未离开本机"，
    //   等于又断言了一次机器状态 —— 在 CI 上必然红（同一个病的第二处，同一天发现）。
    const realEndpoint = String(r.realEndpoint || '')
    const realIsRemote = /remote/.test(realEndpoint)
    check('★★ 真实链路的说法必须与 execute 报的 endpoint 一致（远端 ⇒ 不许承诺本地；本地 ⇒ 不许说 remote）',
      realIsRemote ? (!/未离开本机/.test(r.realText) && /remote/.test(r.realText)) : !/remote/.test(r.realText),
      'endpoint=' + JSON.stringify(realEndpoint) + ' text=' + String(r.realText).slice(0, 200))
    check('★★ 真实链路要**明说走了哪条路**（本机当前配了 MiniMax key ⇒ 必须报 remote + 警告）',
      /remote|本机完成|判不了/.test(r.realText), String(r.realText).slice(0, 260))
    check('★ 远端时给出"想改成本地怎么办"的下一步',
      !/remote/.test(r.realText) || /取消 MiniMax API key|bigram/.test(r.realText), String(r.realText).slice(0, 300))
    // 最关键的一条泛化：**字段缺失时不许当成本地**
    check('★★ 字段缺失时**不能说"内容未离开本机"**（fail-closed：判不了就说判不了）',
      !/未离开本机/.test(r.missingText) && /判不了|无法判断/.test(r.missingText), String(r.missingText).slice(0, 240))
    check('★ 真的是本地时才说本地（这条留着，免得把断言写成"永远不许说本地"）',
      /未离开本机/.test(r.localText), String(r.localText).slice(0, 200))
  }
}

if (!prof.ok) {
  skips++
  console.log('  skip 真装插件段 —— ' + prof.reason)
}
if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: memory_status 的隐私口径走 execute→render 整条链，且字段缺失时 fail-closed（F-054 回归）' +
  (skips ? `　⚠ 但 skipped ${skips} 段：真装插件段未覆盖，这不是通过` : ''))
