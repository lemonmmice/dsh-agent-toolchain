// dsh-memory 单测：检索结果**不许带向量**，且片段有上限（2026-09-11 真机自查）。
//
// 为什么值得单测：`store.search` 的每一行都含 1536 维浮点向量，而 MCP 面是 `jtext()` **直出原始对象** ——
// 一次 k=5 的检索会往 agent 上下文塞约 5×1536 个数（几万字符），真正的信息（文件/片段/分数）被淹没。
// agent 用不上向量；这条不变量既省上下文，也让"返回什么"变成可断言的事实。
import { DshMemory } from '../lib/memory.mjs'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const dataDir = mkdtempSync(join(tmpdir(), 'mem-search-'))
const docs = mkdtempSync(join(tmpdir(), 'mem-search-docs-'))
try {
  // 造一份可检索的文档（长片段用于验证 text 上限）
  mkdirSync(join(docs, 'sub'), { recursive: true })
  writeFileSync(join(docs, 'a.md'), '# env fallback\n' + 'DSH_UI_PROC_NAME 从用户级注册表回退的一段很长的说明。'.repeat(40) + '\n', 'utf8')
  writeFileSync(join(docs, 'sub', 'b.md'), '# code freshness\n部署戳判据与 moduleRoots 的说明。\n', 'utf8')

  const m = new DshMemory({ dataDir, project: 'search-payload-test' })
  const idx = await m.indexWorkspace(docs)
  check('索引成功（有分块）', idx.chunks > 0, JSON.stringify(idx))

  const hits = await m.search('env fallback 注册表 回退', 5)
  check('search 返回数组（不是 {results} 包裹 —— 消费方按数组读）', Array.isArray(hits), Object.prototype.toString.call(hits))
  check('检索有命中（否则下面的断言都是空转）', hits.length > 0, 'hits=' + hits.length)
  if (hits.length) {
    const withVec = hits.filter((h) => 'vector' in h)
    check('**结果里不带向量**（1536 维浮点会挤爆上下文）', withVec.length === 0, '带向量的条数=' + withVec.length)
    check('保留 id / score / meta（信息没被一起砍掉）', hits.every((h) => typeof h.id === 'string' && typeof h.score === 'number' && h.meta && typeof h.meta === 'object'),
      JSON.stringify({ id: hits[0].id, score: hits[0].score, metaKeys: Object.keys(hits[0].meta || {}) }))
    check('score 保留 4 位精度（可读且够用）', String(hits[0].score).split('.')[1] === undefined || String(hits[0].score).split('.')[1].length <= 4, String(hits[0].score))
    const longText = hits.map((h) => (h.meta && h.meta.text) || '').sort((a, b) => b.length - a.length)[0] || ''
    check('片段长度有上限（超长会截断并说明）', longText.length <= 900, 'len=' + longText.length)
    if (longText.length >= 800) check('超长片段带"已截断"提示', /已截断/.test(longText), longText.slice(-40))
    // 整包体积：k=5 不应超过几万字符（这正是修这条的目的）
    const bytes = JSON.stringify(hits).length
    check('单次检索的 JSON 体积可控（< 20KB）', bytes < 20000, 'bytes=' + bytes)
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(docs, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: dsh-memory 检索返回体（不带向量 + 片段上限）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
