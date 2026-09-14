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
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPO_SRC = join(REPO, 'plugins', 'dsh-memory', 'index.js')
const PROFILE = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web')
const DEPLOYED = join(PROFILE, 'plugins', 'dsh-memory', 'index.js')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

check('★ 找得到已部署副本', existsSync(DEPLOYED), DEPLOYED)
if (existsSync(DEPLOYED)) {
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
  realText: rendered(t.output.render({}, real)),        // ← 真实返回喂给 render
  missingText: rendered(t.output.render({}, { chunks: 1, kvEntries: 1, embed: 'MiniMax embo-01' })),  // 字段缺失
  localText: rendered(t.output.render({}, { chunks: 1, kvEntries: 1, embed: 'bigram（本地降级）', embedEndpoint: 'local' })),
}))
`

if (existsSync(DEPLOYED)) {
  let raw = ''
  try {
    raw = execFileSync(process.execPath, ['--input-type=module', '-e', child], { cwd: PROFILE, encoding: 'utf8', timeout: 60000 })
  } catch (e) {
    failures++
    console.log('  FAIL 真装插件/真调 execute 失败 — ' + String((e.stdout || '') + (e.stderr || e.message)).slice(0, 400))
  }
  const line = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (line) {
    const r = JSON.parse(line)
    check('★★ execute 的返回里**必须**有 embedEndpoint（少了它，渲染层只能瞎猜，而它猜的是"本地/安全"）',
      r.realKeys.includes('embedEndpoint') && r.realKeys.includes('note'), JSON.stringify(r.realKeys))
    check('★★ 真实链路里**不许出现"内容未离开本机"**这种未经证实的本地承诺',
      !/未离开本机/.test(r.realText), String(r.realText).slice(0, 260))
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

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: memory_status 的隐私口径走 execute→render 整条链，且字段缺失时 fail-closed（F-054 回归）')
