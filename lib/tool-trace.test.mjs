// W2（追踪）单测：纯计算 + 注入时钟/落地，跨平台，可在 macOS/CI 上跑。
import { makeToolTrace, wrapToolArgs, resultOk, errorCodeOf } from './tool-trace.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

async function main() {
  // ---- resultOk / errorCodeOf ----
  check('resultOk: 普通结果为真', resultOk({ content: [] }) === true)
  check('resultOk: isError=true 为假', resultOk({ content: [], isError: true }) === false)
  check('errorCodeOf: 取 code', errorCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' })) === 'ENOENT')
  check('errorCodeOf: 回落 name（不含 message）', errorCodeOf(new TypeError('secret path /a/b')) === 'TypeError')

  // ---- 关：wrap 返回原函数本身（零回归）----
  {
    const t = makeToolTrace({ enabled: false, sink: () => { throw new Error('不该被调用') } })
    const h = async () => ({ ok: true })
    check('关闭：wrap 原样返回 handler', t.wrap('x', h) === h)
  }

  // ---- 开：成功路径记 ok:true + 时间 + runId，且返回值不变 ----
  {
    const recs = []
    let clock = 1000
    const t = makeToolTrace({ enabled: true, now: () => clock, sink: (r) => recs.push(r) })
    const wrapped = t.wrap('build_run', async (args) => { clock = 1300; return { content: [{ type: 'text', text: 'ok' }] } })
    const res = await wrapped({ runId: 'r-42', project: 'secret.csproj', password: 'hunter2' })
    check('返回值透传', res && res.content && res.content[0].text === 'ok')
    check('记了一条', recs.length === 1)
    const rec = recs[0] || {}
    check('tool 名正确', rec.tool === 'build_run')
    check('runId 提取', rec.runId === 'r-42')
    check('ok=true', rec.ok === true)
    check('耗时 = 300ms', rec.ms === 300 && rec.startedAt === 1000 && rec.finishedAt === 1300)
    check('★不记参数/输出（字段是固定白名单）',
      JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(['errorCode', 'finishedAt', 'ms', 'ok', 'runId', 'startedAt', 'tool']),
      JSON.stringify(Object.keys(rec)))
    check('★轨迹不含敏感值', !JSON.stringify(rec).includes('hunter2') && !JSON.stringify(rec).includes('secret.csproj'))
  }

  // ---- 开：结果 isError=true → 记 ok:false ----
  {
    const recs = []
    const t = makeToolTrace({ enabled: true, now: () => 0, sink: (r) => recs.push(r) })
    const wrapped = t.wrap('verify_report', async () => ({ content: [], isError: true }))
    await wrapped({})
    check('isError 结果 → ok:false', recs[0].ok === false && recs[0].errorCode === null)
  }

  // ---- 开：handler 抛错 → 记 ok:false + errorCode，并原样重抛 ----
  {
    const recs = []
    const t = makeToolTrace({ enabled: true, now: () => 0, sink: (r) => recs.push(r) })
    const wrapped = t.wrap('perf_dump', async () => { throw Object.assign(new Error('boom'), { code: 'EPIPE' }) })
    let threw = false
    try { await wrapped({}) } catch (e) { threw = true; check('错误原样重抛', e && e.code === 'EPIPE') }
    check('抛错也记了一条 ok:false', recs.length === 1 && recs[0].ok === false && recs[0].errorCode === 'EPIPE')
    check('确实重抛了', threw === true)
  }

  // ---- 落地失败不影响工具（sink 抛错被吞）----
  {
    const t = makeToolTrace({ enabled: true, now: () => 0, sink: () => { throw new Error('disk full') } })
    const wrapped = t.wrap('x', async () => 42)
    let ok = false
    try { ok = (await wrapped({})) === 42 } catch { ok = false }
    check('sink 抛错被吞，工具结论不变', ok === true)
  }

  // ---- wrapToolArgs：各 arity 都包最后一个函数参 ----
  {
    const seen = []
    const wrap = (name, h) => { seen.push(name); return h }
    const a4 = wrapToolArgs(['build_run', 'desc', {}, async () => 1], wrap)
    check('4 参：包住 handler', typeof a4[3] === 'function' && seen.includes('build_run'))
    const a3 = wrapToolArgs(['ui_status', 'desc', async () => 1], wrap)
    check('3 参：包住 handler', typeof a3[2] === 'function' && seen.includes('ui_status'))
    const noFn = wrapToolArgs(['x', 'y', 'z'], wrap)
    check('末位非函数：原样不动', noFn[2] === 'z')
  }
}

main().then(() => {
  console.log(failures === 0 ? 'PASS tool-trace (all checks)' : `FAIL tool-trace (${failures} failed)`)
  process.exit(failures ? 1 : 0)
}).catch((e) => {
  console.log('FAIL tool-trace (threw) — ' + (e && e.stack || e))
  process.exit(1)
})
