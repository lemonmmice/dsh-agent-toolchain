/**
 * dump 取证三件套（procdump / DumpStack / DAC）的**路径解析** —— 两个插件共用一份。
 *
 * 为什么需要（2026-09-11 实测）：
 *   perf 与 hang 都各自读 `DSH_*_PROCDUMP` / `DSH_*_DUMPSTACK` / `DSH_*_DAC_DIR`，
 *   缺省回落到 `~/.dsh-agent-toolchain/tools/...`。而本机这三个文件在**另一个位置**，
 *   于是真实后果是：
 *     · MCP 面（配置里写了 DSH_PERF_*）能抓 dump；**DSH 面（宿主只拿到用户级环境变量、那里没写）不能** ——
 *       同一个工具、两个面行为不同，而报错只说"procdump 缺失"，看不出是"没配"还是"文件不在"；
 *     · hang 侧连 `DSH_HANG_DUMPSTACK` 都没在配置里出现过 → 抓到证据包也**分析不了**。
 *
 * 本模块做两件事：
 *   ① **一处配置、三件套全好**：只要给出 procdump 的位置，就在它旁边按约定找
 *      `dumpstack\publish-x86\DumpStack.exe` 与 `dac\`（这是这三件套在磁盘上的实际布局）；
 *   ② 解析结果**自带诊断**：每个路径是哪来的（env/推导/默认）、存不存在、试过哪些候选、
 *      缺了会怎样 —— 让"缺失"永远能自解释，而不是一句"procdump 缺失"。
 *
 * 纯 Node，无宿主依赖，可离线单测。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 环境变量解析要**与插件其余配置同一套**（进程环境 → 用户级注册表 → 机器级）。
// 见下方 pickEnv 的说明：这里曾经只读 process.env，于是"用户明明配了、工具说他没配"（G2/G3）。
import { envValue } from './env-fallback.mjs'

/** DumpStack 相对 procdump 所在目录的两种常见布局。 */
const DUMPSTACK_REL = [
  join('dumpstack', 'publish-x86', 'DumpStack.exe'), // 32 位客户端用（x86 DAC）
  join('dumpstack', 'publish', 'DumpStack.exe'),     // 64 位
  'DumpStack.exe',                                   // 与 procdump 同级
]

/**
 * @param {object} o
 * @param {string[]} o.procdumpEnv   依次尝试的环境变量名（如 ['DSH_HANG_PROCDUMP','DSH_PERF_PROCDUMP']）
 * @param {string[]} o.dumpstackEnv  同上
 * @param {string[]} o.dacEnv        同上
 * @param {string}   o.toolsRoot     缺省工具根（通常是 <toolchainRoot>\tools）
 * @returns {{procdump:string, dumpstack:string, dacDir:string, procdumpExists:boolean, dumpstackExists:boolean, dacDirExists:boolean, origins:object, searched:object, warnings:string[]}}
 */
