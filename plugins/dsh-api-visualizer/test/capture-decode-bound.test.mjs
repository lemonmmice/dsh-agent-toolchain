// capture 正文解压的背压（解压炸弹防护）：高压缩比输入解出超过 MAX_DECODE_BYTES 时，
// zlib 在解压过程中被 maxOutputLength 拦截并抛错 → decodeContent 返回 null（不先解出巨量再检查），
// 正常体积的 gzip/deflate/br 仍完整解压。
import assert from 'node:assert/strict'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { decodeContent, MAX_DECODE_BYTES } from '../lib/capture-engine.mjs'

// 正常小体：三种编码都能正常解压还原
const small = Buffer.from('hello world '.repeat(200), 'utf8')
assert.deepEqual(decodeContent(gzipSync(small), 'gzip'), small)
assert.deepEqual(decodeContent(deflateSync(small), 'deflate'), small)
assert.deepEqual(decodeContent(brotliCompressSync(small), 'br'), small)

// 非压缩直通
assert.deepEqual(decodeContent(small, ''), small)
assert.deepEqual(decodeContent(small, 'identity'), small)

// 解压炸弹：可压缩数据体积远超上限 → 压缩体很小 → 解压应被拦截返回 null
const bombPlain = Buffer.alloc(MAX_DECODE_BYTES + 2 * 1024 * 1024, 0x41)
const gzBomb = gzipSync(bombPlain)
assert.ok(gzBomb.length < 512 * 1024, '高压缩比：压缩体应远小于解压结果')
assert.equal(decodeContent(gzBomb, 'gzip'), null, 'gzip 解压超上限应返回 null')
assert.equal(decodeContent(deflateSync(bombPlain), 'deflate'), null, 'deflate 解压超上限应返回 null')
assert.equal(decodeContent(brotliCompressSync(bombPlain), 'br'), null, 'br 解压超上限应返回 null')

console.log('PASS: capture decode bounded (zip-bomb guard), normal gzip/deflate/br intact')
