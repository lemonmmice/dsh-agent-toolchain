// dsh-memory BV-07 单测：隐私承诺的诚实性
//
// 病（2026-09-11 审计确证）：
//   插件给模型的系统提示公告写着「数据全部存储在本地 ~/.dsh/memory/，**不外传**」，
//   而本机配置了 MiniMax key 时，`memory_index` 会把文件分块**发到远程 api.minimax.chat** 做向量。
//   MCP 面的描述一直是对的（明写 "indexed content leaves this machine"），只有 DSH 面这句在撒谎 ——
//   而它正是 agent 向用户做隐私承诺时唯一的依据。
//
//   还有一层（同一类"算出来了没印出来"）：`status()` 一直返回 `embedEndpoint`/`note`，
//   MCP 面的 jtext 看得见，但 DSH 面的 `memory_status` 渲染只印 `embed` 标签
//   —— agent 看到"（MiniMax embo-01）"，**无从判断内容有没有出本机**。
//
// 本单测锁三件事：
//   1. 数据层：`status()` 必须给出 embedEndpoint + note（远端时明说会出本机）；
//   2. 默认视图：memory_status / memory_index 的渲染在远端时必须醒目提示（本机实测就是远端）；
//   3. 源码守卫：公告里不再有**无条件**的"不外传"承诺，且渲染确实读了 embedEndpoint。
import { DshMemory } from '../lib/memory.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
// W1：memory_index 的**描述**已迁进单一真源（lib/tool-registry.mjs）；隐私不变量在那边查。
const { dshDescription } = await import('../../../lib/tool-registry.mjs')

// ------------------------------------------------- 1. 数据层
{
  const m = new DshMemory({})
  const st = m.status()
  check('status() 给出 embedEndpoint', typeof st.embedEndpoint === 'string' && st.embedEndpoint.length > 0, JSON.stringify(st).slice(0, 240))
  check('status() 给出 note（隐私口径的自描述）', typeof st.note === 'string' && st.note.length > 0, JSON.stringify(st).slice(0, 240))
  const remote = String(st.embedEndpoint).startsWith('remote')
  check('远端时 note 明说内容离开本机', !remote || /leave this machine|REMOTE/i.test(st.note), JSON.stringify({ endpoint: st.embedEndpoint, note: st.note }))
  console.log('  （本机当前后端：' + st.embedEndpoint + '）')
}

// ------------------------------------------------- 2. 源码守卫
{
  // 无条件的"不外传"承诺必须消失（有条件地说明可以）
  // ⚠ CRLF 容错：本文件是 CRLF，旧正则 `\n\n` 匹配不到 `\r\n\r\n`（两个 \n 被 \r 隔开）⇒ 捕获空串，
  // 于是三条内容断言全假（"不外传"那条因空串反而假通过）。用 `\r?\n\r?\n` 兜住空行边界。
  const guidance = (src.match(/const GUIDANCE =[\s\S]*?\r?\n\r?\n/) || [''])[0]
  check('公告里不再出现无条件"不外传"', !/不外传/.test(guidance) || /不要向用户承诺/.test(guidance), guidance.slice(0, 300))
  check('公告点名了远程 api.minimax.chat 与"内容离开本机"', /api\.minimax\.chat/.test(guidance) && /离开本机|出本机/.test(guidance), guidance.slice(0, 400))
  check('公告要求先查 memory_status 再回答隐私问题', /先调 memory_status|memory_status 看 embedEndpoint/.test(guidance), guidance.slice(0, 400))
  // W1：描述搬进注册表后，这条隐私不变量对**注册表里的 memory_index 描述**查（模型读的就是这条）。
  const memIndexDesc = dshDescription('memory_index')
  check('memory_index 的工具描述也写了隐私（模型读的是这条）', /隐私：/.test(memIndexDesc) && /可能出本机/.test(memIndexDesc), '注册表 memory_index.descZh')
  check('memory_index 的返回值带 embedEndpoint/privacyNote', /embedEndpoint: st\.embedEndpoint/.test(src) && /privacyNote: st\.note/.test(src))
  check('memory_status 渲染读 embedEndpoint 并分远端/本地两路', /startsWith\('remote'\)/.test(src) && /不要向用户承诺/.test(src))
}

