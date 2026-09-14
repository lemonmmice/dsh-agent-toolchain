// `perf_heap` 的口径契约（2026-09-12「用户可见结论的最坏情况」主题）。
//
// 病：工具描述写的是"两次 dump 对比同一类型的对象数增长即泄漏嫌疑"，但**输出里没有任何一句**提醒
// "这是单次快照" —— agent 拿到一份干净的 Top N，很容易直接下结论"没有泄漏"，
// 而内存泄漏的定义恰恰要求**跨时间比较**。另外 `top` 是按 topN 截断的，
// "没列出的类型"也容易被读成"不存在"。
//
// 真机已验证（真 211MB dump）：scopeNote 会给出真实数字 ——
// 「本次只列了 5 个类型（堆内共 80578 个对象 / 4.1MB），列表已按 topN 截断 —— 没列出的类型不代表不存在。
//   单次快照无法判定"有没有内存泄漏"…」
// 本测试把这条契约钉在源码上（运行真 dump 需要大文件，不适合放进常规套件）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'perf.mjs'), 'utf8')

check('heapStats 标记 snapshot=true（调用方据此知道这是快照而非对比）', /snapshot: true/.test(src))
check('★ 明确写出"单次快照无法判定有没有内存泄漏"', /单次快照无法判定/.test(src))
check('★ 明确写出"count/sizeBytes 大 ≠ 泄漏"', /不等于泄漏/.test(src))
check('★ 明确写出截断语义（没列出的类型不代表不存在）', /没列出的类型不代表不存在/.test(src))
check('给出跨时间对比的做法（compareHint）', /compareHint:/.test(src) && /再抓一份/.test(src))
check('列出的类型数取自真实字段 top（不是猜的 items）', /Array\.isArray\(data\.top\)/.test(src), '字段名猜错会让提示里的数字变成 0（我第一版就是这样）')
check('截断判定用 topN 的真实上下界（5..100，与传给 DumpStack 的一致）', /Math\.min\(Math\.max\(topN \|\| 30, 5\), 100\)/.test(src))

console.log(failures === 0 ? '\nPASS: perf_heap 口径契约（单次快照 ≠ 泄漏结论；截断 ≠ 不存在）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
