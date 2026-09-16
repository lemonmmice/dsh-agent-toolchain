// mcp/execute-sideeffects.test.mjs — D.5（r61）：**有副作用工具**的 execute 冒烟，跑在**临时 store** 上。
//
// 为什么需要这一段：
//   `mcp/smoke.mjs` 的 execute 冒烟（D.2）只跑**只读**工具；带副作用的（写 KV / 写失败样本库）一直
//   停在"登记了理由、从没真跑过"的状态（toolface-params.test.mjs 的 NOT_EXECUTED_HERE）。
//   而"写了理由 ≠ 测过"——`failure_retract` 到底会不会真的把记录从 active 里排除掉、`memory_recall`
//   会不会取回**同一个值**，只有真的跑一遍 save→recall / record→retract 才知道。
//
// 怎么做到**安全**（绝不污染真实记忆/样本库）：
//   两个 store 的数据目录都由环境变量决定，且 `lib/env-fallback.mjs` 的 envOr **进程环境优先**
//   （DSH_MEMORY_DIR memory.mjs:32 / DSH_FAILURE_CORPUS_DIR failure-corpus.mjs:42）。
//   所以这里**另起一个 server 子进程**，把这两个变量指到 mkdtemp 的临时目录，并带上 DSH_NO_ENV_FALLBACK=1
//   （彻底不看注册表）——子进程从出生起就只认临时目录，真实 store 一个字节都不会被碰。跑完删临时目录。
//
// 判据（每条都是**行为断言**，不是"没抛就算过"）：
//   · memory_save→memory_recall 取回**同一个值**；换个 scope **取不到**（scope 真隔离）；
//   · failure_record 返回带 id 的记录；**撤回前**查得到、**撤回后**查不到（retractedExcluded 记数）；
//   · 撤回**不带理由**被拒（"撤回要带理由"是硬约束，不是文档）；撤回不存在的 id 被拒（反向自证）。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.mjs')

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ── 临时 store（子进程用；跑完删掉）──
const memDir = mkdtempSync(join(tmpdir(), 'r61-mem-'))
const corpusDir = mkdtempSync(join(tmpdir(), 'r61-corpus-'))
function cleanup() {
  for (const d of [memDir, corpusDir]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DSH_MEMORY_DIR: memDir,
    DSH_FAILURE_CORPUS_DIR: corpusDir,
    // 测试硬闸：彻底不回退注册表（真实 store 的路径就在注册表里 —— 绝不能因为回退而写到那里）。
    DSH_NO_ENV_FALLBACK: '1',
  },
})
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('error', (e) => { console.error('SIDEEFFECT SMOKE FAIL: 子进程起不来 — ' + (e && e.message ? e.message : e)); cleanup(); process.exit(1) })

// ── 行缓冲的 JSON-RPC 客户端（每个 id 一个 Promise；stdout 分片会跨行，必须自己缓冲）──
let buf = ''
const waiters = new Map()   // id → resolve
child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.includes('"id"')) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && waiters.has(msg.id)) { const r = waiters.get(msg.id); waiters.delete(msg.id); r(msg) }
  }
})

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(id); reject(new Error('等 ' + method + ' 响应超时')) }, 60000)
    waiters.set(id, (msg) => { clearTimeout(t); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
/** tools/call → 解析 content[0].text（本仓工具都走 jtext，正文是 JSON 串）。 */
async function call(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args })
  if (msg.error) return { rpcError: msg.error, json: null, text: '' }
  const res = msg.result || {}
  const content = Array.isArray(res.content) ? res.content : []
  const text = content.length ? String(content[0].text ?? '') : ''
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { isError: res.isError === true, text, json }
}

const hardTimeout = setTimeout(() => { console.error('SIDEEFFECT SMOKE FAIL: 总超时'); try { child.kill() } catch { /* ignore */ } cleanup(); process.exit(1) },
  Number(process.env.DSH_MCP_SMOKE_TIMEOUT_MS || 120000))

function finish() {
  clearTimeout(hardTimeout)
  try { child.kill() } catch { /* ignore */ }
  cleanup()
  if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
  console.log('\nPASS: 副作用工具 execute 冒烟（临时 store：memory_save→recall 往返 + scope 隔离；failure_record→retract 需理由、撤回前后查询真的变化）')
  process.exit(0)
}

