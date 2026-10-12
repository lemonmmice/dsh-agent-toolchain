import assert from 'node:assert/strict'
import { attachBudget, estimateTokens } from './output-budget.mjs'

const machine = {
  state: 'failed',
  errorCode: 'BUILD_TIMEOUT',
  retryable: true,
  runId: 'run-123',
  jobId: 'job-123',
  evidenceRefs: ['run-run-123.json'],
  summary: 'build timed out',
  rows: Array.from({ length: 500 }, (_, index) => ({ index, text: 'detail-' + index })),
}

const result = attachBudget({
  isError: true,
  structuredContent: machine,
  content: [{ type: 'text', text: JSON.stringify(machine) }],
}, { maxTokens: 100 }, {})

const textEnvelope = JSON.parse(result.content[0].text)
assert.equal(textEnvelope.state, 'failed')
assert.equal(textEnvelope.errorCode, 'BUILD_TIMEOUT')
assert.equal(textEnvelope.retryable, true)
assert.equal(textEnvelope.runId, 'run-123')
assert.equal(textEnvelope.jobId, 'job-123')
assert.deepEqual(textEnvelope.evidenceRefs, ['run-run-123.json'])
assert.equal(textEnvelope.summary, 'build timed out')
assert.equal(textEnvelope.outputBudget.truncated, true)
assert.ok(estimateTokens(result.content[0].text) <= 100)

assert.equal(result.structuredContent.state, 'failed')
assert.equal(result.structuredContent.errorCode, 'BUILD_TIMEOUT')
assert.equal(result.structuredContent.runId, 'run-123')
assert.equal(result.structuredContent.jobId, 'job-123')
assert.equal(result.structuredContent.outputBudget.truncated, true)
assert.ok(estimateTokens(JSON.stringify(result.structuredContent)) <= 100)
assert.ok(!String(result.content[0].text).includes('detail-499'))
assert.ok(String(result.structuredContent.previewText).length > 0)

const unchanged = { structuredContent: { state: 'done', runId: 'r', value: 1 }, content: [{ type: 'text', text: 'short' }] }
const before = JSON.stringify(unchanged)
assert.equal(attachBudget(unchanged, { maxTokens: 100 }, {}), unchanged)
assert.equal(JSON.stringify(unchanged), before)

const jsonOnly = attachBudget({ content: [{ type: 'text', text: JSON.stringify(machine) }] }, { maxTokens: 160 }, {})
assert.equal(JSON.parse(jsonOnly.content[0].text).jobId, 'job-123')
assert.equal(JSON.parse(jsonOnly.content[0].text).state, 'failed')

const smallMachine = { state: 'done', runId: 'small', value: 1 }
const duplicateUnder = { structuredContent: smallMachine, content: [{ type: 'text', text: JSON.stringify(smallMachine) }] }
const duplicateBefore = JSON.stringify(duplicateUnder)
attachBudget(duplicateUnder, { maxTokens: 100 }, {})
assert.equal(JSON.stringify(duplicateUnder), duplicateBefore)

const structuredOnly = { structuredContent: machine }
assert.equal(attachBudget(structuredOnly, { maxTokens: 100 }, {}), structuredOnly)
assert.equal(structuredOnly.structuredContent.outputBudget?.truncated, true)
assert.equal(structuredOnly.structuredContent.jobId, 'job-123')
assert.ok(estimateTokens(JSON.stringify(structuredOnly.structuredContent)) <= 100)

console.log('PASS output-budget audit: machine fields and structuredContent survive truncation')
