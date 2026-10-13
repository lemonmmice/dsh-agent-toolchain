// 分析缓存键：相同输入 → 同键；任一维度变化 → 不同键；参数顺序无关；缺维度用 'none' 占位不与"有值"混淆。
import assert from 'node:assert/strict'
import { analysisCacheKey, sameAnalysisInputs } from './analysis-cache-key.mjs'

const base = { kind: 'etl-jit', inputDigest: 'sha-abc', toolVersion: '0.2.0', pid: 1234, provider: 'clr', symbolStrategy: 'offline', params: { maxXmlMb: 64 } }

const k1 = analysisCacheKey(base)
const k2 = analysisCacheKey({ ...base })
assert.equal(k1.key, k2.key, '相同输入 → 同键')
assert.ok(sameAnalysisInputs(k1, k2))

// 任一维度变化 → 不同键
for (const [field, val] of [['inputDigest', 'sha-xyz'], ['toolVersion', '0.3.0'], ['pid', 9999], ['provider', 'kernel'], ['symbolStrategy', 'srv*'], ['jitData', 'present'], ['processFilter', 'Ntrade']]) {
  assert.notEqual(analysisCacheKey({ ...base, [field]: val }).key, k1.key, `${field} 变化应改变键`)
}

// 参数顺序无关（稳定序列化），参数值变化则改变键
assert.equal(
  analysisCacheKey({ ...base, params: { a: 1, b: 2 } }).key,
  analysisCacheKey({ ...base, params: { b: 2, a: 1 } }).key,
  '参数顺序无关',
)
assert.notEqual(analysisCacheKey({ ...base, params: { maxXmlMb: 128 } }).key, k1.key, '参数值变化应改变键')

// 审计「路径相同不意味证据相同」：某维度缺失（undefined）≠ 该维度有值
assert.notEqual(analysisCacheKey({ ...base, provider: undefined }).key, k1.key, 'provider 缺失 ≠ provider=clr')
assert.ok(!sameAnalysisInputs(k1, analysisCacheKey({ ...base, provider: undefined })))

console.log('PASS: analysis cache key (stable, dimension-sensitive, order-independent params, none-placeholder)')