try {
  // 断言器自检：不能恒真
  check('（自检）断言器有效', (() => { let s = false; const p = (c) => { if (!c) s = true }; p(false); return s })())

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sideeffect-smoke', version: '0' } })

  // ── ① memory_save → memory_recall（临时 scope）──
  const KEY = 'r61-smoke-key'
  const VAL = 'hello-from-r61-execute-smoke'          // 明文、非 secret 形状（避免 fail-closed 拒绝）
  const SCOPE = 'r61-smoke-scope'
  const saved = await call('memory_save', { key: KEY, value: VAL, scope: SCOPE })
  check('memory_save 真跑过且未被拒（没有 RPC error / isError / "rejected"）',
    !saved.rpcError && !saved.isError && !/rejected/i.test(saved.text), JSON.stringify(saved.rpcError || saved.text.slice(0, 140)))
  const recalled = await call('memory_recall', { key: KEY, scope: SCOPE })
  check('★★ memory_recall 取回**同一个值**（save→recall 真往返，不是"没抛就算过"）',
    !!recalled.json && recalled.json.found === true && recalled.json.value === VAL && recalled.json.scope === SCOPE,
    JSON.stringify(recalled.json))
  const wrongScope = await call('memory_recall', { key: KEY, scope: 'r61-some-other-scope' })
  check('★ scope 真隔离：换一个 scope 取不到（found:false）',
    !!wrongScope.json && wrongScope.json.found === false, JSON.stringify(wrongScope.json))

  // ── ② failure_record → failure_retract（临时 corpus）──
  const rec = await call('failure_record', {
    task: 'r61-execute-smoke',
    failureClass: 'flaky',
    description: 'D.5 冒烟：合成记录，登记后立即撤回（DSH_FAILURE_CORPUS_DIR 指向临时目录，不进真实样本库）',
  })
  const id = rec.json && rec.json.id
  check('★★ failure_record 返回带 id 的记录（fc-YYYYMMDD-…）', typeof id === 'string' && /^fc-\d{8}-/.test(id), JSON.stringify(rec.json))

  // 撤回**前**：查得到（证明记录真的进了库；也给"撤回后消失"当对照）
  const before = await call('failure_query', { q: 'r61-execute-smoke' })
  const inBefore = !!before.json && Array.isArray(before.json.rows) && before.json.rows.some((r) => r && r.id === id)
  check('★ 撤回前 failure_query 查得到这条记录（作为撤回生效的对照）', inBefore, JSON.stringify({ total: before.json && before.json.total }))

  // "撤回必须带理由"是硬约束，两层各证一次（不是"写了理由就算测过"）：
  //   (a) MCP schema 层：reason 是 required ⇒ 整个省掉会被拒（宿主把校验错回成 rpcError
  //       或 isError:true 的结果，两种投递都算"被拒"，只要没成功撤回即可）。
  const missingReason = await call('failure_retract', { id })
  const missRejected = !!missingReason.rpcError || missingReason.isError === true
  const missMsg = String(missingReason.rpcError ? JSON.stringify(missingReason.rpcError) : missingReason.text)
  check('★ 撤回**省掉 reason** 在 MCP schema 层就被拒（required 参数：RPC error 或 isError，到不了 handler）',
    missRejected && /validation|invalid|required|expected string|reason|理由/i.test(missMsg), missMsg.slice(0, 140))
  //   (b) corpus 守卫层：reason 传了但为空串 ⇒ 通过 schema、被 retract() 自己拒（ok:false）。
  const emptyReason = await call('failure_retract', { id, reason: '' })
  check('★★ 撤回**空理由**被 corpus 守卫拒（ok:false 且 error 点名 reason）',
    !!emptyReason.json && emptyReason.json.ok === false && /reason|理由/i.test(String(emptyReason.json.error || '')), JSON.stringify(emptyReason.json))
  // 被拒的撤回**不许**改动库：这条记录应当**仍在** active（证明守卫真挡住了写入，不是空谈）
  const stillThere = await call('failure_query', { q: 'r61-execute-smoke' })
  check('★★ 被拒的撤回没有改动库（记录仍在 active）—— "带理由"不是文档，是真挡住了写入',
    !!stillThere.json && Array.isArray(stillThere.json.rows) && stillThere.json.rows.some((r) => r && r.id === id),
    JSON.stringify({ total: stillThere.json && stillThere.json.total }))

  // 带理由撤回：必须成功且 retracts === 原 id
  const retracted = await call('failure_retract', { id, reason: 'D.5 冒烟：为冒烟合成的记录，按规程带理由撤回' })
  check('★★ 带理由撤回成功（ok:true 且 retracts === 原 id）',
    !!retracted.json && retracted.json.ok === true && retracted.json.retracts === id, JSON.stringify(retracted.json))

  // 撤回**后**：active 里不再有它（retractedExcluded 记到数）——撤回真的生效
  const after = await call('failure_query', { q: 'r61-execute-smoke' })
  const inAfter = !!after.json && Array.isArray(after.json.rows) && after.json.rows.some((r) => r && r.id === id)
  check('★★ 撤回后 failure_query **查不到**它了（从 active 排除 —— 撤回真的生效，不只是返回 ok）',
    inAfter === false && after.json && after.json.retractedExcluded >= 1,
    JSON.stringify({ inAfter, retractedExcluded: after.json && after.json.retractedExcluded }))
  const stats = await call('failure_stats', {})
  check('★ failure_stats 也反映撤回（retracted ≥ 1）', !!stats.json && Number(stats.json.retracted) >= 1, JSON.stringify(stats.json && { retracted: stats.json.retracted }))

  // 反向自证：撤回**不存在**的 id 必须被拒（撤回不是恒真）
  const bogus = await call('failure_retract', { id: 'fc-20000101-deadbeefcafe', reason: '不存在的 id，应被拒' })
  check('★ （反向自证）撤回**不存在**的 id 被拒（ok:false）', !!bogus.json && bogus.json.ok === false, JSON.stringify(bogus.json))

  finish()
} catch (e) {
  console.error('SIDEEFFECT SMOKE FAIL: ' + (e && e.message ? e.message : e))
  try { child.kill() } catch { /* ignore */ }
  cleanup()
  process.exit(1)
}
