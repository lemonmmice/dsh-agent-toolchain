// F02 回归：gzip 解压上限是**整条响应共享**一个预算，不是每个成员各一份；任何成员超限一律返回 null，
// 绝不返回只含前几个成员的"部分正文"（下游会把部分当完整用）。复刻审查 19b-delta-probes 的两个反例。
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { decodeContent, MAX_DECODE_BYTES } from '../lib/capture-engine.mjs'

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }

// ---- 1. 两个 6 MiB 成员合计 12 MiB > 8 MiB 上限：旧实现逐成员各给 8 MiB、concat 后返回 12 MiB（超限）----
{
  const member = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x41))
  const two = Buffer.concat([member, member])
  const decoded = decodeContent(two, 'gzip')
  check('★ 多成员合计超限 ⇒ null（不返回 12 MiB）', decoded === null, decoded === null ? '' : 'got ' + decoded.length + ' bytes')
}

// ---- 2. 正常 prefix 成员 + 超限成员：旧实现静默丢掉超限成员、只返回 6 字节 'prefix'（部分当完整）----
{
  const late = Buffer.concat([gzipSync(Buffer.from('prefix')), gzipSync(Buffer.alloc(MAX_DECODE_BYTES + 1, 0x41))])
  const decoded = decodeContent(late, 'gzip')
  check('★ 后续成员超限 ⇒ null（不返回只含前缀的部分正文）', decoded === null, decoded === null ? '' : JSON.stringify(decoded.toString().slice(0, 16)))
}

// ---- 3. 两个正常小成员：仍要正确拼接解出全部内容 ----
{
  const a = Buffer.from('alpha '.repeat(100))
  const b = Buffer.from('bravo '.repeat(100))
  const two = Buffer.concat([gzipSync(a), gzipSync(b)])
  const decoded = decodeContent(two, 'gzip')
  check('多个正常小成员 ⇒ 正确拼接解出', decoded !== null && Buffer.compare(decoded, Buffer.concat([a, b])) === 0, decoded ? 'len ' + decoded.length : 'null')
}

// ---- 4. 合计刚好贴着上限内：仍应完整解出（不误杀）----
{
  const half = gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x42))
  const two = Buffer.concat([half, half])          // 6 MiB < 8 MiB
  const decoded = decodeContent(two, 'gzip')
  check('合计在上限内 ⇒ 完整解出（6 MiB）', decoded !== null && decoded.length === 6 * 1024 * 1024, decoded ? String(decoded.length) : 'null')
}

// ---- 5. 单成员解压炸弹仍被拦（沿用既有契约）----
{
  const bomb = gzipSync(Buffer.alloc(MAX_DECODE_BYTES + 2 * 1024 * 1024, 0x41))
  check('单成员炸弹 ⇒ null', decodeContent(bomb, 'gzip') === null)
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: capture decode total budget (shared budget across members, no silent partial)')
