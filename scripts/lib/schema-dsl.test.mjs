// scripts/lib/schema-dsl.test.mjs — regression guard for the schema-DSL gate.
//
// The bug this exists for: `mods: { type: 'array', additionalItems: false }` in
// dsh-ui-drive passed every gate in this repo, shipped, and on restart the host
// died with `UNSUPPORTED_SCHEMA: parameters.mods.additionalItems is not
// supported by the value schema DSL` — then crash-looped, so the GUI never came
// up. The old guard was a single-line regex that only asked "does an object
// param say additionalProperties", which cannot see a wrong keyword in the
// first place and explicitly did not cover multi-line literals.
//
// These tests pin the whitelist, the recursion, and — just as important — that
// the validator stays silent on everything legal, because a gate that cries
// wolf gets switched off.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSchemas, KNOWN_KEYS } from './schema-dsl.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const uri = (s) => validateSchemas(s, { file: 'sample.js' })
// The validator is deliberately scoped to defineTool arguments, so most cases
// need a real (if minimal) tool around them.
const P = (inner) => `defineTool({\n  name: 'x',\n  parameters: {\n${inner}\n  },\n})`
const uv = (inner) => uri(P(inner))
const has = (inner, needle) => uv(inner).some((v) => v.message.includes(needle))
const paths = (inner) => uv(inner).map((v) => v.path)

// ---- the exact shape that crash-looped the host
{
  const src = P(`    action: { type: 'string', required: true },\n    mods: { type: 'array', additionalItems: false },`)
  const found = uri(src)
  check('array + additionalItems is rejected', found.length === 1 && found[0].path === 'parameters.mods.additionalItems', JSON.stringify(found.map((f) => f.path)))
  check('rejection names the offending keyword', found.length === 1 && found[0].message.includes('parameters.mods.additionalItems is not supported'), JSON.stringify(found.map((f) => f.message)))
  check('rejection reports the right line', found[0] && found[0].line === 5, found[0] && String(found[0].line))
  check('rejection advertises the real subset', found[0].message.includes('items/properties/required'))
}

// ---- whitelist, not denylist: other JSON-Schema habits must fail too
{
  for (const bad of [
    `    a: { type: 'array', minItems: 1 },`,
    `    a: { type: 'string', minLength: 2 },`,
    `    a: { type: 'string', pattern: '^x$' },`,
    `    a: { type: 'string', format: 'date' },`,
    `    a: { type: 'string', $ref: '#/defs/x' },`,
    `    a: { type: 'array', allOf: [{ type: 'string' }] },`,
    `    a: { type: 'array', uniqueItems: true },`,
  ]) check('unknown keyword rejected: ' + bad.trim().slice(0, 34), uv(bad).length === 1, JSON.stringify(uv(bad)))
  check('KNOWN_KEYS is the compiler subset', KNOWN_KEYS.includes('items') && KNOWN_KEYS.includes('additionalProperties') && !KNOWN_KEYS.includes('additionalItems'))

  // The compiler's switch ends in `default: authorError(...)`, so a node with
  // neither `type` nor `oneOf` crashes the host exactly like a bad keyword does.
  check('node without type and without oneOf rejected', has(`    a: { $ref: '#/defs/x' },`, 'or use oneOf'), JSON.stringify(uv(`    a: { $ref: '#/defs/x' },`)))
  check('unknown type name rejected', has(`    a: { type: 'date' },`, 'is not one of'))
}

// ---- object openness: the old guard's single rule, now covering multi-line
{
  check('object missing additionalProperties (single line) rejected', has(`    a: { type: 'object', description: 'x' },`, 'additionalProperties must be explicitly true or false'))
  const multi = P(`    a: {\n      type: 'object',\n      description: 'x',\n    },`)
  check('object missing additionalProperties (multi-line) rejected', uri(multi).some((v) => v.message.includes('additionalProperties must be explicitly true or false')), JSON.stringify(uri(multi)))
  check('object with additionalProperties: false is clean', uv(`    a: { type: 'object', additionalProperties: false },`).length === 0)
  check('object with additionalProperties: true is clean', uv(`    a: { type: 'object', additionalProperties: true },`).length === 0)
  check('non-boolean additionalProperties rejected', has(`    a: { type: 'object', additionalProperties: 'yes' },`, 'must be a boolean literal'))
}

