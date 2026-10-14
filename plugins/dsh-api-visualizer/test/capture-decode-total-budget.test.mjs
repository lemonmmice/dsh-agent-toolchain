// F02 回归：gzip 解压上限是**整条响应共享**一个预算，不是每个成员各一份；任何成员超限一律返回 null，
// 绝不返回只含前几个成员的"部分正文"（下游会把部分当完整用）。复刻审查 19b-delta-probes 的两个反例。
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { gzipSync, gunzipSync } from 'node:zlib'
import { syncBuiltinESMExports } from 'node:module'
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

// ---- 6. R5：合法多成员流，且后一个成员的 payload 内部**恰好含 1F 8B 08** —— 不得被当成员边界丢正文 ----
{
  // 第二个成员用存储块(level 0)，payload 里嵌入 gzip 魔数字节，复刻审查反例
  const binaryPayload = Buffer.concat([Buffer.from('second-member-'), Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from('-suffix')])
  const valid = Buffer.concat([gzipSync(Buffer.from('first-')), gzipSync(binaryPayload, { level: 0 })])
  const expected = gunzipSync(valid, { maxOutputLength: MAX_DECODE_BYTES })  // Node 真解码器能完整解出两成员
  const decoded = decodeContent(valid, 'gzip')
  check('★ 合法多成员(含 payload 内魔数) ⇒ 完整解出，不返回 null', decoded !== null && Buffer.compare(decoded, expected) === 0,
    decoded === null ? 'got null' : 'len ' + decoded.length + ' vs ' + expected.length)
}

// ---- 7. O1：整条解码因**超总预算**失败时，不再逐成员重复解压（已知超限的数据解一遍够了，结果仍是 null）----
{
  const original = zlib.gunzipSync
  const callArgs = []
  zlib.gunzipSync = function (...args) { callArgs.push({ inputBytes: args[0].length, maxOutputLength: args[1]?.maxOutputLength }); try { return original.apply(zlib, args) } catch (e) { e.__code = e.code; throw e } }
  syncBuiltinESMExports()
  let decoded
  try { decoded = decodeContent(Buffer.concat([gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x41)), gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x41))]), 'gzip') }
  finally { zlib.gunzipSync = original; syncBuiltinESMExports() }
  // 旧实现：整条试解(1) → 回退逐成员(2) ⇒ 3 次；O1 修后：整条试解抛 ERR_BUFFER_TOO_LARGE 即判不可解 ⇒ 1 次。
  check('★ 两个 6 MiB 成员超总预算 ⇒ 仍返回 null', decoded === null, decoded === null ? '' : 'got ' + decoded.length)
  check('★ O1：已知超限不重复解压（整条 gunzip 只调 1 次，不再逐成员）', callArgs.length === 1, callArgs.length + ' 次：' + JSON.stringify(callArgs))
}

// ---- 8. O1 回归护栏：**格式类**错误仍走成员切分回退（有效成员 + 尾部垃圾），不能被 O1 的早返回一并吞掉 ----
{
  const a = Buffer.from('alpha '.repeat(50))
  const b = Buffer.from('bravo '.repeat(50))
  const withTrailingJunk = Buffer.concat([gzipSync(a), gzipSync(b), Buffer.from([0x00, 0x01, 0x02])])
  const decoded = decodeContent(withTrailingJunk, 'gzip')
  // 整条 gunzip 对尾部垃圾抛的是格式类错误（非 ERR_BUFFER_TOO_LARGE）⇒ 必须回退成员切分、解出前两个成员。
  check('格式类错误（尾部垃圾）仍走成员回退 ⇒ 解出有效成员', decoded !== null && Buffer.compare(decoded, Buffer.concat([a, b])) === 0, decoded ? 'len ' + decoded.length : 'null')
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: capture decode total budget (shared budget across members, no silent partial, O1 no redundant decode)')
