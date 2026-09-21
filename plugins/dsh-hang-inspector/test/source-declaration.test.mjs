import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { extractMethod } from '../lib/hang.mjs'

const moduleUrl = new URL('../lib/hang.mjs', import.meta.url).href
const source = 'class Demo {\n  void Caller() { Target(); }\n  void Target() { var value = 1; }\n}'
const childScript = `import { extractMethod } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(extractMethod(${JSON.stringify(source)}, 'Target')))`
const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
  encoding: 'utf8', windowsHide: true, timeout: 2000, env: { ...process.env, DSH_NO_ENV_FALLBACK: '1' },
})
assert.equal(result.error, undefined, result.error?.message)
assert.equal(result.status, 0, result.stderr)
const mapped = JSON.parse(result.stdout)
assert.equal(mapped.suspectLine, 3)
assert.match(mapped.code, /void Target\(\)/)
assert.equal(extractMethod('class Demo { void Caller() { Target(); } }', 'Target'), null)
assert.equal(extractMethod('class Demo { void Target() { } }', 'Target').suspectLine, 1)
console.log('PASS source declaration lookup advances past earlier calls and terminates when no declaration exists')
