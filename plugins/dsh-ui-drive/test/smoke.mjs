// dsh-ui-drive driver 冒烟：status → launch → find → read → shot
import { makeDriver } from '../lib/driver.mjs'
import { join } from 'node:path'

const driver = makeDriver({
  scriptsDir: join(import.meta.dirname, '..', 'scripts'),
  evidenceDir: join(process.env.DSH_UI_EVIDENCE_DIR || join(import.meta.dirname, '..', '.smoke-evidence')),
})

const mode = process.argv[2] || 'all'
const out = (label, v) => console.log('== ' + label + ' ==\n' + JSON.stringify(v, null, 1))

if (mode === 'status' || mode === 'all') {
  out('status(before)', await driver.status())
}
if (mode === 'launch' || mode === 'all') {
  out('launch', await driver.launch({ waitMs: 90000 }))
}
if (mode === 'find' || mode === 'all') {
  out('find 主窗口标题', await driver.drive({ action: 'find', name: process.env.DSH_UI_WINDOW_NAME || '主窗口' }))
  out('find 不存在控件X', await driver.drive({ action: 'find', name: '不存在的控件XYZ' }))
}
if (mode === 'read' || mode === 'all') {
  const r = await driver.drive({ action: 'read', match: '标题|设置' })
  out('read 标题|设置', { ok: r.ok, count: r.count, lines: (r.lines || []).slice(0, 12) })
}
if (mode === 'shot' || mode === 'all') {
  out('shot', await driver.drive({ action: 'shot', label: 'smoke' }))
}
if (mode === 'guard' || mode === 'all') {
  out('guard(click 不带 allowSideEffects 应被拦)', await driver.drive({ action: 'click', name: '任意' }))
}
if (mode === 'flow' || mode === 'all') {
  out('flow(只读自验)', await driver.flow({ tag: 'smoke-readonly', steps: [
    { action: 'expect', name: process.env.DSH_UI_WINDOW_NAME || '主窗口' },
    { action: 'expect', name: '不存在的控件XYZ' },
    { action: 'read', match: '标题', label: 'read' },
  ] }))
}
