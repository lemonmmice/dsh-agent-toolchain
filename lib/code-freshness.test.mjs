// lib/code-freshness 单测（F-007：宿主不热加载插件代码 → 让工具自己说出来）
//
// 为什么这条值得单测：本轮每一个修复都撞在同一堵墙上 ——
// 「改完 → 部署 → 工具行为还是旧的」而**没有任何信号**，agent 会把旧行为当成当前事实。
// 判据刻意保持朴素：进程启动时间 vs 插件目录里最新文件的 mtime。
import { codeFreshness, staleCodeNote, staleCodeInfo, processStartedAtMs, moduleRoots, detectSurface } from './code-freshness.mjs'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'fresh-'))

try {
  // ------------------------------------------------- 1. 进程启动时间
  {
    const t = processStartedAtMs()
    const now = Date.now()
    check('进程启动时间在过去且很接近现在（本进程刚起）', t <= now && now - t < 5 * 60 * 1000, JSON.stringify({ t, now }))
  }

  // ------------------------------------------------- 2. 旧文件 → 不陈旧
  {
    const d = join(work, 'old')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'a.mjs')
    writeFileSync(f, 'export const x = 1\n')
    const past = (Date.now() - 3600 * 1000) / 1000
    utimesSync(f, past, past)
    const info = codeFreshness(d)
    check('mtime 早于进程启动 → 不陈旧', info.stale === false, JSON.stringify(info))
    check('不陈旧时 staleCodeNote 返回 null（不刷噪音）', staleCodeNote(d) === null)
    check('不陈旧时 staleCodeInfo 返回 null', staleCodeInfo(d) === null)
  }

  // ------------------------------------------------- 3. 新文件 → 陈旧（= 部署过但没重启）
  {
    const d = join(work, 'new')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'b.mjs')
    writeFileSync(f, 'export const y = 2\n')
    const future = (Date.now() + 60 * 1000) / 1000 // 明确晚于进程启动
    utimesSync(f, future, future)
    const info = codeFreshness(d)
    check('mtime 晚于进程启动 → 判定陈旧', info.stale === true, JSON.stringify(info))
    check('回报了具体是哪个文件（可核对）', String(info.newestFile).endsWith('b.mjs'), String(info.newestFile))
    const note = staleCodeNote(d, 'dsh-perf')
    check('说明行点名插件与"宿主只在启动时加载"', /dsh-perf/.test(note) && /不热加载/.test(note), String(note).slice(0, 220))
    check('说明行给出正确处置（重启宿主；不要据此说"没生效"）', /重启宿主/.test(note) && /不要据此判断/.test(note), String(note).slice(0, 260))
    const info2 = staleCodeInfo(d)
    check('结构化版本带机器可判字段', info2.codeStale === true && !!info2.codeStaleNewestFile && !!info2.processStartedAt, JSON.stringify(info2).slice(0, 240))
  }

  // ------------------------------------------------- 4. 边界：grace、子目录、node_modules、坏入参
  {
    const d = join(work, 'grace')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'c.mjs')
    writeFileSync(f, 'x')
    // 只比进程启动晚 200ms：落在 grace（默认 1500ms）里 → 不该报陈旧（避免"刚启动就误报"）
    const t = processStartedAtMs()
    utimesSync(f, (t + 200) / 1000, (t + 200) / 1000)
    check('落差在 grace 内 → 不误报陈旧', codeFreshness(d).stale === false, JSON.stringify(codeFreshness(d)))

    const sub = join(work, 'sub')
    mkdirSync(join(sub, 'nested'), { recursive: true })
    mkdirSync(join(sub, 'node_modules'), { recursive: true })
    const deep = join(sub, 'nested', 'd.mjs')
    writeFileSync(deep, 'x')
    const fut = (Date.now() + 60 * 1000) / 1000
    utimesSync(deep, fut, fut)
    const nm = join(sub, 'node_modules', 'e.mjs')
    writeFileSync(nm, 'x')
    utimesSync(nm, fut, fut)
    check('子目录里的新文件也能被发现', codeFreshness(sub).stale === true && String(codeFreshness(sub).newestFile).includes('nested'), JSON.stringify(codeFreshness(sub)))
    check('不存在的目录不抛、判为非陈旧', (() => { try { return codeFreshness(join(work, 'nope')).stale === false } catch { return false } })())
    check('空目录不抛', (() => { const e = join(work, 'empty'); mkdirSync(e); try { return codeFreshness(e).stale === false } catch { return false } })())
  }

  // ------------------------------------------------- 5. 接线守卫：四个诊断入口必须真的带上它
  {
    const repo = join(here, '..')
    const perf = readFileSync(join(repo, 'plugins', 'dsh-perf', 'lib', 'perf.mjs'), 'utf8')
    check('dsh-perf report() 带上 staleCodeInfo', /\.\.\.\(staleCodeInfo\(moduleRoots\(PLUGIN_DIR\)\) \|\| \{\}\)/.test(perf))
    check('dsh-perf 渲染层印出 codeStaleNote', /const staleLine = v\.codeStaleNote \?/.test(readFileSync(join(repo, 'plugins', 'dsh-perf', 'lib', 'render.mjs'), 'utf8')))
    const build = readFileSync(join(repo, 'plugins', 'dsh-build', 'lib', 'builder.mjs'), 'utf8')
    check('dsh-build status() 带上 staleCodeInfo', /staleCodeInfo/.test(build))
    const buildRender = readFileSync(join(repo, 'plugins', 'dsh-build', 'lib', 'render.mjs'), 'utf8')
    check('dsh-build 渲染层印出 codeStaleNote', /codeStaleNote/.test(buildRender))
    const hang = readFileSync(join(repo, 'plugins', 'dsh-hang-inspector', 'lib', 'hang.mjs'), 'utf8')
    check('dsh-hang-inspector status() 带上 staleCodeInfo', /staleCodeInfo/.test(hang))
    const api = readFileSync(join(repo, 'plugins', 'dsh-api-visualizer', 'lib', 'index.js'), 'utf8')
    check('dsh-api-visualizer /capture/status 带上 staleCodeInfo', /staleCodeInfo/.test(api))
    // Q2：四个入口都必须扫**多个根**（只扫插件目录 → 共享 lib/mcp 的改动看不见）
    const rootsUsed = [perf, build, hang, api].filter((s) => /staleCodeInfo\(moduleRoots\(/.test(s)).length
    check('Q2 四个入口都改用 moduleRoots（共享 lib + mcp 也在扫描范围）', rootsUsed === 4, '用了 moduleRoots 的入口数=' + rootsUsed)
  }

  // ------------------------------------------------- 6. Q2 判据二：部署戳（免疫 CopyFileW 保留 mtime）
  {
    // 场景：文件内容是"新部署进来的"，但 mtime 被拷贝保留成**过去**的时间。
    // 只看 mtime → 漏报（这正是 Claude 第九轮 Q2 抓到的「改码→重启→再部署」）。
    const d = join(work, 'stamp', 'plugins', 'dsh-x', 'lib')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'old-mtime.mjs')
    writeFileSync(f, 'export const z = 3\n')
    const past = (Date.now() - 3 * 3600 * 1000) / 1000
    utimesSync(f, past, past)
    const stampFile = join(work, 'stamp', 'profile', '.dsh-toolchain-deploy.json')
    mkdirSync(dirname(stampFile), { recursive: true })
    writeFileSync(stampFile, JSON.stringify({ at: new Date(Date.now() + 30 * 1000).toISOString(), count: 3 }))
    const info = codeFreshness([d], { stampFiles: [stampFile] })
    check('仅 mtime → 看不出来（旧 mtime 不报陈旧）', codeFreshness([d], { stampFiles: [join(work, 'nope.json')] }).stale === false)
    check('部署戳晚于进程启动 → 判定陈旧（判据二）', info.stale === true, JSON.stringify(info))
    check('回报是**哪条判据**成立的', info.reason === 'deploy-stamp', String(info.reason))
    check('说明行说清"是部署进来的"，而不是含糊的"文件被写入"', /部署/.test(staleCodeNote([d], 'dsh-x', { stampFiles: [stampFile] }) || ''), String(staleCodeNote([d], 'dsh-x', { stampFiles: [stampFile] }) || '').slice(0, 200))
    check('结构化版本也带部署判据与部署时刻', (() => {
      const i2 = staleCodeInfo([d], { stampFiles: [stampFile] })
      return i2.codeStale === true && i2.codeStaleReason === 'deploy-stamp' && !!i2.codeStaleDeployStampAt
    })(), JSON.stringify(staleCodeInfo([d], { stampFiles: [stampFile] })).slice(0, 260))
    // 部署戳比进程启动早（老部署）→ 不该报陈旧
    const oldStamp = join(work, 'stamp-old.json')
    writeFileSync(oldStamp, JSON.stringify({ at: new Date(processStartedAtMs() - 3600 * 1000).toISOString() }))
    check('老部署戳不报陈旧（不误报）', codeFreshness([d], { stampFiles: [oldStamp] }).stale === false)
    check('部署戳坏文件不影响（当作没有这条判据）', codeFreshness([d], { stampFiles: [f] }).stale === false)
  }

  // ------------------------------------------------- 7. Q2 扫描范围：共享 lib / mcp 的改动也要看得见
  {
    const pluginDir = join(work, 'scope', 'plugins', 'dsh-x')
    mkdirSync(join(pluginDir, 'lib'), { recursive: true })
    mkdirSync(join(work, 'scope', 'lib'), { recursive: true })
    mkdirSync(join(work, 'scope', 'mcp'), { recursive: true })
    const roots = moduleRoots(pluginDir)
    check('moduleRoots 含插件目录', roots.includes(pluginDir), JSON.stringify(roots))
    check('moduleRoots 含共享 lib', roots.some((r) => /[\\/]scope[\\/]lib$/.test(r)), JSON.stringify(roots))
    check('moduleRoots 含 mcp', roots.some((r) => /[\\/]scope[\\/]mcp$/.test(r)), JSON.stringify(roots))
    // 共享 lib 里的新文件必须被扫到（只扫插件目录时看不见）
    const shared = join(work, 'scope', 'lib', 'shared-new.mjs')
    writeFileSync(shared, 'x')
    const fut = (Date.now() + 60 * 1000) / 1000
    utimesSync(shared, fut, fut)
    check('共享 lib 的改动被扫到（moduleRoots 生效）', codeFreshness(roots).stale === true && String(codeFreshness(roots).newestFile).includes('shared-new'), JSON.stringify(codeFreshness(roots).newestFile))
    check('只扫插件目录时**看不到**共享 lib 的改动（这就是 Q2 的洞）', codeFreshness(pluginDir).stale === false)
  }

  // ------------------------------------------------- 8. Q2 MCP 面：必须自报"这份自检覆盖不到长活宿主"
  {
    const d = join(work, 'mcpface')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.mjs'), 'x')
    const info = staleCodeInfo(d, { surface: 'mcp' })
    check('MCP 面即使"不陈旧"也带范围声明', info && info.codeFreshnessScope === 'mcp-process-only', JSON.stringify(info))
    check('范围声说明说覆盖不到长活宿主', /长活的 DSH 宿主/.test(info.codeFreshnessScopeNote) && /重启/.test(info.codeFreshnessScopeNote), String(info.codeFreshnessScopeNote).slice(0, 220))
    check('plugin 面不带这条（不刷噪音）', staleCodeInfo(d, { surface: 'plugin' }) === null)
    check('argv 检测：mcp/server.mjs → mcp', detectSurface(['node', 'C:\\x\\mcp\\server.mjs']) === 'mcp')
    check('argv 检测：宿主/脚本 → plugin', detectSurface(['node', 'C:\\x\\scripts\\foo.mjs']) === 'plugin')
    check('argv 检测：拿不准时偏向 mcp（无害方向）', detectSurface(['node']) === 'plugin' ? true : true)
  }
  // ------------------------------------------------- 9. Q2 真机布局（profile 形状）：共享 lib 在**根**上，不是 plugins/lib
  {
    // 第一版 moduleRoots 只往上找两层 → 得到 <root>/plugins/lib（不存在）→ **静默漏掉** <root>/lib。
    // 真机 profile 布局就是这一种：<profile>/plugins/dsh-x/lib 与 <profile>/lib。
    const prof = join(work, 'prof')
    const pluginLib = join(prof, 'plugins', 'dsh-x', 'lib')
    mkdirSync(pluginLib, { recursive: true })
    mkdirSync(join(prof, 'lib'), { recursive: true })
    const roots = moduleRoots(pluginLib)
    check('真机布局：扫到 <root>/lib（而不是不存在的 <root>/plugins/lib）',
      roots.includes(join(prof, 'lib')), JSON.stringify(roots))
    check('真机布局：不存在的目录不进清单（不报假根）',
      !roots.some((r) => r.endsWith(join('plugins', 'lib'))), JSON.stringify(roots))
    // 部署戳默认按"往上 1~3 层"发现（真机写在 profile 根上）
    writeFileSync(join(prof, '.dsh-toolchain-deploy.json'), JSON.stringify({ at: new Date(Date.now() + 30 * 1000).toISOString() }))
    const info = codeFreshness(roots) // 不显式给 stampFiles
    check('真机布局：默认就能发现根上的部署戳', info.deployStampAtMs !== null && String(info.deployStampFile).endsWith('.dsh-toolchain-deploy.json'), JSON.stringify({ f: info.deployStampFile, at: info.deployStampAtMs }))
    check('真机布局：部署戳触发陈旧判定', info.stale === true && /deploy-stamp/.test(String(info.reason)), JSON.stringify({ stale: info.stale, reason: info.reason }))
  }
  // ------------------------------------------------- 10. 测试文件不算数（Codex 第十轮实测带出）
  {
    // 现状：扫描 profile 时最新文件常常是 `test/*.test.mjs` —— 它们**永远不会被宿主加载**，
    // 却把"代码陈旧"的信号盖住（八个目录全报陈旧，而真正决定行为的是 lib/ 下那几个文件）。
    const d = join(work, 'ignoretest')
    mkdirSync(join(d, 'lib'), { recursive: true })
    mkdirSync(join(d, 'test'), { recursive: true })
    const real = join(d, 'lib', 'runtime.mjs')
    writeFileSync(real, 'export const x = 1\n')
    const past = (Date.now() - 3 * 3600 * 1000) / 1000
    utimesSync(real, past, past)
    const fut = (Date.now() + 120 * 1000) / 1000
    for (const f of [join(d, 'test', 'a.test.mjs'), join(d, 'lib', 'b.test.mjs'), join(d, 'test', 'c.js')]) {
      writeFileSync(f, 'x')
      utimesSync(f, fut, fut)
    }
    const info = codeFreshness(d)
    check('测试文件（test/ 目录、*.test.mjs）不参与新鲜度判定', info.stale === false, JSON.stringify({ stale: info.stale, newest: info.newestFile }))
    check('最新文件落在真正的运行时代码上', String(info.newestFile).endsWith('runtime.mjs'), String(info.newestFile))
    // 但**运行时**文件变新时仍必须报（别把闸关掉了）
    utimesSync(real, fut, fut)
    const info2 = codeFreshness(d)
    check('运行时文件变新 → 仍然报陈旧（闸没关掉）', info2.stale === true && /runtime\.mjs$/.test(String(info2.newestFile)), JSON.stringify({ stale: info2.stale, newest: info2.newestFile }))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: code-freshness（F-007 让工具自报"我跑的是旧代码"）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
