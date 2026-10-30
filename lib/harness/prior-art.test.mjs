import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLearnedGuardrails, loadPriorArt } from './prior-art.mjs'

const SAMPLE = `# Learned Guardrails（用户级经验库）

本文件只记录已验证根因的教训。

## UI 线程被首屏集中构造阻塞导致卡顿（2026-09-15）

- 现象：ETF 入口首次进入卡顿。
- 根因：5 个子页面集中构造阻塞 UI 线程。
- 做法：按需创建 + 缓存。
- 适用域：WPF 首屏。

## 等分动态列必须计算下限（2026-10-21）

- 现象：列宽压缩显示省略号。
- 根因：最小列宽不含内距。
- 做法：按内容实测下限。
- 适用域：股票详情 DynamicStockResultGrid。

## 维护规则

- 不记录 token、密码等敏感信息。
`

test('parseLearnedGuardrails extracts lessons, skips the intro and the 维护规则 section', () => {
  const entries = parseLearnedGuardrails(SAMPLE)
  assert.equal(entries.length, 2)
  assert.ok(entries.every(entry => !/维护规则/.test(entry.title)))
  assert.equal(entries[0].date, '2026-09-15')
})

test('loadPriorArt routes by taskType: a thread-hang trial sees only the hang lesson', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prior-art-'))
  const file = join(dir, 'learned-guardrails.md')
  writeFileSync(file, SAMPLE, 'utf8')
  const hang = loadPriorArt(file, { taskType: 'thread-hang' })
  assert.equal(hang.matchedByDomain, true)
  assert.equal(hang.entries, 1)
  assert.ok(hang.text.includes('按需创建'))
  assert.ok(!hang.text.includes('DynamicStockResultGrid'))
})

test('loadPriorArt drops a lesson carrying a credential rather than leaking it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prior-art-secret-'))
  const file = join(dir, 'lg.md')
  writeFileSync(file, SAMPLE + '\n## 带密钥的教训（2026-10-01）\n\n- 证据：token sk-abcdef0123456789abcdef。\n- 适用域：WPF。\n', 'utf8')
  const loaded = loadPriorArt(file, { taskType: 'ui' })
  assert.ok(loaded.droppedForSensitive >= 1)
  assert.ok(!loaded.text.includes('sk-abcdef'))
})

test('loadPriorArt returns empty (never throws) for a missing file', () => {
  const loaded = loadPriorArt(join(tmpdir(), 'does-not-exist-prior-art-xyz.md'), { taskType: 'ui' })
  assert.equal(loaded.entries, 0)
  assert.equal(loaded.text, '')
})
