#!/usr/bin/env node
/**
 * Pack a DSH-face plugin from this monorepo into a self-contained installable tgz.
 *
 * 背景：仓库里的插件通过 '../../../lib/*.mjs' 引用 monorepo 根的共享模块，共享模块
 * 之间用 './X.mjs' 互引、并用仓库相对路径引用插件自己的模块与原生产物。
 * deploy-plugins.mjs 部署出的 junction/实体布局能让这些路径成立；但「插件市场」
 * 独立安装得到的是 profile node_modules 下的实体目录，解析不出包外路径。
 *
 * 本脚本把插件打成自包含 tgz：共享模块 vendor 到 lib/_shared/，所有包外相对引用
 * 重写为包内路径；随后用 node 真实 import 一遍校验静态导入图完整，再 npm pack。
 * 源码文件只读不改；产物写到 .dsh-agent-toolchain/dist/。
 *
 * 重写规则（<plugin> = 目标插件目录名）：
 *   插件文件:   '../../../lib/X'                  -> './_shared/X'
 *   共享模块:   './Y'                             -> 不变（Y 同样 vendor 进 _shared）
 *   共享模块:   '../plugins/<plugin>/lib/Z'       -> '../Z'
 *   共享模块:   '../plugins/<plugin>/bin/...'     -> '../../bin/...'
 *
 * 用法: node scripts/pack-dsh-plugins.mjs [--plugin dsh-api-visualizer]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, '.dsh-agent-toolchain', 'dist')

const pluginArgIndex = process.argv.indexOf('--plugin')
const pluginName = pluginArgIndex !== -1 ? process.argv[pluginArgIndex + 1] : 'dsh-api-visualizer'
const pluginDir = join(repoRoot, 'plugins', pluginName)
if (!existsSync(join(pluginDir, 'package.json'))) {
  console.error(`plugin not found: ${pluginDir}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const pluginPkgName = pkg.name // e.g. @dsh-agent-toolchain/dsh-api-visualizer
const declaredDeps = new Set(Object.keys(pkg.dependencies ?? {}))

/** 相对路径字符串字面量（含 ' " ` 三种引号，覆盖 import('…') 与 new URL(`…`)）。 */
const RELATIVE_LITERAL = /(['"`])((?:\.\.\/)+(?:[^'"`\\]+)|\.(?:\/[^'"`\\]+))\1/g

/** 从一个仓库内文件的源码里取出「相对路径字面量」，解析为仓库内绝对路径（存在文件才返回）。 */
function repoRelativeTargets(sourceFile, sourceText) {
  const baseDir = dirname(sourceFile)
  const targets = []
  for (const match of sourceText.matchAll(RELATIVE_LITERAL)) {
    const spec = match[2].split('${')[0] // 模板串按 ${ 前缀取可解析前缀
    const resolved = resolve(baseDir, spec)
    if (existsSync(resolved) && statSync(resolved).isFile()) targets.push({ spec, resolved })
  }
  return targets
}

/** 收集共享闭包：从插件文件出发，把所有包外 lib 引用收进一个 Map（repo 绝对路径 -> 条目）。 */
function collectSharedClosure() {
  const shared = new Map() // repo abs path of lib module -> { source }
  const pluginFiles = []
  const queue = []
  const pushPluginTree = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'bin'].includes(entry.name)) continue
        pushPluginTree(full)
      } else if (/\.(mjs|js)$/.test(entry.name)) queue.push(full)
    }
  }
  pushPluginTree(join(pluginDir, 'lib'))

  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    pluginFiles.push(file)
    const text = readFileSync(file, 'utf8')
    for (const { spec, resolved } of repoRelativeTargets(file, text)) {
      const rel = relative(repoRoot, resolved).replace(/\\/g, '/')
      if (rel.startsWith('lib/')) {
        if (!shared.has(resolved)) {
          shared.set(resolved, { source: resolved })
          queue.push(resolved) // 共享模块自身的相对引用继续收
        }
      } else if (rel.startsWith(`plugins/${pluginName}/`)) {
        if (/\.(mjs|js)$/.test(resolved)) queue.push(resolved) // 插件自有模块，本来就会打包
      }
      // 其余（bin/ 产物、未知）不进 JS 闭包；bin/ 整目录已随包复制
    }
  }
  return { shared, pluginFiles }
}

/** 对插件文件文本应用包外引用重写。 */
function rewritePluginSource(text) {
  return text.replace(/(['"`])((?:\.\.\/)+lib\/[^'"`]+)\1/g, (m, q, spec) => `${q}./_shared/${spec.replace(/^((?:\.\.\/)+lib\/)/, '')}${q}`)
}

/** 对共享模块文本应用重写（落位 lib/_shared/ 后的坐标）。 */
function rewriteSharedSource(text) {
  return text
    .replaceAll(`../plugins/${pluginName}/lib/`, '../')
    .replaceAll(`../plugins/${pluginName}/bin/`, '../../bin/')
}

function copyTree(src, dest, transform) {
  mkdirSync(dirname(dest), { recursive: true })
  if (statSync(src).isDirectory()) {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copyTree(join(src, entry.name), join(dest, entry.name), transform)
    }
    return
  }
  if (transform) writeFileSync(dest, transform(readFileSync(src, 'utf8')), 'utf8')
  else cpSync(src, dest)
}

