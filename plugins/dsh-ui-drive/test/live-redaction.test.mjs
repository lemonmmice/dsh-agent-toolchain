// dsh-ui-drive 敏感帧脱敏的**端到端**测试（Claude 第八轮 Q2 三条）
//
// 病（Claude 只读+真机确证）：
//   ① **MCP 面的 ui_live 完全不过 sanitizeLive**（server.mjs 直接 jtext(原始快照)）→
//      敏感帧的 path/pathAbs 在 MCP 面照出，脱敏只活在 DSH 面（F-021 的又一次重演）；
//   ② `sanitizeLive` 只清 path/pathAbs，却把 `file`（= 'latest.png'）与顶层 `dir` 留下 →
//      **join(dir, file) 正好重组出被清掉的 pathAbs**（换个字段泄漏）；
//   ③ `writeLatestJson` 落盘的是**未脱敏**的原始快照，而模块头自己声明 latest.json 是消费面
//      （"消费方(agent/路由)只看这一份"）→ 直接读盘的脚本绕过所有内存里的脱敏。
//
// 本测试用**假驱动**造出"焦点=密码控件"的现场（不碰真实客户端），
// 断言：内存出口脱敏、磁盘出口脱敏、四个路径字段一个都重组不出路径。
import { makeLive } from '../lib/live.mjs'
import { sanitizeLive } from '../lib/render.mjs'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'live-redact-'))
const here = dirname(fileURLToPath(import.meta.url))

/** 假驱动：capture 返回一帧；state-live 的 secretFocused 可切换。 */
function fakeDriver(state) {
  return {
    async drive(args) {
      if (args.action === 'capture') {
        const p = join(args.shotsDir || dir, args.label ? args.label + '.png' : 'cap.png')
        // 真写一个小文件，让"路径存在"这条断言有意义
        const { writeFileSync } = await import('node:fs')
        writeFileSync(p, 'PNGDATA')
        return { ok: true, path: p, w: 2560, h: 1184, state: 'visible', captureMethod: 'print' }
      }
      if (args.action === 'state-live') {
        return { ok: true, window: 'W', focused: state.secret ? '密码' : 'Button', count: 1, lines: ['#0 [Button] "A"'], secretFocused: state.secret === true }
      }
      if (args.action === 'status') return { running: true, pid: 1, title: 'W' }
      return { ok: false, error: 'unexpected ' + args.action }
    },
    warmShutdown() {},
  }
}

try {
  // ------------------------------------------------ 1. 非敏感帧：路径正常给出
  {
    const st = { secret: false }
    const live = makeLive({ driver: fakeDriver(st), dir })
    const s = await live.frame({})
    check('非敏感帧：memory 出口给出 path/pathAbs', !!s.frame?.path && !!s.frame?.pathAbs, JSON.stringify(s.frame).slice(0, 200))
    check('非敏感帧：不再提供冗余的 file 字段（每个冗余字段都是绕过脱敏的入口）', s.frame.file === undefined, JSON.stringify(Object.keys(s.frame || {})))
    check('非敏感帧：顶层 dir 保留（面板/脚本要用）', s.dir === dir, String(s.dir))
  }

  // ------------------------------------------------ 2. 敏感帧：内存出口脱敏
  {
    const st = { secret: true }
    const live = makeLive({ driver: fakeDriver(st), dir })
    // 先跑一帧非敏感（建立 lastFrame），再切到敏感 —— 与真实时序一致
    st.secret = false
    await live.frame({})
    st.secret = true
    const s = await live.frame({})
    const safe = sanitizeLive(s, false)
    check('敏感帧：path/pathAbs/file/dir 全为 null（重组不出路径）',
      safe.frame.path === null && safe.frame.pathAbs === null && safe.frame.file === null && safe.dir === null,
      JSON.stringify(safe).slice(0, 240))
    check('敏感帧：带 sensitiveBlocked 标记', safe.frame.sensitiveBlocked === true, JSON.stringify(safe.frame).slice(0, 160))
    check('敏感帧：secretFocused 仍如实为 true（"为什么没有路径"是可解释的）', safe.frame.secretFocused === true, JSON.stringify(safe.frame).slice(0, 160))

    // ---------------------------------------------- 3. 磁盘出口（latest.json）也必须脱敏
    const lp = join(dir, 'latest.json')
    check('latest.json 已落盘', existsSync(lp), lp)
    if (existsSync(lp)) {
      const raw = JSON.parse(readFileSync(lp, 'utf8').replace(/^\uFEFF/, ''))
      check('★latest.json 里的敏感帧也是脱敏的（读盘面绕不过去）',
        raw.frame?.path === null && raw.frame?.pathAbs === null && raw.frame?.file === null && raw.dir === null,
        JSON.stringify({ dir: raw.dir, frame: raw.frame }).slice(0, 260))
      check('latest.json 仍是可解析的合法快照（没有把文件写坏）', !!raw.live && !!raw.frame, Object.keys(raw).join(','))
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------ 4. 源码守卫：MCP 面必须接上同一个脱敏
{
  const repo = join(here, '..', '..', '..')
  const server = readFileSync(join(repo, 'mcp', 'server.mjs'), 'utf8')
  const root = readFileSync(join(repo, 'plugins', 'dsh-ui-drive', 'index.js'), 'utf8')
  check('MCP 面 import 了 sanitizeLive（与 DSH 面共用同一份实现）', /import \{ sanitizeLive \} from '\.\.\/plugins\/dsh-ui-drive\/lib\/render\.mjs'/.test(server))
  check('MCP 面 ui_live 的 5 个 action 全走脱敏包装 j()', (server.match(/const j = \(v\) => jtext\(sanitizeLive\(v, allow\)\)/g) || []).length === 1)
  check('MCP 面把 allowSensitive 真传给了 ctl.frame（不再是死参数）', /ctl\.frame\(\{ fresh: args\.fresh, allowSensitive: allow \}\)/.test(server))
  // 注意：**先把注释剥掉再断言**。第一版没剥，于是这条守卫匹配到了我自己写在修复注释里的
  // `jtext(ctl.status())` 字样 —— 断言在检查注释，而不是检查代码（又一个"断言写错"的实例）。
  const serverCode = server.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
  check('MCP 面没有漏网的 jtext(ctl.…)，直出原始快照', !/jtext\((await )?ctl\.(start|stop|status|frame|wait)\(/.test(serverCode))
  check('DSH 面仍走同一个 sanitizeLive', /sanitizeLive/.test(root))
  const liveSrc = readFileSync(join(repo, 'plugins', 'dsh-ui-drive', 'lib', 'live.mjs'), 'utf8')
  check('落盘路径也过脱敏（writeLatestJson 调 sanitizeLive）', /const safe = sanitizeLive\(\{ \.\.\.snap, dir: c\.dir \}, false\)/.test(liveSrc))
}

console.log(failures === 0 ? '\nPASS: ui-drive 敏感帧脱敏（内存出口 + 磁盘出口 + MCP 面接线）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
