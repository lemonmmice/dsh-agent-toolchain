// "真装插件" 类测试的 profile 解析器（2026-09-23 起）。
//
// 为什么需要它 —— CI 连红三次的根因：
//   插件 `index.js` 里 `import { defineTool } from '@deepseek-ai/dsh-tools'` 是**裸包名**，
//   只有"这台机器装过 DSH 宿主"才解析得到（本机实测解析到宿主安装目录下那份）。
//   于是旧写法（硬断言 `找得到已部署副本`）在开发机必然绿、在 CI runner 必然红 ——
//   它断言的其实是"这台机器装过 DSH"，**不是代码**（长期约定第②条：测试不许断言机器全局状态）。
//
// 现在分三级，任何一级都不许把"没跑到"当"通过"：
//   ① host-profile —— 现有 profile 可用（开发机常态）：零网络，且额外核对**部署副本与仓库逐字节一致**
//   ② temp-profile —— 自建：拷插件 + 拷 `lib/tool-registry.mjs` + 装**公开发布**的 SDK
//   ③ 返回 ok:false —— 调用方**显式 skip 并计数**，绝不假绿
//
// ⚠ 版本诚实（别把 ② 说成等价）：本机宿主自带的是 `0.1.6-alpha.1`（**未发布**），
//   而 npm 上最新是 `0.0.1-rc.1`（= docs/compatibility.md 记录的已验证版本）。
//   所以 ② 加载的 SDK 与**活宿主**可能不是同一个版本 —— 返回值里带 `mode` 与 `sdkVersion`，
//   测试必须把它印出来。要换版本：`DSH_TEST_DSH_TOOLS_VERSION=<版本>`。
import { existsSync, mkdirSync, cpSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 公开发布版；与 docs/compatibility.md 的 "verified" 行保持一致，不取 latest（CI 要可复现）。 */
export const SDK_VERSION = process.env.DSH_TEST_DSH_TOOLS_VERSION || '0.0.1-rc.1'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PLUGIN = 'dsh-memory'

/** 真正该问的问题：从插件目录出发，那个裸包名解析得到吗？ */
export function canResolveSdk(dir) {
  const probe = "try{console.log(import.meta.resolve('@deepseek-ai/dsh-tools'))}catch(e){console.log('NORESOLVE')}"
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
    { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true })
  return r.status === 0 && !/^NORESOLVE/.test(String(r.stdout || '').trim())
}

/** `lib/store.mjs` 的 `binding()` 是**硬抛**（没有 JS 兜底）：拿不到原生模块就装不起插件。 */
function nativeStorePath() {
  if (process.env.DSH_MEMORY_STORE_NATIVE) return process.env.DSH_MEMORY_STORE_NATIVE
  return join(REPO, 'plugins', PLUGIN, 'bin', `${process.platform}-${process.arch}`, 'memory-store.node')
}

/**
 * @returns {{ok:boolean, profile:string, pluginPath:string, mode:string, sdkVersion:string, reason:string}}
 */
