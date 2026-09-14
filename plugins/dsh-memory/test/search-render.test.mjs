// F-052 回归：**渲染层必须把命中内容打出来**，不能只报条数。
//
// 背景（2026-09-14 整理记忆时实测）：DSH 面 `memory_search` 的 render 只打印
// 「找到 N 条相关记忆（backend）」，`execute` 返回的 hits（file/chunk/score/text）**全被丢掉**
// ⇒ agent 知道"有几条"，但**拿不到任何一条的内容** —— 记忆库的读路径在 DSH 面等于坏的。
// MCP 面是 jtext 整个对象，所以只有 DSH 面坏（两面不一致）。
//
// 为什么之前的测试没抓到：`bv07-privacy-honesty.test.mjs` 会给 `memory_status` / `memory_index`
// 调 render 做断言，**但没有给 `memory_search` 调** —— 覆盖差一个工具就是差一个 bug。
//
// 做法照抄 `bv07` 的**正确姿势**：起子进程**真装载插件、真调 `output.render`**。
// ⚠ 第一版我用正则从源码里"抠" render 出来 eval —— 那玩意只认"块体箭头函数"这一种写法，
//   换成一行式就抠不到 ⇒ **合法的实现也会被误判**（证伪当场暴露：红在了"抠不到"而不是"内容没打出来"）。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPO_SRC = join(REPO, 'plugins', 'dsh-memory', 'index.js')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 路径用 homedir() 拼，不写死用户名/盘符（仓库文件里不许出现本机私有路径，check.mjs 会拦）
const PROFILE = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web')
const DEPLOYED = join(PROFILE, 'plugins', 'dsh-memory', 'index.js')

check('★ 找得到已部署副本', existsSync(DEPLOYED), DEPLOYED)
// ⚠ 关键：**必须断言测的就是仓库源码**。否则这个测试可能在比对"另一个版本"，
//   而它**看不出来**（部署副本与仓库源码一致由 `deploy-plugins.mjs --check` 保证，这里再钉一次）。
if (existsSync(DEPLOYED)) {
  check('★★ 部署副本与仓库源码**逐字节一致**（否则测的是什么就不确定了 —— 先跑 deploy）',
    Buffer.compare(readFileSync(DEPLOYED), readFileSync(REPO_SRC)) === 0,
    'deployed=' + DEPLOYED)
}

const HITS = [
  { file: 'PROGRESS.md', chunk: 12, score: 0.812, text: 'F-049：renderTrace 只按 v.started 分叉，把 status 渲染成 trace 完成 0MB' },
  { file: 'callee-wiring.mjs', chunk: 3, score: 0.744, text: 'stripComments 必须与输入等长，否则下标错位' },
]
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
const callRender = (n, v) => {
  const t = record.tools.find((x) => x && x.name === n)
  if (!t || !t.output || typeof t.output.render !== 'function') return null
  const out = t.output.render({}, v)
  const a = Array.isArray(out) ? out : [out]
  return a.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\\n')
}
const HITS = ${JSON.stringify(HITS)}
console.log(JSON.stringify({
  hits: callRender('memory_search', { hits: HITS, embed: 'MiniMax embo-01', freshnessNote: '索引有 2 天未更新' }),
  empty: callRender('memory_search', { hits: [], embed: 'MiniMax embo-01' }),
}))
`

if (existsSync(DEPLOYED)) {
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
    const out = String(r.hits || '')
    check('★ 真的调到了 memory_search 的 render（拿到 null = 工具没注册/没 render）', out.length > 0, String(r.hits).slice(0, 80))
    check('★★ 命中内容真的打出来了（F-052：以前只打印条数，hits 全丢）',
      out.includes('F-049') && out.includes('stripComments'), out.slice(0, 220))
    check('★ 带上来源文件与序号', out.includes('PROGRESS.md') && out.includes('callee-wiring.mjs') && out.includes('[1]'))
    check('★ 带上 score（检索结果不给分就没法判断可信度）', out.includes('0.812'))
    check('★ 新鲜度提示也带出来（陈旧索引必须说清）', out.includes('索引有 2 天未更新'))
    check('★ 仍然报条数与后端（原来那半句不能丢）', /找到 2 条相关记忆/.test(out) && out.includes('MiniMax'))
    const empty = String(r.empty || '')
    check('★★ 空结果要说清"没命中"并给出下一步（不能只给一个 0 字）',
      /没有命中片段/.test(empty) && /memory_status/.test(empty), empty.slice(0, 180))
  }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: memory_search 渲染层必须给出命中内容（F-052 回归）')
