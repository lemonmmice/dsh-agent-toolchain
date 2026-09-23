// 文档里的工具数守卫（离线、无依赖：node lib/tool-count-docs.test.mjs）
//
// 为什么要有它：`ui_jev` 落地后，注册表变成 55 个工具，而 README / docs/tools.md / docs/prior-art.md
// 六处还写着 54 —— **而且 docs/tools.md 里根本没有 ui_jev 那一行**（新工具进了注册表、没进清单）。
// 这类漂移靠"记得改"是治不住的：注册表是唯一的真相源，文档是它的投影，投影就得有守卫。
//
// 断言分两类：
//   ① 计数一致：README / tools.md / prior-art.md 里写的数字 == 注册表实际条数（含只读数）；
//   ② **集合一致**（更强的一条）：注册表里每个工具在 tools.md 里都有自己那一行，
//      反过来 tools.md 也不能出现注册表里没有的名字 —— 计数对得上但漏了一个、多了一个，②会抓到。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY, isReadOnly } from './tool-registry.mjs'

// DSH_DOCS_ROOT 只为一件事存在：**反向自证** —— 拿一份故意改坏的文档副本跑一遍，
// 证明这个测试真的会红（一个永远不会红的守卫等于没有守卫）。默认跑真仓库。
const root = process.env.DSH_DOCS_ROOT || join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const names = Object.keys(REGISTRY)
const total = names.length
const readOnly = names.filter((n) => isReadOnly(n)).length

const readme = read('README.md')
const tools = read('docs/tools.md')
const priorArt = read('docs/prior-art.md')

// ---- ① 计数一致
const readmeHeading = readme.match(/## Tools — (\d+), of which (\d+) are read-only/)
check('README 有 "Tools — N, of which M are read-only" 标题', readmeHeading !== null)
if (readmeHeading) {
  check(`README 的工具数与注册表一致（${total}）`, Number(readmeHeading[1]) === total, `README=${readmeHeading[1]} 注册表=${total}`)
  check(`README 的只读数与注册表一致（${readOnly}）`, Number(readmeHeading[2]) === readOnly, `README=${readmeHeading[2]} 注册表=${readOnly}`)
}

const toolsHeading = tools.match(/(\d+) tools, all generated from/)
check('docs/tools.md 有 "N tools, all generated from" 说明', toolsHeading !== null)
if (toolsHeading) check(`tools.md 的工具数与注册表一致（${total}）`, Number(toolsHeading[1]) === total, `tools.md=${toolsHeading[1]} 注册表=${total}`)

const readmeIndex = readme.match(/All (\d+) tools, one line each/)
check('README 的文档索引里写着工具总数', readmeIndex !== null)
if (readmeIndex) check(`README 索引里的工具数与注册表一致（${total}）`, Number(readmeIndex[1]) === total, `README=${readmeIndex[1]} 注册表=${total}`)

for (const [label, re] of [['prior-art.md 的共享注册表那一行', /`lib\/tool-registry\.mjs` \((\d+) tools;/],
  ['prior-art.md 的"不做 tool_search"那一行', /this tool set is (\d+) tools shown in full/]]) {
  const m = priorArt.match(re)
  check(`${label}有工具数`, m !== null)
  if (m) check(`${label}与注册表一致（${total}）`, Number(m[1]) === total, `文中=${m[1]} 注册表=${total}`)
}

// ---- ② 集合一致（真正能抓到"漏了一行"的那条）
const documented = [...tools.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1])
const documentedSet = new Set(documented)
const missing = names.filter((n) => !documentedSet.has(n))
const extra = [...documentedSet].filter((n) => !Object.hasOwn(REGISTRY, n))
check('docs/tools.md 里每个工具都只出现一行（没有重复行）', documented.length === documentedSet.size,
  `行数=${documented.length} 去重=${documentedSet.size}`)
check('注册表里的每个工具在 docs/tools.md 都有自己的行', missing.length === 0, `缺=${JSON.stringify(missing)}`)
check('docs/tools.md 不出现注册表里没有的工具名', extra.length === 0, `多=${JSON.stringify(extra)}`)
check(`docs/tools.md 的行数等于工具数（${total}）`, documented.length === total, `行数=${documented.length} 注册表=${total}`)

// ---- ③ 只读标记与文档一致：Read 行 / Write 行的划分必须与注册表相同
const mismarked = []
for (const m of tools.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*(Read|Write)\s*\|/gm)) {
  const [, tool, mark] = m
  if (!Object.hasOwn(REGISTRY, tool)) continue
  if (isReadOnly(tool) !== (mark === 'Read')) mismarked.push(`${tool}: 文档=${mark} 注册表=${isReadOnly(tool) ? 'Read' : 'Write'}`)
}
check('docs/tools.md 的 Read/Write 划分与注册表一致', mismarked.length === 0, mismarked.join('; '))

console.log(failures === 0 ? '\nPASS: 文档里的工具数与注册表一致（含逐工具行）' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