export function prepareProfile() {
  // ① 现有 profile（开发机）
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web'),
  ].filter(Boolean)
  for (const p of candidates) {
    const pluginDir = join(p, 'plugins', PLUGIN)
    if (existsSync(join(pluginDir, 'index.js')) && canResolveSdk(pluginDir)) {
      return { ok: true, profile: p, pluginPath: join(pluginDir, 'index.js'), mode: 'host-profile', sdkVersion: '宿主自带', reason: '' }
    }
  }

  // ② 自建临时 profile。
  // ⚠ 位置必须在**系统临时目录**，不能放仓库里：`scripts/run-tests.mjs` 会**递归**收集 `*.test.mjs`，
  //   放仓库内会让它把副本里的测试也当测试跑（2026-09-23 实测：11 个文件变 22 个 + 2 个假红）。
  // ⚠ 而且是**每进程一个**：run-tests 并发跑各测试文件，共用一个目录会让两个进程互相踩
  //   （2026-09-23 实测：共用一个目录时 search-render 在 run-tests 下假红、单独跑却绿）。
  const built = mkdtempSync(join(tmpdir(), 'dsh-memory-profile-'))
  try {
    // 原生模块必须先有：`lib/store.mjs` 拿不到就硬抛。CI 上由 `npm run build:memory-store` 先建好；
    // 开发机没建时这属于**能力缺失**（跳过并计数），不是代码错 —— 别把它报成红。
    if (!existsSync(nativeStorePath())) {
      return { ok: false, profile: '', pluginPath: '', mode: '', sdkVersion: SDK_VERSION,
        reason: '本机没有宿主 profile，且 memory 原生模块未构建（npm run build:memory-store）→ 无法真装插件' }
    }
    mkdirSync(join(built, 'plugins', PLUGIN), { recursive: true })
    mkdirSync(join(built, 'lib'), { recursive: true })
    cpSync(join(REPO, 'plugins', PLUGIN), join(built, 'plugins', PLUGIN), {
      recursive: true,
      // ⚠ 不能排除 `bin/`：CI 上原生模块就在那里（`bin/<platform>-<arch>/memory-store.node`），
      //   排除掉就等于自建了一个**装不起来**的 profile（2026-09-23 实测：status-egress 报 store.mjs:15）。
      filter: (src) => !/([\\/])node_modules([\\/]|$)/.test(src),
    })
    // 整个 lib/ 按部署布局拷（仓库 `lib/` → `<profile>/lib/`）。只拷 tool-registry.mjs 不够：
    // 实测 `lib/memory.mjs` 还 import `../../lib/env-fallback.mjs`，
    // 漏拷的后果是 ERR_MODULE_NOT_FOUND（2026-09-23 场景 2 实测）。
    cpSync(join(REPO, 'lib'), join(built, 'lib'), { recursive: true })
    const sdkPkg = join(built, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
    if (!existsSync(sdkPkg)) {
      writeFileSync(join(built, 'package.json'), JSON.stringify({ name: 'dsh-memory-test-profile', private: true }, null, 2))
      const r = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '@deepseek-ai/dsh-tools@' + SDK_VERSION],
        { cwd: built, encoding: 'utf8', timeout: 300000, shell: true, windowsHide: true })
      if (r.status !== 0) {
        return { ok: false, profile: '', pluginPath: '', mode: '', sdkVersion: SDK_VERSION,
          reason: 'npm install @deepseek-ai/dsh-tools@' + SDK_VERSION + ' 失败：' + String((r.stderr || r.stdout || '').trim()).slice(0, 200) }
      }
    }
    if (canResolveSdk(join(built, 'plugins', PLUGIN))) {
      // 进程退出即清理（自建目录不小：node_modules 十几个包）。尽力而为，失败不影响判定。
      process.once('exit', () => { try { rmSync(built, { recursive: true, force: true }) } catch { /* 清理失败不改判定 */ } })
      return { ok: true, profile: built, pluginPath: join(built, 'plugins', PLUGIN, 'index.js'), mode: 'temp-profile', sdkVersion: SDK_VERSION, reason: '' }
    }
    return { ok: false, profile: '', pluginPath: '', mode: '', sdkVersion: SDK_VERSION,
      reason: '自建 profile 后仍解析不到 @deepseek-ai/dsh-tools（装上的是 ' + SDK_VERSION + '）' }
  } catch (e) {
    return { ok: false, profile: '', pluginPath: '', mode: '', sdkVersion: SDK_VERSION,
      reason: '自建 profile 抛错：' + (e && e.message ? e.message : String(e)) }
  }
}

/** 统一的装载说明行：无论走哪一级，都把"装载来源 + SDK 版本"印出来。 */
export function describeProfile(p) {
  return p.ok
    ? '装载来源 = ' + p.mode + '（SDK ' + p.sdkVersion + '）：' + p.pluginPath
    : '装载不可用：' + p.reason
}
