// dsh-verify 新增的四个失败样本库工具：**真的能跑**，不只是"注册上了"（F-003/E4，r35）。
//
// 为什么要这个测试：E4 那轮我给 DSH 面补了 `failure_query / failure_stats / failure_record / failure_retract`，
// 而"**工具注册成功**"与"**工具能用**"是两件事 —— `toolface-parity.test.mjs` 只证明前者。
// 一个工具完全可能注册得很漂亮、却在 `execute()` 里 import 错路径 / 调错 API。
//
// 隔离：全程用**临时目录**（`DSH_FAILURE_CORPUS_DIR`），**绝不碰真库**。
// 走**部署副本**加载（仓库里的 index.js 有裸包名 `@deepseek-ai/dsh-tools`，在仓库内解析不了）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'

let failures = 0
let skipped = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' — ' + why) }

// ── 自检 ──
{
  let sawFail = false
  const probe = (c) => { if (!c) sawFail = true }
  probe(false)
  console.log((sawFail ? '  ok   ' : '  FAIL ') + '（自检）断言器有效')
  if (!sawFail) failures++
}

const explicit = process.env.DSH_PROFILE_DIR
const fallback = join(process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh'), 'profiles', 'web')
const profile = explicit
  ? (existsSync(join(explicit, 'plugins')) ? explicit : '')
  : (existsSync(join(fallback, 'plugins')) ? fallback : '')

if (!profile) {
  skip('失败样本库四工具集成测试', '未找到可用 profile（且显式设了却无效时不回退）')
} else {
  const entry = join(profile, 'plugins', 'dsh-verify', 'index.js')
  if (!existsSync(entry)) {
    skip('失败样本库四工具集成测试', '部署副本里没有 dsh-verify/index.js（未 deploy？）')
  } else {
    // 临时库：**不碰真库**
    const tmpCorpus = mkdtempSync(join(tmpdir(), 'dsh-r35-corpus-'))
    process.env.DSH_FAILURE_CORPUS_DIR = tmpCorpus

    const rec = { tools: [] }
    const base = {
      effect: (fn) => { try { fn() } catch { /* ignore */ } ; return () => {} },
      tools: { register: (t) => { rec.tools.push(t); return () => {} } },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }
    const ctx = new Proxy(base, { get: (t, p) => (p in t ? t[p] : (typeof p === 'string' ? () => () => {} : undefined)), has: () => true })

    let loaded = false
    try {
      const mod = await import('file:///' + entry.replace(/\\/g, '/'))
      if (typeof mod.apply === 'function') { await mod.apply(ctx); loaded = true }
    } catch (e) { check('加载 dsh-verify 插件', false, String(e.message || e)) }

    const by = (n) => rec.tools.find((t) => t && t.name === n)
    if (loaded) {
      const want = ['failure_query', 'failure_stats', 'failure_record', 'failure_retract']
      check('★ 四个失败样本库工具都注册在 DSH 面',
        want.every((n) => !!by(n)), JSON.stringify(rec.tools.map((t) => t.name)))

      // ---- 真的调用它们 ----
      if (want.every((n) => !!by(n))) {
        const recRes = await by('failure_record').execute({
          task: 'r35 integration', failureClass: 'tool-error',
          description: '集成测试写的一条记录（临时库）',
        })
        check('★ failure_record 真的写进去了（返回 id）',
          recRes && typeof recRes.id === 'string' && recRes.id.length > 0, JSON.stringify(recRes).slice(0, 160))

        const q = await by('failure_query').execute({ q: 'r35 integration' })
        check('★ failure_query 能查到刚写的那条',
          q && Number(q.count) >= 1 && JSON.stringify(q).includes('r35 integration'), JSON.stringify(q).slice(0, 200))

        const st = await by('failure_stats').execute({})
        check('★ failure_stats 能统计到（total ≥ 1，且带全部 shard 口径字段）',
          st && Number(st.total) >= 1, JSON.stringify(st).slice(0, 200))
        check('★ failure_stats 带 totalAllShards / retracted（"total 变小可解释" + 撤回可见）',
          st && ('totalAllShards' in st) && ('retracted' in st), Object.keys(st || {}).join(','))

        const rt = await by('failure_retract').execute({
          id: recRes.id, reason: '集成测试：这条是测试数据', by: 'test',
        })
        check('★ failure_retract 真的撤回了', rt && rt.ok === true, JSON.stringify(rt).slice(0, 200))

        const q2 = await by('failure_query').execute({ q: 'r35 integration' })
        check('★ 撤回后默认查不到（count=0）而 retractedExcluded ≥ 1',
          q2 && Number(q2.count) === 0 && Number(q2.retractedExcluded) >= 1, JSON.stringify(q2).slice(0, 200))

        const q3 = await by('failure_query').execute({ q: 'r35 integration', includeRetracted: true })
        check('★ includeRetracted=true 时又能看到它（原文保留、可审计）',
          q3 && Number(q3.count) >= 1, JSON.stringify(q3).slice(0, 200))

        // 反面：撤回一个不存在的 id 必须被拒绝（不是静默成功）
        const bad = await by('failure_retract').execute({ id: 'fc-does-not-exist-xyz', reason: 'x' })
        check('★ 撤回不存在的 id 被拒绝（不静默成功）', !bad || bad.ok !== true, JSON.stringify(bad).slice(0, 160))
      }
    }

    try { rmSync(tmpCorpus, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : `\nPASS: dsh-verify 失败样本库四工具集成（F-003/E4：注册 ≠ 能用）${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failures ? 1 : 0)
