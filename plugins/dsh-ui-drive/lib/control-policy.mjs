import { readFileSync } from 'node:fs'
import { envOr } from '../../../lib/env-fallback.mjs'

export const CONTROL_EFFECTS = new Set(['click', 'doubleclick', 'key', 'type', 'setvalue', 'clickat', 'drag', 'scroll', 'move', 'wheel', 'pattern', 'focus', 'invoke', 'toggle', 'select', 'expand', 'collapse', 'increment', 'decrement', 'selecttext', 'window'])

export function matchesControlRule(rule, target) {
  if (!rule.actions.includes(target.action)) return false
  return ['name', 'aid', 'container'].every((field) => rule[field] == null || new RegExp(rule[field]).test(String(target[field] ?? '')))
}

export function compileControlPolicy(document) {
  try {
    if (!document || document.version !== 1 || !Array.isArray(document.rules)) throw new Error('expected version 1 and rules array')
    const ids = new Set()
    const examples = []
    for (const rule of document.rules) {
      if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)) throw new Error('rule id must be unique and nonempty')
      ids.add(rule.id)
      if (rule.effect !== 'deny' || !Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.some((action) => !CONTROL_EFFECTS.has(action))) throw new Error(rule.id + ': invalid effect/actions')
      if (!['name', 'aid', 'container'].some((field) => typeof rule[field] === 'string' && rule[field])) throw new Error(rule.id + ': at least one target pattern is required')
      for (const field of ['name', 'aid', 'container']) {
        if (rule[field] != null) {
          if (typeof rule[field] !== 'string') throw new Error(rule.id + ': ' + field + ' must be a regex string')
          new RegExp(rule[field])
        }
      }
      if (typeof rule.reason !== 'string' || !rule.reason || typeof rule.alternative !== 'string' || !rule.alternative) throw new Error(rule.id + ': reason and alternative are required')
      if (!rule.examples || !Array.isArray(rule.examples.match) || !Array.isArray(rule.examples.not_match)) throw new Error(rule.id + ': match/not_match examples are required')
      for (const [kind, expected] of [['match', true], ['not_match', false]]) {
        for (const [index, target] of rule.examples[kind].entries()) {
          if (!target || typeof target.action !== 'string') throw new Error(rule.id + ': ' + kind + '[' + index + '] has no action')
          const actual = matchesControlRule(rule, target)
          examples.push({ ruleId: rule.id, kind, index, passed: actual === expected })
          if (actual !== expected) throw new Error(rule.id + ': ' + kind + '[' + index + '] did not satisfy the example')
        }
      }
    }
    return { state: 'loaded', valid: true, count: document.rules.length, rules: document.rules, examples }
  } catch (error) {
    return { state: 'invalid', valid: false, count: 0, rules: [], error: error.message, policyCode: 'control_policy_invalid' }
  }
}

export function loadControlPolicy(file = envOr('DSH_UI_CONTROL_POLICY')) {
  if (!file) return { state: 'unconfigured', valid: true, count: 0, rules: [] }
  try { return compileControlPolicy(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))) }
  catch (error) { return { state: 'invalid', valid: false, count: 0, rules: [], error: error.message, policyCode: 'control_policy_invalid' } }
}

export function controlDecision(policy, target) {
  if (!CONTROL_EFFECTS.has(target.action)) return { ok: true }
  if (!policy.valid) return { ok: false, policyCode: 'control_policy_invalid', error: policy.error }
  if (['clickat', 'drag', 'move'].includes(target.action)) return { ok: true }
  const rule = policy.rules.find((entry) => matchesControlRule(entry, target))
  return rule ? { ok: false, policyCode: 'control_denied', ruleId: rule.id, reason: rule.reason, alternative: rule.alternative, error: rule.reason } : { ok: true }
}

export function controlPolicyStatus(policy = loadControlPolicy()) {
  return { state: policy.state, count: policy.count, ...(policy.error ? { error: policy.error } : {}) }
}