// ------------------------------------------------- 3. 默认视图（真装插件、真调 render）
{
  // 必须用**已部署**的 profile 副本来装：插件的 `@deepseek-ai/dsh-tools` 是裸包名，
  // 只有 profile 的 node_modules 里才有解析（与 plugin-load-smoke 同一个原因）。
  // 路径用 homedir() 拼，不写死用户名/盘符（仓库文件里不许出现本机私有路径，check.mjs 会拦）。
  const PROFILE = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web')
  const modPath = PROFILE + '/plugins/dsh-memory/index.js'
  if (!existsSync(modPath)) {
    console.log('  skip 未找到已部署副本（' + modPath + '）→ 跳过真装插件段')
  } else {
    const child = `
const mod = await import(${JSON.stringify('file:///' + modPath)})
const record = { tools: [], routes: [], sections: [] }
const disposers = []
const stub = () => () => {}
const base = {
  effect: (fn) => { const d = fn(); return () => { try { if (typeof d === 'function') d() } catch {} } },
  tools: { register: (t) => { record.tools.push(t); return stub() } },
  webServer: { register: (r) => { record.routes.push(r); return stub() } },
  systemPrompt: { section: (s) => { record.sections.push(s); return stub() } },
}
const ctx = new Proxy(base, { get(t, p) { return p in t ? t[p] : stub() }, has: () => true })
mod.apply(ctx)
const pick = (n) => record.tools.find((t) => t && t.name === n)
const callRender = (n, v) => {
  const t = pick(n)
  if (!t || !t.output || typeof t.output.render !== 'function') return null
  const out = t.output.render({}, v)
  const a = Array.isArray(out) ? out : [out]
  return a.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\\n')
}
const REMOTE = { chunks: 2177, kvEntries: 63, embed: 'MiniMax embo-01', embedEndpoint: 'remote (api.minimax.chat)', note: 'embedding runs on a REMOTE API: indexed file chunks leave this machine.' }
const LOCAL = { chunks: 1, kvEntries: 1, embed: 'local bigram', embedEndpoint: 'local', note: 'embeddings are computed locally (bigram fallback).' }
const IDX_REMOTE = { files: 10, chunks: 100, indexed: 10, skipped: 0, deleted: 0, embed: 'MiniMax embo-01', embedEndpoint: 'remote (api.minimax.chat)', privacyNote: 'REMOTE' }
const IDX_LOCAL = { files: 10, chunks: 100, indexed: 10, skipped: 0, deleted: 0, embed: 'local bigram', embedEndpoint: 'local', privacyNote: 'local' }
console.log(JSON.stringify({
  names: record.tools.map((t) => t && t.name).filter(Boolean).sort(),
  statusRemote: callRender('memory_status', REMOTE),
  statusLocal: callRender('memory_status', LOCAL),
  indexRemote: callRender('memory_index', IDX_REMOTE),
  indexLocal: callRender('memory_index', IDX_LOCAL),
}))
`
    let raw = ''
    try {
      raw = execFileSync(process.execPath, ['--input-type=module', '-e', child], { cwd: PROFILE, encoding: 'utf8', timeout: 60000 })
    } catch (e) {
      failures++
      console.log('  FAIL 真装插件失败 — ' + String((e.stdout || '') + (e.stderr || e.message)).slice(0, 400))
    }
    const line = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
    if (line) {
      const r = JSON.parse(line)
      check('装载出 6 个工具', Array.isArray(r.names) && r.names.length === 6, JSON.stringify(r.names))
      check('memory_status 远端 → 明说"会发到远程 API"', /发到远程 API/.test(String(r.statusRemote)), String(r.statusRemote).slice(0, 220))
      check('memory_status 远端 → 明说"不要向用户承诺数据不外传"', /不要向用户承诺/.test(String(r.statusRemote)), String(r.statusRemote).slice(0, 260))
      check('memory_status 远端 → 印出 endpoint 取值', /api\.minimax\.chat/.test(String(r.statusRemote)), String(r.statusRemote).slice(0, 220))
      check('memory_status 本地 → 不刷噪音（说"内容未离开本机"）', !/⚠/.test(String(r.statusLocal)) && /未离开本机|在本机完成/.test(String(r.statusLocal)), String(r.statusLocal).slice(0, 220))
      check('memory_index 远端 → 醒目警告（索引完就知道内容出去了）', /embedding 走的是远程 API/.test(String(r.indexRemote)) && /已经离开本机/.test(String(r.indexRemote)), String(r.indexRemote).slice(0, 260))
      check('memory_index 本地 → 不刷噪音', !/⚠/.test(String(r.indexLocal)), String(r.indexLocal).slice(0, 200))
    }
  }
}

console.log(failures === 0 ? '\nPASS: dsh-memory BV-07 隐私承诺诚实性' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
