// W5 单测：截图内联（inline-image）。纯计算 + 临时文件，跨平台，可在 macOS/CI 上跑。
// 约定同本仓其它测试：手写 check()，末行打印 PASS/FAIL，用退出码表决。
import { attachInlineImage, pickImagePath, readImageContent, inlineEnabled, inlineMaxBytes } from './inline-image.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 一段固定字节（是否是"真 PNG"无所谓：本测只验证 base64 自洽与按扩展名判 mime，从不解码成图）。
const BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const B64 = BYTES.toString('base64')

const mkText = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })

const work = mkdtempSync(join(tmpdir(), 'inline-image-'))
const png = join(work, 'shot.png')
const jpg = join(work, 'shot.jpg')
writeFileSync(png, BYTES)
writeFileSync(jpg, BYTES)

try {
  // ---- inlineEnabled 门（默认关是零回归的关键）----
  check('默认关（无 env、无 opts）', inlineEnabled({}, {}) === false)
  check('env DSH_UI_INLINE_IMAGE=1 → 开', inlineEnabled({}, { DSH_UI_INLINE_IMAGE: '1' }) === true)
  check('env=on/yes/true 皆开', inlineEnabled({}, { DSH_UI_INLINE_IMAGE: 'on' }) === true && inlineEnabled({}, { DSH_UI_INLINE_IMAGE: 'true' }) === true)
  check('opts.enabled=false 覆盖 env=1', inlineEnabled({ enabled: false }, { DSH_UI_INLINE_IMAGE: '1' }) === false)
  check('inlineMaxBytes 默认 5MB', inlineMaxBytes({}, {}) === 5_000_000)
  check('inlineMaxBytes 读 env', inlineMaxBytes({}, { DSH_UI_INLINE_IMAGE_MAXBYTES: '123' }) === 123)

  // ---- pickImagePath ----
  check('shot: 取 workspacePath', pickImagePath({ ok: true, action: 'shot', workspacePath: png, path: '/x.png' }) === png)
  check('shot: 无 workspacePath 回落 path', pickImagePath({ ok: true, action: 'shot', workspacePath: null, path: png }) === png)
  check('capture 动作也算', pickImagePath({ ok: true, action: 'capture', path: png }) === png)
  check('ui_launch: 取 uiState.screenshot', pickImagePath({ ok: true, uiState: { screenshot: png } }) === png)
  check('非图动作（read）→ null', pickImagePath({ ok: true, action: 'read', lines: [] }) === null)
  check('失败结果（ok:false）不取图', pickImagePath({ ok: false, action: 'shot', path: png }) === null)

  // ---- readImageContent：编码 + mime + 封顶 + 不抛 ----
  {
    const r = readImageContent(png, 5_000_000)
    check('读图 → image block', !!r.content && r.content.type === 'image')
    check('base64 与文件自洽', r.content && r.content.data === B64)
    check('png → image/png', r.content && r.content.mimeType === 'image/png')
  }
  check('jpg → image/jpeg', readImageContent(jpg, 5_000_000).content.mimeType === 'image/jpeg')
  {
    const r = readImageContent(png, 10) // 文件比 10B 大
    check('过大 → skip 说明、无 content', !!r.skip && !r.content, JSON.stringify(r))
  }
  {
    const r = readImageContent(join(work, 'nope.png'), 5_000_000)
    check('缺文件 → skip 说明、不抛', !!r.skip && !r.content)
  }

  // ---- attachInlineImage 端到端 ----
  {
    const out = attachInlineImage(mkText({ ok: true, action: 'shot', workspacePath: png }), { ok: true, action: 'shot', workspacePath: png }, { enabled: true })
    check('开启：文本块保留 + 追加 image 块', out.content.length === 2 && out.content[0].type === 'text' && out.content[1].type === 'image')
    check('内联的 base64 正确', out.content[1].data === B64)
  }
  {
    const out = attachInlineImage(mkText({ ok: true, action: 'shot', workspacePath: png }), { ok: true, action: 'shot', workspacePath: png }, { enabled: false })
    check('关闭：只剩文本块（零回归）', out.content.length === 1 && out.content[0].type === 'text')
  }
  {
    const out = attachInlineImage(mkText({ ok: true, action: 'shot', workspacePath: png }), { ok: true, action: 'shot', workspacePath: png }, { enabled: true, maxBytes: 10 })
    check('开启但过大：文本 + 说明块、无 image', out.content.length === 2 && out.content[1].type === 'text' && /inline-image/.test(out.content[1].text))
  }
  {
    const out = attachInlineImage(mkText({ ok: false, action: 'shot', path: png }), { ok: false, action: 'shot', path: png }, { enabled: true })
    check('失败结果即便开启也不内联', out.content.length === 1)
  }
  {
    const out = attachInlineImage(mkText({ ok: true, uiState: { screenshot: png } }), { ok: true, uiState: { screenshot: png } }, { enabled: true })
    check('ui_launch 形状：内联 uiState.screenshot', out.content.length === 2 && out.content[1].type === 'image')
  }
  {
    const weird = { foo: 1 } // 非标准结果（无 content 数组）→ 原样返回、不抛
    check('非标准结果原样返回', attachInlineImage(weird, {}, { enabled: true }) === weird)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS inline-image (all checks)' : `FAIL inline-image (${failures} failed)`)
process.exit(failures ? 1 : 0)
