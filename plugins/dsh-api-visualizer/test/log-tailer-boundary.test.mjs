import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LogTailer, MAX_TAIL_READ_BYTES, MAX_TAIL_LINE_BYTES } from '../lib/capture-engine.mjs'

const directory = mkdtempSync(join(tmpdir(), 'dsh-tail-boundary-'))
function drain(tailer) {
  const size = statSync(tailer.logPath).size
  for (let count = 0; tailer.offset < size && count < 1000; count++) {
    const before = tailer.offset
    tailer.pump()
    assert.ok(tailer.offset - before <= tailer.maxReadBytes)
    assert.ok(tailer.remainder.length <= tailer.maxLineBytes)
  }
  assert.equal(tailer.offset, size)
}

try {
  assert.equal(MAX_TAIL_READ_BYTES, 1024 * 1024)
  assert.ok(MAX_TAIL_LINE_BYTES > 2 * 2 * 1024 * 1024 * 6)
  const utfPath = join(directory, 'utf8.log')
  const original = '中文🙂\r\n第二行😀\n末尾汉字'
  writeFileSync(utfPath, original)
  const unicode = []
  const utf = new LogTailer({ logPath: utfPath, maxReadBytes: 2, maxLineBytes: 64, onChunk: chunk => unicode.push(chunk) })
  utf.pump()
  assert.equal(utf.status().dataComplete, false)
  assert.ok(utf.status().pendingBytes > 0)
  drain(utf)
  assert.equal(unicode.join(''), '中文🙂\r\n第二行😀\n')
  assert.equal(unicode.join('').includes('\ufffd'), false)
  assert.equal(utf.status().dataComplete, false)
  appendFileSync(utfPath, '\n')
  drain(utf)
  assert.equal(unicode.join(''), original + '\n')
  assert.equal(utf.status().dataComplete, true)
  assert.equal(utf.status().bufferedBytes, 0)

  const hugePath = join(directory, 'oversize.log')
  writeFileSync(hugePath, 'x'.repeat(19))
  const recovered = []
  const huge = new LogTailer({ logPath: hugePath, maxReadBytes: 3, maxLineBytes: 8, onChunk: chunk => recovered.push(chunk) })
  drain(huge)
  assert.equal(huge.remainder.length, 0)
  assert.equal(huge.status().discardingLine, true)
  assert.equal(huge.status().oversizedLines, 1)
  assert.equal(huge.status().droppedBytes, 19)
  assert.equal(huge.status().droppedChunks, 1)
  assert.equal(recovered.length, 0)
  appendFileSync(hugePath, 'tail\n正常\n')
  drain(huge)
  assert.equal(recovered.join(''), '正常\n')
  assert.equal(huge.status().droppedBytes, 24)
  assert.equal(huge.status().oversizedLines, 1)
  assert.equal(huge.status().discardingLine, false)
  assert.equal(huge.status().dataComplete, false)
  assert.match(huge.status().note, /超长行 1 条/)
  assert.match(huge.status().note, /没有入库/)

  const retryPath = join(directory, 'retry.log')
  writeFileSync(retryPath, '中a\n')
  let failures = 2
  const retried = []
  const retry = new LogTailer({ logPath: retryPath, maxReadBytes: 3, onChunk: chunk => { if (failures-- > 0) throw new Error('fixture parse failure'); retried.push(chunk) } })
  retry.pump()
  const pending = Buffer.from(retry.remainder)
  retry.pump()
  assert.equal(retry.offset, 3)
  assert.deepEqual(retry.remainder, pending)
  assert.equal(retry.droppedBytes, 0)
  drain(retry)
  assert.equal(retried.join(''), '中a\n')
  assert.equal(retry.status().dataComplete, true)

  const mixedPath = join(directory, 'mixed.log')
  writeFileSync(mixedPath, 'x'.repeat(12) + '\ngood\n')
  let mixedCalls = 0
  const mixed = new LogTailer({ logPath: mixedPath, maxReadBytes: 64, maxLineBytes: 8, onChunk: chunk => { assert.equal(chunk, 'good\n'); if (++mixedCalls < 3) throw new Error('fixture mixed failure') } })
  mixed.pump()
  assert.equal(mixed.offset, 0)
  assert.equal(mixed.droppedBytes, 0)
  drain(mixed)
  assert.equal(mixed.droppedBytes, 13)
  assert.equal(mixed.oversizedLines, 1)
  assert.equal(mixedCalls, 3)

  const permanentPath = join(directory, 'permanent.log')
  writeFileSync(permanentPath, '中文\n')
  let permanentFailure = true
  const permanent = new LogTailer({ logPath: permanentPath, maxReadBytes: 32, onChunk: () => { if (permanentFailure) throw new Error('fixture permanent failure') } })
  for (let count = 0; count < 8; count++) permanent.pump()
  assert.equal(permanent.droppedBytes, Buffer.byteLength('中文\n'))
  assert.equal(permanent.droppedChunks, 1)
  assert.equal(permanent.offset, statSync(permanentPath).size)
  permanentFailure = false
  appendFileSync(permanentPath, 'recovered\n')
  drain(permanent)
  assert.equal(permanent.status().dataComplete, false)

  writeFileSync(hugePath, 'new\n')
  huge.pump()
  drain(huge)
  assert.equal(huge.discardingLine, false)
  assert.equal(recovered.at(-1), 'new\n')
  assert.equal(huge.errors, 0)
  const exactPath = join(directory, 'exact-limit.log')
  writeFileSync(exactPath, '12345678\n')
  const exactLines = []
  const exact = new LogTailer({ logPath: exactPath, maxReadBytes: 2, maxLineBytes: 8, onChunk: chunk => exactLines.push(chunk) })
  drain(exact)
  assert.equal(exactLines.join(''), '12345678\n')
  assert.equal(exact.droppedBytes, 0)
  const emptyLinesPath = join(directory, 'many-empty-lines.log')
  writeFileSync(emptyLinesPath, '\n'.repeat(8192))
  let deliveredEmptyLines = ''
  const emptyLines = new LogTailer({ logPath: emptyLinesPath, onChunk: chunk => { deliveredEmptyLines += chunk } })
  const originalSubarray = Buffer.prototype.subarray
  let views = 0
  try {
    Buffer.prototype.subarray = function (...params) { views++; return originalSubarray.apply(this, params) }
    emptyLines.pump()
  } finally {
    Buffer.prototype.subarray = originalSubarray
  }
  assert.equal(deliveredEmptyLines, '\n'.repeat(8192))
  assert.ok(views < 8, 'empty-line burst should use a bounded number of Buffer views, got ' + views)
  assert.equal(emptyLines.status().dataComplete, true)
  const separatedPath = join(directory, 'separated-ranges.log')
  writeFileSync(separatedPath, 'one\n' + 'x'.repeat(12) + '\ntwo\n' + 'y'.repeat(13) + '\nthree\nrest')
  let separatedText = ''
  const separated = new LogTailer({ logPath: separatedPath, maxReadBytes: 128, maxLineBytes: 8, onChunk: chunk => { separatedText += chunk } })
  separated.pump()
  assert.equal(separatedText, 'one\ntwo\nthree\n')
  assert.equal(separated.remainder.toString('utf8'), 'rest')
  assert.equal(separated.droppedBytes, 27)
  assert.equal(separated.oversizedLines, 2)
  const legalPath = join(directory, 'max-escaped-bodies.jsonl')
  const body = '\u0000'.repeat(2 * 1024 * 1024)
  const serialized = JSON.stringify({ reqBody: body, resBody: body }) + '\n'
  writeFileSync(legalPath, serialized)
  let deliveredBytes = 0
  const legal = new LogTailer({ logPath: legalPath, onChunk: chunk => { deliveredBytes += Buffer.byteLength(chunk) } })
  drain(legal)
  assert.equal(deliveredBytes, Buffer.byteLength(serialized))
  assert.equal(legal.droppedBytes, 0)
  assert.equal(legal.status().dataComplete, true)
  console.log('PASS LogTailer boundaries: per-pump read cap, exact UTF-8, oversized-line recovery/accounting, retry rollback, byte counts and rotation')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