// ---------------------------------------------------------------- staging ---

const stageDir = join(distDir, 'pack', pluginName)
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
  if (['node_modules', '.gitignore', 'dist'].includes(entry.name)) continue
  copyTree(join(pluginDir, entry.name), join(stageDir, entry.name))
}

const { shared, pluginFiles } = collectSharedClosure()

// 插件文件：复制并重写 '../../../lib/…'
const stagedPluginLibDir = join(stageDir, 'lib')
for (const file of pluginFiles) {
  const rel = relative(join(pluginDir, 'lib'), file)
  const dest = join(stagedPluginLibDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rewritePluginSource(readFileSync(file, 'utf8')), 'utf8')
}

// 共享模块：vendor 到 lib/_shared/ 并重写
const sharedDir = join(stagedPluginLibDir, '_shared')
for (const [abs] of shared) {
  const dest = join(sharedDir, basename(abs))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rewriteSharedSource(readFileSync(abs, 'utf8')), 'utf8')
}

// ------------------------------------------------------- 静态导入图自检 ---

const stagedMain = join(stageDir, 'lib', 'index.js')
const probe = spawnSync(
  process.execPath,
  ['--input-type=module', '--eval', `const m = await import(${JSON.stringify(pathToFileURL(stagedMain).href)}); console.log('GRAPH OK', typeof m.apply)`],
  { encoding: 'utf8' },
)
if (probe.status !== 0 || !probe.stdout.includes('GRAPH OK')) {
  console.error('staged import graph check FAILED:')
  console.error(probe.stdout)
  console.error(probe.stderr)
  process.exit(1)
}

// ------------------------------------------------------------ npm pack ---

const packDest = distDir
mkdirSync(packDest, { recursive: true })
const packed = spawnSync('npm', ['pack', '--pack-destination', packDest], { cwd: stageDir, encoding: 'utf8', shell: true })
if (packed.status !== 0) {
  console.error('npm pack FAILED:')
  console.error(packed.stdout)
  console.error(packed.stderr)
  process.exit(1)
}
const npmTgzLine = packed.stdout.trim().split('\n').filter((l) => l.trim().endsWith('.tgz')).pop()
if (!npmTgzLine) {
  console.error('npm pack produced no tgz line:\n' + packed.stdout)
  process.exit(1)
}
const npmTgz = resolve(packDest, npmTgzLine.trim())
const friendlyTgz = join(packDest, `${pluginName}-${pkg.version}.tgz`)
rmSync(friendlyTgz, { force: true })
cpSync(npmTgz, friendlyTgz)
rmSync(npmTgz, { force: true })

// -------------------------------------------------------------- 产物自检 ---

const listing = spawnSync('tar', ['-tf', friendlyTgz], { encoding: 'utf8', shell: true })
const names = listing.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
const mustHave = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  `package/lib/index.js`,
  `package/lib/_shared/capture-store.mjs`,
  `package/lib/_shared/tool-registry.mjs`,
  `package/bin/win32-x64/capture-store.node`,
]
const missing = mustHave.filter((want) => !names.some((n) => n === want || n.endsWith(want.replace('package/', 'package/'))))
if (missing.length > 0) {
  console.error('tgz content check FAILED, missing:\n' + missing.join('\n'))
  process.exit(1)
}

console.log(`packed ${pluginPkgName}@${pkg.version}`)
console.log(`  shared modules vendored: ${[...shared.keys()].map((p) => basename(p)).sort().join(', ')}`)
console.log(`  tgz: ${friendlyTgz} (${statSync(friendlyTgz).size} bytes)`)
