import assert from 'node:assert/strict'
import { attachBudget, budgetText, estimateTokens } from './output-budget.mjs'

const sumTextTokens = result => result.content.filter(block => block?.type === 'text').reduce((sum, block) => sum + estimateTokens(block.text), 0)
const metadata = result => result.content.findLast(block => block?.type === 'text' && block.text.startsWith('[output-budget] '))
const isWellFormed = text => Array.from(text).every(character => character.length > 1 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff)
const jsonText = JSON.stringify({ ok: true, rows: Array.from({ length: 100 }, (_, index) => ({ index, text: 'entry-"\\\n' + index + '😀𠀀中文' })), complete: true })

const disabled = { content: [{ type: 'text', text: jsonText }, { type: 'text', text: 'x'.repeat(10000) }] }
const original = JSON.stringify(disabled)
assert.equal(attachBudget(disabled, {}, {}), disabled)
assert.equal(JSON.stringify(disabled), original)
const short = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }
assert.equal(attachBudget(short, { maxTokens: 100 }), short)
assert.equal(short.content.length, 2)

for (const texts of [
  ['short', 'x'.repeat(8000)],
  ['x'.repeat(8000), 'y'.repeat(8000)],
  ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(5000)],
  [jsonText, 'tail'.repeat(2000)],
]) {
  const result = attachBudget({ content: texts.map(text => ({ type: 'text', text })) }, { maxTokens: 120 })
  assert.ok(sumTextTokens(result) <= 120, JSON.stringify(result))
  assert.equal(result.content.filter(block => block.text.startsWith('[output-budget] ')).length, 1)
  const explanation = metadata(result).text
  const counts = explanation.match(/kept ~(\d+) of ~(\d+) tokens/)
  assert.equal(Number(counts[1]), sumTextTokens(result) - estimateTokens(explanation))
  assert.equal(Number(counts[2]), texts.reduce((sum, text) => sum + estimateTokens(text), 0))
  assert.match(explanation, /Excludes image, structuredContent and resource blocks/)
}

for (const json of [jsonText, JSON.stringify('😀𠀀"\\\n'.repeat(1000)), JSON.stringify(Array(1000).fill('中文'))]) {
  const result = attachBudget({ content: [{ type: 'text', text: json }] }, { maxTokens: 240 })
  const envelope = JSON.parse(result.content[0].text)
  assert.deepEqual(envelope.outputBudget, { truncated: true, originalFormat: 'json' })
  assert.equal(typeof envelope.previewText, 'string')
  assert.equal(Object.hasOwn(envelope, 'ok'), false)
  assert.equal(Object.hasOwn(envelope, 'complete'), false)
  assert.ok(sumTextTokens(result) <= 240)
  assert.ok(isWellFormed(envelope.previewText))
}

for (const budget of [1, 2, 10, 25, 45, 55, 65, 75, 85, 95, 100, 140, 300]) {
  for (const text of [jsonText, 'HEAD_' + '😀𠀀中文'.repeat(300) + '_TAIL']) {
    const result = attachBudget({ content: [{ type: 'text', text }] }, { maxTokens: budget })
    const returned = sumTextTokens(result)
    const explanation = metadata(result).text
    if (returned > budget) {
      const minimum = explanation.match(/Minimum envelope\/metadata overhead ~(\d+) tokens exceeds the requested budget/)
      assert.ok(minimum, JSON.stringify({ budget, returned, explanation }))
      assert.equal(Number(minimum[1]), returned)
    } else {
      assert.doesNotMatch(explanation, /exceeds the requested budget/)
    }
    for (const block of result.content) assert.ok(isWellFormed(block.text))
    if (text === jsonText) assert.equal(JSON.parse(result.content[0].text).outputBudget.truncated, true)
  }
}

const image = { type: 'image', data: 'image-data', mimeType: 'image/png' }
const resource = { type: 'resource', resource: { uri: 'memory://large', mimeType: 'text/plain', text: 'resource'.repeat(1000) } }
const resourceLink = { type: 'resource_link', uri: 'memory://source', name: 'source' }
const structuredContent = { raw: 'structured'.repeat(1000) }
const mixed = { isError: true, structuredContent, content: [{ type: 'text', text: jsonText }, image, resource, { type: 'text', text: 'later'.repeat(1000) }, resourceLink] }
const mixedResult = attachBudget(mixed, { maxTokens: 130 })
assert.equal(mixedResult, mixed)
assert.equal(mixedResult.isError, true)
assert.equal(mixedResult.structuredContent, structuredContent)
assert.equal(mixedResult.content.find(block => block.type === 'image'), image)
assert.equal(mixedResult.content.find(block => block.type === 'resource'), resource)
assert.equal(mixedResult.content.find(block => block.type === 'resource_link'), resourceLink)
assert.ok(sumTextTokens(mixedResult) <= 130)
assert.ok(estimateTokens(JSON.stringify(mixedResult)) > 130)

const repeatedBlock = { type: 'text', text: 'z'.repeat(8000) }
const repeated = attachBudget({ content: [repeatedBlock, repeatedBlock] }, { maxTokens: 100 })
assert.ok(sumTextTokens(repeated) <= 100)
assert.equal(repeatedBlock.text.length, 8000)
assert.equal(Number(metadata(repeated).text.match(/omitted (\d+) text blocks/)[1]), 2 - (repeated.content.length - 1))

for (const budget of [50, 90, 200]) {
  const text = 'HEAD_' + '😀𠀀中文'.repeat(1000) + '_TAIL'
  const result = budgetText(text, budget)
  assert.equal(result.truncated, true)
  assert.ok(result.keptTokens <= budget)
  assert.ok(isWellFormed(result.text))
  assert.ok(result.text.startsWith('HEAD_'))
  assert.ok(result.text.endsWith('_TAIL'))
  assert.equal(result.originalChars, text.length)
  assert.equal(result.keptChars, result.text.length)
}
console.log('PASS shared output budget: valid JSON envelopes, all-text accounting, Unicode, tiny-budget disclosure and unchanged non-text content')
