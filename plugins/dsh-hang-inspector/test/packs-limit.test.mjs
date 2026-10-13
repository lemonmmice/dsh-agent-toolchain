// hang_packs 的 limit：只列最新 N 个证据包（最新在前，只对选中页取完整元数据）；不传 limit 列全部（向后兼容）。
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { makeHangInspector } from '../lib/hang.mjs'

const packsRoot = mkdtempSync(join(tmpdir(), 'hang-packs-'))
try {
  for (let i = 0; i < 4; i++) {
    const p = join(packsRoot, `pack-${i}`)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'summary.txt'), `主窗口无响应 ${i}\n第二行\n`, 'utf8')
    const t = new Date((i + 1) * 100000) // 递增 mtime，排序确定
    utimesSync(p, t, t)
  }
  const hng = makeHangInspector({ packs: packsRoot })

  // 不传 limit → 全部，按 ts 倒序（最新在前），向后兼容
  const all = hng.listPacks()
  assert.equal(all.length, 4)
  assert.deepEqual(all.map((p) => p.id), ['pack-3', 'pack-2', 'pack-1', 'pack-0'])

  // limit=2 → 只最新 2 个，且仍取到完整元数据
  const top2 = hng.listPacks({ limit: 2 })
  assert.equal(top2.length, 2)
  assert.deepEqual(top2.map((p) => p.id), ['pack-3', 'pack-2'])
  assert.ok(top2[0].summaryFirst.includes('无响应'), 'limit 页仍取完整元数据（summaryFirst）')
  assert.ok(Array.isArray(top2[0].files) && top2[0].files.length >= 1, 'limit 页仍含文件清单')

  // limit 超过总数 / 非法 → 全部（兼容）
  assert.equal(hng.listPacks({ limit: 99 }).length, 4)
  assert.equal(hng.listPacks({ limit: 0 }).length, 4)
  assert.equal(hng.listPacks({ limit: -1 }).length, 4)

  console.log('PASS: hang_packs limit (newest-N, full metadata only for the page, back-compat without limit)')
} finally {
  rmSync(packsRoot, { recursive: true, force: true })
}
