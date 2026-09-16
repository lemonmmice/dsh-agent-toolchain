// W2（第二块）输出预算信封单测。离线、无依赖，直接跑：node lib/output-budget.test.mjs
import { estimateTokens, outputMaxTokens, budgetText, attachBudget, makeOutputBudget } from './output-budget.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ---------------------------------------------------------------- estimateTokens
check('空/undefined → 0', estimateTokens('') === 0 && estimateTokens(undefined) === 0 && estimateTokens(null) === 0)
check('ASCII ≈ 1 token / 4 字符', estimateTokens('abcdefgh') === 2, String(estimateTokens('abcdefgh')))
check('CJK 每字 ≈ 1 token', estimateTokens('中文测试串') === 5, String(estimateTokens('中文测试串')))
check('全角/标点算 CJK', estimateTokens('（）') === 2, String(estimateTokens('（）')))
check('混排相加', estimateTokens('ab中文cd') === 2 + Math.ceil(4 / 4), String(estimateTokens('ab中文cd')))
check('CJK 扩展 B（surrogate）也按 1', estimateTokens('\u{20000}\u{20001}') === 2, String(estimateTokens('\u{20000}\u{20001}')))

// ---------------------------------------------------------------- outputMaxTokens
check('默认关（未设 env）', outputMaxTokens({}, {}) === 0)
check('读 env DSH_OUTPUT_MAX_TOKENS', outputMaxTokens({}, { DSH_OUTPUT_MAX_TOKENS: '1500' }) === 1500)
check('opts.maxTokens 显式优先', outputMaxTokens({ maxTokens: 200 }, { DSH_OUTPUT_MAX_TOKENS: '1500' }) === 200)
check('非法/<=0 → 0（关）', outputMaxTokens({}, { DSH_OUTPUT_MAX_TOKENS: '-5' }) === 0 && outputMaxTokens({}, { DSH_OUTPUT_MAX_TOKENS: 'x' }) === 0)

// ---------------------------------------------------------------- budgetText
{
  const small = budgetText('hello world', 1000)
  check('未超预算 → 原样、truncated:false', small.truncated === false && small.text === 'hello world')
  check('未超预算 originalTokens 也照报', small.originalTokens === estimateTokens('hello world'))

  const big = 'HEAD_' + 'x'.repeat(8000) + '_TAIL'   // 头尾放哨兵，验证保头+保尾（尾巴=结论）
  const r = budgetText(big, 100)
  check('超预算 → truncated:true', r.truncated === true)
  check('截后 keptTokens ≤ 预算', r.keptTokens <= 100, 'kept=' + r.keptTokens)
  check('保头：截后仍以原文开头', r.text.startsWith('HEAD_'), r.text.slice(0, 24))
  check('★ 保尾：截后仍以原文结尾（旧实现只保头会丢掉尾巴）', r.text.endsWith('_TAIL'), r.text.slice(-24))
  check('中间有省略标记且确实截短了', /truncated/.test(r.text) && r.text.length < big.length, String(r.text.length))
  check('originalTokens 反映截断前全量', r.originalTokens === estimateTokens(big), String(r.originalTokens))
  check('originalChars/keptChars 自洽', r.originalChars === big.length && r.keptChars === r.text.length)

  const cjkSrc = '头' + '测'.repeat(1000) + '尾'    // 1002 tokens → 截到 ≤50
  const cjk = budgetText(cjkSrc, 50)
  check('CJK 文本也能收敛到预算内', cjk.truncated === true && cjk.keptTokens <= 50, 'kept=' + cjk.keptTokens)
  check('CJK 保头+保尾', cjk.text.startsWith('头') && cjk.text.endsWith('尾'), cjk.text)

  const zero = budgetText('anything', 0)
  check('预算 0 = 不截', zero.truncated === false && zero.text === 'anything')
}

// ---------------------------------------------------------------- attachBudget
{
  const mk = () => ({ content: [{ type: 'text', text: 'y'.repeat(8000) }] })

  const off = attachBudget(mk(), {}, {})
  check('默认关：内容原样、不加说明块', off.content.length === 1 && off.content[0].text.length === 8000)

  const on = attachBudget(mk(), { maxTokens: 100 }, {})
  check('开启：第一个文本块被截短', on.content[0].text.length < 8000)
  check('开启：追加了 output-budget 说明块', on.content.length === 2 && /output-budget/.test(on.content[1].text))
  check('说明块带 originalTokenCount 语义（kept ... of ... tokens）', /kept ~\d+ of ~\d+ tokens/.test(on.content[1].text), on.content[1].text)

  // W5 图像块必须原样保留
  const withImg = { content: [{ type: 'text', text: 'z'.repeat(8000) }, { type: 'image', data: 'BASE64', mimeType: 'image/png' }] }
  const r = attachBudget(withImg, { maxTokens: 100 }, {})
  const img = r.content.find((b) => b.type === 'image')
  check('image 块原样保留（W5 不受影响）', Boolean(img) && img.data === 'BASE64')
  check('截断说明块追加在末尾', r.content[r.content.length - 1].type === 'text' && /output-budget/.test(r.content[r.content.length - 1].text))

  const under = attachBudget({ content: [{ type: 'text', text: 'short' }] }, { maxTokens: 100 }, {})
  check('开启但未超预算：不加说明块', under.content.length === 1 && under.content[0].text === 'short')

  // 永不抛
  let threw = false
  try { attachBudget(null, { maxTokens: 100 }); attachBudget({}, { maxTokens: 100 }); attachBudget({ content: 'nope' }, { maxTokens: 100 }) } catch { threw = true }
  check('畸形输入不抛、原样返回', threw === false)
}

// ---------------------------------------------------------------- makeOutputBudget（server.tool 包装）
{
  const disabled = makeOutputBudget({})
  const h = async () => ({ content: [{ type: 'text', text: 'w'.repeat(8000) }] })
  check('关：wrap 返回原 handler 本身（恒等、零开销）', disabled.enabled === false && disabled.wrap('t', h) === h)

  const enabled = makeOutputBudget({ maxTokens: 100 })
  const wrapped = enabled.wrap('t', h)
  check('开：wrap 换了新函数', enabled.enabled === true && wrapped !== h)
  const out = await wrapped({ runId: 'r1' })
  check('开：包装后的返回被截 + 加说明块', out.content[0].text.length < 8000 && out.content.length === 2 && /output-budget/.test(out.content[1].text))
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('\nPASS: output-budget (all checks)')
