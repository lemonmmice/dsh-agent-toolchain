// `memory_search` 的**索引新鲜度**契约（2026-09-12「用户可见结论的最坏情况」主题最后一条）。
//
// 病（真机实测）：改文件后**不重索引**再检索 —— 命中的 3 条**全是旧内容**（文本里根本没有新 token），
// 而返回里没有任何字段提示"这是索引里的旧快照" ⇒ agent 会把**过期内容当现状引用**，
// 这比"没命中"更危险（没命中至少会促使人去查）。
// 修法：索引里本来就存了 `meta.mtime`（增量跳过靠它），拿它与磁盘现在的 mtime 比，陈旧就如实标出。
//
// 真机验证输出（probe-memory-stale.mjs）：
//   freshnessNote = ⚠ 命中来自**索引快照**，但源文件已变化：1 个文件**在索引之后被改过**（notes.md）
//   —— **返回的片段可能是旧内容**，不要直接当成现状引用。下一步：对该目录重跑 memory_index 后重新检索。
//   staleFiles = ["notes.md"]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

const memSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'memory.mjs'), 'utf8')
const mcpSrc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'mcp', 'server.mjs'), 'utf8')
const dshSrc = readFileSync(join(import.meta.dirname, '..', 'index.js'), 'utf8')

check('search() 仍返回数组（不破坏既有调用方）', /async search\(query, k = 5\) \{\s*\n\s*const \{ hits \} = await this\.searchDetailed/.test(memSrc), 'search 的签名/返回形状变了')
check('★ 提供 searchDetailed（带 freshness）', /async searchDetailed\(query, k = 5\)/.test(memSrc))
check('★ 用**索引时的 mtime vs 磁盘现在 mtime** 判断陈旧（不是猜）',
  /Math\.abs\(now\.mtimeMs - Number\(meta\.mtime\)\)/.test(memSrc))
check('★ 陈旧时明说"返回的片段可能是旧内容"', /返回的片段可能是旧内容/.test(memSrc))
check('★ 给出下一步（重跑 memory_index）', /重跑 memory_index 后重新检索/.test(memSrc))
check('文件被删的情况单独区分', /deletedFiles/.test(memSrc) && /已不存在/.test(memSrc))
check('MCP 面接了 searchDetailed 并带 freshnessNote', /searchDetailed\(args\.query, k\)/.test(mcpSrc) && /freshnessNote: freshness\.note/.test(mcpSrc))
check('DSH 面同样接了（两面不许各说各话）', /searchDetailed\(args\.query, k\)/.test(dshSrc) && /freshnessNote: freshness\.note/.test(dshSrc))

console.log(failures === 0 ? '\nPASS: memory_search 索引新鲜度契约（陈旧命中不许被当现状）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
