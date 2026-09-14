// dsh-build 单测：`build_errors` 的渲染（F-059，被载荷探针抓出来的）。
//
// 病（2026-09-14）：工具**名字**和**描述**都写着"从最近一次构建日志重新解析错误/警告列表
// （结构化 file/line/col/code/message）"，`execute()` 返回里也**确实**带着那些条目 ——
// 而渲染层只印了一行**计数**：
//     「2 错误 / 15 警告（日志 C:\…）」
// ⇒ 描述承诺的东西 agent 一个字都看不到。实况代价：`build_status` 说「失败(2 错误)」，
//   两条错误**是什么**在 DSH 面**一个工具都读不到**（`build_run` 那份只在**当场失败**时印）。
//   这与 F-052（`memory_search` 只印"找到 N 条"）是同一个病。
// 渲染已挪到 lib/render.mjs 的 `renderErrors`（可测）。
import { renderErrors } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ---------------------------------------------------------------- 1. 条目必须印出来
{
  const v = {
    hasRun: true, logPath: 'C:\\logs\\b.log',
    errors: [
      { file: 'A.cs', line: 12, col: 3, code: 'CS1002', message: '应输入 ;' },
      { file: 'B.cs', line: 7, col: 1, code: 'CS0103', message: '当前上下文中不存在名称"Foo"' },
    ],
    warnings: [{ file: 'C.cs', line: 1, col: 1, code: 'CS0168', message: '声明了变量但从未使用' }],
  }
  const t = renderErrors(v)
  check('★ 计数与日志路径保留（旧行为不许丢）', /2 错误 \/ 1 警告/.test(t) && /C:\\logs\\b\.log/.test(t), t.slice(0, 200))
  check('★★ 错误条目**印出来了**（file(line,col): code: message）',
    /A\.cs\(12,3\): CS1002: 应输入 ;/.test(t) && /B\.cs\(7,1\): CS0103:/.test(t), t.slice(0, 400))
  check('★ 有错误时**不**把警告条目也堆上来（噪音），但要说清还有多少条',
    !/C\.cs\(1,1\)/.test(t) && /另有 1 条警告未列出/.test(t), t.slice(0, 400))
}

// ---------------------------------------------------------------- 2. 只有警告时列警告
{
  const t = renderErrors({ hasRun: true, logPath: 'L.log', errors: [], warnings: [{ file: 'W.cs', line: 3, col: 2, code: 'CS0168', message: '未使用' }] })
  check('★ 没有错误时列出警告', /W\.cs\(3,2\): CS0168: 未使用/.test(t), t.slice(0, 300))
}

// ---------------------------------------------------------------- 3. 截断必须说出来
{
  const many = renderErrors({
    hasRun: true, logPath: 'L.log',
    errors: Array.from({ length: 33 }, (_, i) => ({ file: 'F' + i + '.cs', line: i, col: 1, code: 'CS1', message: 'm' + i })),
    warnings: [],
  })
  check('★ 错误多于 10 条时**截断并说出总数**（不许默默只给前 10 条）',
    (many.match(/F\d+\.cs\(/g) || []).length === 10 && /共 33 条/.test(many), many.slice(-260))
  const three = renderErrors({ hasRun: true, logPath: 'L.log', errors: [], warnings: Array.from({ length: 9 }, (_, i) => ({ file: 'W' + i + '.cs', line: i, col: 1, code: 'CS1', message: 'm' })) })
  check('★ 警告多于 5 条时同样截断并说出总数',
    (three.match(/W\d+\.cs\(/g) || []).length === 5 && /共 9 条/.test(three), three.slice(-240))
}

// ---------------------------------------------------------------- 4. 没有条目 & 没跑过
{
  const empty = renderErrors({ hasRun: true, logPath: 'L.log', errors: [], warnings: [] })
  check('★ 解析不出条目时**明说"空 ≠ 没有错误"**（这是工具描述里的原话，必须出现在渲染里）',
    /0 错误 \/ 0 警告/.test(empty) && /空 ≠ 没有错误/.test(empty), empty.slice(0, 260))
  check('没跑过时说"没有构建记录"', renderErrors({ hasRun: false }) === '没有构建记录', renderErrors({ hasRun: false }))
}

// ---------------------------------------------------------------- 5. 形状残缺不炸
{
  const cases = [null, undefined, {}, { hasRun: true }, { hasRun: true, errors: [null, 'raw', 42], warnings: 'nope' }, { hasRun: true, errors: {} }]
  let threw = null
  for (const c of cases) {
    try {
      const t = renderErrors(c)
      if (typeof t !== 'string' || t === '') { threw = '返回了空/非串 @ ' + JSON.stringify(c); break }
    } catch (e) { threw = (e && e.message ? e.message : String(e)) + ' @ ' + JSON.stringify(c); break }
  }
  check('★ 残缺形状（null / 字符串条目 / errors 不是数组）都不抛，且仍返回非空文本', threw === null, String(threw))
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-build build_errors 渲染（F-059：算出来了就要印出来）')
process.exit(failures ? 1 : 0)