// ---- recursion into properties / items / oneOf
{
  const inProps = `    a: { type: 'object', additionalProperties: true, properties: { b: { type: 'array', additionalItems: false } } },`
  check('recurses into properties', paths(inProps).includes('parameters.a.properties.b.additionalItems'), JSON.stringify(paths(inProps)))

  const inItems = `    a: { type: 'array', items: { type: 'object' } },`
  check('recurses into items', paths(inItems).includes('parameters.a.items'), JSON.stringify(paths(inItems)))

  const inOneOf = `    a: { oneOf: [{ type: 'string' }, { type: 'number', bogus: 1 }] },`
  check('recurses into oneOf branches', paths(inOneOf).includes('parameters.a.oneOf[1].bogus'), JSON.stringify(paths(inOneOf)))

  check('oneOf-only node is legal', uv(`    a: { oneOf: [{ type: 'string' }, { type: 'number' }] },`).length === 0)
  check('type together with oneOf rejected', has(`    a: { type: 'string', oneOf: [{ type: 'string' }] },`, 'cannot declare both type and oneOf'))
}

// ---- required is context-dependent: legal at property level, not in items
{
  check('required: true at parameters level is legal', uv(`    a: { type: 'string', required: true },`).length === 0)
  check('required: true inside items is rejected', has(`    a: { type: 'array', items: { type: 'string', required: true } },`, 'not supported by the value schema DSL'))
  check('required: false rejected', has(`    a: { type: 'string', required: false },`, 'must be true when present'))
  check('required: true nested in properties is legal', uv(`    a: { type: 'object', additionalProperties: true, properties: { b: { type: 'string', required: true } } },`).length === 0)
}

// ---- must stay silent on everything legal (a noisy gate gets disabled)
{
  const good = `defineTool({
  name: 'x',
  description: 'a tool',
  parameters: {
    action: { type: 'string', enum: ['a', 'b'], description: 'pick one' },
    count: { type: 'number', const: 3 },
    flag: { type: 'boolean' },
    nothing: { type: 'null' },
    loose: { type: 'json' },
    list: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', additionalProperties: true, properties: { inner: { type: 'string', required: true } } },
    waitFor: { type: 'object', additionalProperties: true, description: '先等条件成立：{ms?:5000, state?:"appear"|"gone"}' },
  },
  output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } } },
})`
  check('a fully legal tool is clean', uri(good).length === 0, JSON.stringify(uri(good)))
  check('braces inside a description do not derail the scan', uv(`    a: { type: 'object', additionalProperties: true, description: 'docs {x:{y:1}} here' },\n    b: { type: 'string' },`).length === 0)

  check('reference-valued parameters are skipped', uri(`defineTool({ name: 'x', parameters: SOME_SCHEMA })`).length === 0)
  check('a const-valued param node is skipped', uv(`    a: SOME_SCHEMA,`).length === 0)
  check('computed type is skipped rather than guessed', uv(`    a: { type: someVar, minLength: 1 },`).length === 0)
  check('spread node is skipped (inherited keys are unknowable)', uv(`    a: { ...OBJECT, description: '运行上下文' },`).length === 0)
  check('empty parameters object is clean', uv(`  `).length === 0)
}

// ---- the DSL governs defineTool arguments and nothing else
{
  check('a stray parameters object elsewhere is ignored', uri(`const q = { parameters: { limit: 10, offset: 20 } }`).length === 0)
  check('array-valued parameters are ignored', uri(`export default { parameters: [] }`).length === 0)
}

// ---- output schemas are compiled by the same DSL
{
  const badOutput = `defineTool({ name: 'x', output: { schema: { type: 'object', additionalProperties: true, properties: { a: { type: 'array', additionalItems: false } } } } })`
  check('bad key in a literal output schema rejected', uri(badOutput).some((v) => v.path === 'output.schema.properties.a.additionalItems'), JSON.stringify(uri(badOutput).map((v) => v.path)))
  check('const-valued output schema is skipped', uri(`defineTool({ name: 'x', output: { schema: OBJECT, render: () => [] } })`).length === 0)
}

// ---- the real repository must be clean, or the gate is already failing
{
  const repo = join(fileURLToPath(import.meta.url), '..', '..', '..')
  const offenders = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git') continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.js') || p.endsWith('.mjs')) {
        for (const v of validateSchemas(readFileSync(p, 'utf8'), { file: relative(repo, p) })) offenders.push(v.file + ':' + v.line + ' ' + v.message)
      }
    }
  }
  walk(join(repo, 'plugins'))
  check('every schema in plugins/ passes the DSL gate', offenders.length === 0, offenders.join(' | '))
}

console.log(failures === 0 ? '\nPASS: schema-dsl test' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
