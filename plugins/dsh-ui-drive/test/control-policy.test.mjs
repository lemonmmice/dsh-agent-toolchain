import assert from 'node:assert/strict'
import { compileControlPolicy, loadControlPolicy, controlDecision } from '../lib/control-policy.mjs'

const policy = loadControlPolicy(new URL('../../../samples/ui-control-policy.example.json', import.meta.url))
assert.equal(policy.valid, true)
assert.equal(policy.count, 1)
assert.equal(controlDecision(policy, { action: 'click', name: '买入' }).ruleId, 'no-order-submit')
assert.equal(controlDecision(policy, { action: 'click', name: '买入说明' }).ok, true)
assert.equal(controlDecision(policy, { action: 'read', name: '买入' }).ok, true)
assert.equal(controlDecision(policy, { action: 'clickat', name: '买入' }).ok, true)
const broken = structuredClone({ version: 1, rules: policy.rules })
broken.rules[0].examples.match[0].name = '买入说明'
const invalid = compileControlPolicy(broken)
assert.equal(invalid.valid, false)
assert.match(invalid.error, /no-order-submit.*match\[0\]/)
assert.equal(controlDecision(invalid, { action: 'clickat' }).policyCode, 'control_policy_invalid')
assert.equal(controlDecision(invalid, { action: 'read' }).ok, true)
assert.equal(loadControlPolicy('').state, 'unconfigured')
assert.equal(loadControlPolicy('missing-fixture-policy').state, 'invalid')
console.log('PASS control policy: examples, matching, coordinate limits and fail-closed invalid rules')
