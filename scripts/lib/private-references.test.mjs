import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPrivateReferenceScanner, PRIVATE_REFERENCES } from './private-references.mjs'

const terms = ['PrivateClient', '内部产品', 'fixture-user', 'Z:\\']
const references = terms.map((term) => [term.length, createHash('sha256').update(term.toLowerCase()).digest('hex')])
const scan = createPrivateReferenceScanner(references)
for (const term of terms) {
  assert.equal(scan(term), true)
  assert.equal(scan((term.includes(':') ? 'before ' : 'before') + term.toUpperCase() + 'after'), true)
  assert.equal(scan(term.toLowerCase()), true)
}
assert.equal(scan('safe public fixture'), false)
assert.equal(scan('safe public fixture'), false)
assert.equal(scan('Private Client'), false)
assert.equal(scan('fixture user'), false)
assert.equal(scan('Z:/'), false)
assert.equal(scan('fizz:\\s*'), false)
assert.equal(createPrivateReferenceScanner()('name:\\s*'), false)
assert.equal(PRIVATE_REFERENCES.length, 15)
assert.ok(PRIVATE_REFERENCES.every(([length, digest]) => Number.isInteger(length) && length > 0 && /^[0-9a-f]{64}$/.test(digest)))
console.log('PASS private references: case-insensitive substrings, Unicode, paths and cached results')