export function resolveDumpTools(o = {}) {
  const env = o.env || process.env
  const toolsRoot = o.toolsRoot || ''
  const warnings = []
  const pickEnv = (names) => {
    for (const n of (names || [])) {
      const direct = env[n]
      if (direct && String(direct).trim() !== '') return { value: String(direct).trim(), from: n }
      // 显式空串 = 调用方主动清空 → 不回退注册表（与 envValue 语义一致，测试要能模拟"未配置"）
      if (typeof direct === 'string') continue
      // **进程环境没有 → 再看用户级/机器级注册表**（与插件其余配置同一套读法）。
      //
      // 第 13 处"同型半修"（2026-09-11 真机实测）：本模块原先只读 `process.env`，而同一批插件里
      // 别的配置项（DSH_UI_PROC_NAME / DSH_PERF_SRC_ROOT…）都走 envOr 的注册表回退 —— **同一份代码里
      // 两套读法**。后果正好打在用户的头号场景上：
      //   用户照 Windows 常规做法把 procdump/DumpStack 配在"用户级环境变量"里；DSH 宿主是长活进程，
      //   环境块里没有这两个变量 → 本模块判定「procdump 缺失」→ 卡死时**抓不到 dump** →
      //   "卡死"永远只能给模块级线索，拿不到代码级证据（G3 被这一条掐死）。
      //   更糟的是报错还在教用户"去设置 DSH_*_PROCDUMP" —— 他已经设过了（G2：工具在说谎）。
      //
      // 注册表读取受 `DSH_NO_ENV_FALLBACK=1` 硬闸约束（测试运行器统一注入），所以测试对"本机真配了
      // 什么"依旧完全失明；要测回退本身，显式注入 { env, exec }。
      let r = null
      try { r = envValue(n, { env, exec: o.exec }) } catch { r = null }
      if (r && r.value) {
        const tag = r.source === 'user' ? '（取自用户级环境变量）' : (r.source === 'machine' ? '（取自机器级环境变量）' : '')
        return { value: r.value, from: n + tag }
      }
    }
    return { value: '', from: '' }
  }

  const searched = { procdump: [], dumpstack: [], dacDir: [] }
  const origins = {}

  // ---- procdump ----
  const pd = pickEnv(o.procdumpEnv)
  const pdCandidates = []
  if (pd.value) pdCandidates.push({ p: pd.value, from: pd.from })
  if (toolsRoot) pdCandidates.push({ p: join(toolsRoot, 'procdump.exe'), from: '默认工具目录' })
  for (const c of pdCandidates) searched.procdump.push(c.p)
  const pdHit = pdCandidates.find((c) => existsSync(c.p)) || pdCandidates[0] || { p: '', from: '' }
  const procdump = pdHit.p
  origins.procdump = pdHit.from
  const procdumpExists = !!procdump && existsSync(procdump)

  // ---- DumpStack（① env ② procdump 旁边 ③ 工具根）----
  const ti = pickEnv(o.dumpstackEnv)
  const dsCandidates = []
  if (ti.value) dsCandidates.push({ p: ti.value, from: ti.from })
  if (procdump) {
    const base = dirname(procdump)
    for (const rel of DUMPSTACK_REL) dsCandidates.push({ p: join(base, rel), from: 'procdump 同级目录推导' })
  }
  if (toolsRoot) for (const rel of DUMPSTACK_REL) dsCandidates.push({ p: join(toolsRoot, rel), from: '默认工具目录' })
  for (const c of dsCandidates) searched.dumpstack.push(c.p)
  const dsHit = dsCandidates.find((c) => existsSync(c.p)) || dsCandidates.find((c) => c.from === ti.from) || { p: '', from: '' }
  const dumpstack = dsHit.p
  origins.dumpstack = dsHit.from
  const dumpstackExists = !!dumpstack && existsSync(dumpstack)

  // ---- DAC 目录 ----
  const da = pickEnv(o.dacEnv)
  const dacCandidates = []
  if (da.value) dacCandidates.push({ p: da.value, from: da.from })
  if (procdump) dacCandidates.push({ p: join(dirname(procdump), 'dac'), from: 'procdump 同级目录推导' })
  if (toolsRoot) dacCandidates.push({ p: join(toolsRoot, 'dac'), from: '默认工具目录' })
  for (const c of dacCandidates) searched.dacDir.push(c.p)
  const daHit = dacCandidates.find((c) => existsSync(c.p)) || dacCandidates[0] || { p: '', from: '' }
  const dacDir = daHit.p
  origins.dacDir = daHit.from
  const dacDirExists = !!dacDir && existsSync(dacDir)

  if (!procdumpExists) {
    warnings.push('procdump 不可用（' + (procdump || '(未配置)') + '）：抓不了 dump，也就拿不到线程栈。设 ' +
      (o.procdumpEnv || ['DSH_*_PROCDUMP']).join(' / ') + ' 指向 procdump.exe。试过：' + searched.procdump.join('、'))
  }
  if (!dumpstackExists) {
    warnings.push('DumpStack 不可用（' + (dumpstack || '(未配置)') + '）：dump 抓到了也分析不了。设 ' +
      (o.dumpstackEnv || ['DSH_*_DUMPSTACK']).join(' / ') + ' 指向 DumpStack.exe，或把它放在 procdump 旁边的 dumpstack\\publish-x86\\ 下。试过：' + searched.dumpstack.join('、'))
  }
  if (!dacDirExists) {
    warnings.push('DAC 目录不可用（' + (dacDir || '(未配置)') + '）：与 dump 内 CLR 版本匹配的 mscordacwks.dll 缺了会解析不出托管栈。设 ' +
      (o.dacEnv || ['DSH_*_DAC_DIR']).join(' / ') + ' 指向 dac 目录。试过：' + searched.dacDir.join('、'))
  }

  return { procdump, dumpstack, dacDir, procdumpExists, dumpstackExists, dacDirExists, origins, searched, warnings }
}
