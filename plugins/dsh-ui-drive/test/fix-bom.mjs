// 把插件内的 .ps1 重写为 UTF-8 BOM（PowerShell 5.1 硬性要求，edit 工具会丢 BOM）
// 用法: node fix-bom.mjs [文件1] [文件2] ...
import { readFileSync, writeFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node fix-bom.mjs <ps1...>')
  process.exit(1)
}
for (const f of files) {
  const buf = readFileSync(f)
  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  writeFileSync(f, '\uFEFF' + text, 'utf8')
  console.log('fixed BOM:', f)
}
