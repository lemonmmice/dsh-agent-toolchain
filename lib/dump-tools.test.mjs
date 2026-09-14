// lib/dump-tools 单测 —— dump 三件套（procdump / DumpStack / DAC）的路径解析
//
// 病（2026-09-11 实测）：两个插件各自读 `DSH_*_PROCDUMP` / `DSH_*_DUMPSTACK` / `DSH_*_DAC_DIR`，
// 缺省回落到 `~/.dsh-agent-toolchain/tools/...`；本机这三个文件在**别的地方**，于是
//   · 只配了 procdump 的环境里，dump 抓得到、**分析不了**（DumpStack 没配）；
//   · 报错只说"procdump 缺失 / DumpStack 缺失"，看不出是**没配**还是**文件不在**、更不知道去哪配。
//
// 锁死四件事：
//   ① 一处配置、三件套全好（在 procdump 旁边按磁盘实际布局推导）；
//   ② env 优先于推导；
//   ③ 缺失时给出**可执行**的说明（哪个变量、试过哪些路径）；
//   ④ 不抛异常（工具不在是常态，不是崩溃）。
import { resolveDumpTools } from './dump-tools.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const work = mkdtempSync(join(tmpdir(), 'dumptools-'))
try {
  // 造一个"真实的"工具布局：tools\procdump.exe + tools\dumpstack\publish-x86\DumpStack.exe + tools\dac\
  const tools = join(work, 'tools')
  const dsDir = join(tools, 'dumpstack', 'publish-x86')
  const dacDir = join(tools, 'dac')
  mkdirSync(dsDir, { recursive: true })
  mkdirSync(dacDir, { recursive: true })
  writeFileSync(join(tools, 'procdump.exe'), 'x')
  writeFileSync(join(dsDir, 'DumpStack.exe'), 'x')

  // ---------------------------------------------- ① 只给 procdump → 另外两个推导出来
  {
    const r = resolveDumpTools({ env: { DSH_X_PROCDUMP: join(tools, 'procdump.exe') }, procdumpEnv: ['DSH_X_PROCDUMP'], dumpstackEnv: ['DSH_X_DUMPSTACK'], dacEnv: ['DSH_X_DAC'], toolsRoot: '' })
    check('只配 procdump：procdump 命中', r.procdumpExists === true, JSON.stringify(r.procdump))
    check('★DumpStack 从 procdump 同级目录推导出来', r.dumpstackExists === true && /dumpstack/.test(r.dumpstack), JSON.stringify({ p: r.dumpstack, from: r.origins.dumpstack }))
    check('★DAC 目录同样推导出来', r.dacDirExists === true && r.dacDir === dacDir, JSON.stringify({ p: r.dacDir, from: r.origins.dacDir }))
    check('全部命中时没有警告（不刷噪音）', r.warnings.length === 0, JSON.stringify(r.warnings))
  }

  // ---------------------------------------------- ② env 显式优先
  {
    const other = join(work, 'other-dumpstack.exe')
    writeFileSync(other, 'x')
    const r = resolveDumpTools({ env: { DSH_X_PROCDUMP: join(tools, 'procdump.exe'), DSH_X_DUMPSTACK: other }, procdumpEnv: ['DSH_X_PROCDUMP'], dumpstackEnv: ['DSH_X_DUMPSTACK'], dacEnv: ['DSH_X_DAC'], toolsRoot: '' })
    check('显式 env 优先于推导', r.dumpstack === other && r.origins.dumpstack === 'DSH_X_DUMPSTACK', JSON.stringify({ p: r.dumpstack, from: r.origins.dumpstack }))
  }

  // ---------------------------------------------- ③ 缺失时给出可执行说明 + 试过哪些路径
  {
    const r = resolveDumpTools({ env: {}, procdumpEnv: ['DSH_NOPE_PROCDUMP'], dumpstackEnv: ['DSH_NOPE_DUMPSTACK'], dacEnv: ['DSH_NOPE_DAC'], toolsRoot: join(work, 'absent-tools') })
    check('全缺时 procdump/dumpstack 都判为不可用', r.procdumpExists === false && r.dumpstackExists === false, JSON.stringify({ p: r.procdump, d: r.dumpstack }))
    check('★警告里点名了要设哪个环境变量', r.warnings.some((w) => /DSH_NOPE_PROCDUMP/.test(w)) && r.warnings.some((w) => /DSH_NOPE_DUMPSTACK/.test(w)), JSON.stringify(r.warnings).slice(0, 240))
    check('★警告里列出"试过哪些路径"（可核对）', r.warnings.every((w) => /试过：/.test(w)), JSON.stringify(r.warnings).slice(0, 300))
    check('警告里说明缺了会怎样（拿不到线程栈 / 解析不出托管栈）', r.warnings.some((w) => /线程栈/.test(w)) && r.warnings.some((w) => /托管栈/.test(w)), JSON.stringify(r.warnings).slice(0, 300))
    check('searched 里记录了候选路径（供上层展示）', Array.isArray(r.searched.dumpstack) && r.searched.dumpstack.length >= 2, JSON.stringify(r.searched.dumpstack).slice(0, 200))
  }

  // ---------------------------------------------- ④ 不抛异常 + 空输入
  {
    check('空参数不抛且给出结构', (() => { try { const r = resolveDumpTools({}); return r && typeof r === 'object' && r.procdumpExists === false } catch { return false } })())
    check('toolsRoot 指向不存在的目录也不抛', (() => { try { return resolveDumpTools({ toolsRoot: join(work, 'nope') }).dumpstackExists === false } catch { return false } })())
  }
  // ---------------------------------------------- ⑤ 用户级注册表回退（第 13 处同型半修）
  // 病（2026-09-11 真机实测）：本模块只读 process.env，而同批插件里别的配置项都走 envOr 的注册表回退。
  // 用户按 Windows 常规做法把工具路径配在**用户级环境变量**里，长活宿主的进程环境块里却没有 →
  // 判定「procdump 缺失」→ 卡死时抓不到 dump → 只能给模块级线索，拿不到代码级证据（G3 被掐死），
  // 而报错还在教用户"去设置 DSH_*_PROCDUMP"（他已经设过了 = 工具在说谎，G2）。
  {
    const pd = join(tools, 'procdump.exe')
    // 注入一个假的 reg 执行器：模拟"进程环境没有、但注册表里有"这台机器
    const fakeExec = (file, args) => {
      const name = args[args.length - 1]
      if (name === 'DSH_R_PROCDUMP') return 'HKEY_CURRENT_USER\\Environment\r\n    DSH_R_PROCDUMP    REG_SZ    ' + pd + '\r\n'
      return ''   // 其它变量：注册表里也没有（reg query 失败路径由此模拟）
    }
    const r = resolveDumpTools({
      env: {},                                   // 进程环境里**没有**（这正是长活宿主的真实处境）
      exec: fakeExec,
      procdumpEnv: ['DSH_R_PROCDUMP'], dumpstackEnv: ['DSH_R_DUMPSTACK'], dacEnv: ['DSH_R_DAC'],
      toolsRoot: '',
    })
    check('★进程环境没有时，从**用户级注册表**取到 procdump（旧实现只读 process.env → 判"缺失"）',
      r.procdumpExists === true && r.procdump === pd, JSON.stringify({ p: r.procdump, exists: r.procdumpExists }))
    check('★来源标注说明"取自用户级环境变量"（不让人误以为进程里有）', /用户级/.test(r.origins.procdump), r.origins.procdump)
    // 同一次里 DumpStack / DAC 仍从 procdump 同级推导 —— 一处配置三件套全好
    check('★注册表取到的 procdump 同样能推导出 DumpStack/DAC（不是只修了 procdump 一条）',
      r.dumpstackExists === true && r.dacDirExists === true, JSON.stringify({ d: r.dumpstack, dac: r.dacDir }))

    // 显式空串 = 主动清空 → **必须**停留在 missing（否则测试无法模拟"未配置"，也正是早前那场
    // "回退把用户正在跑的客户端杀掉"事故的成因）
    const cleared = resolveDumpTools({
      env: { DSH_R_PROCDUMP: '' }, exec: fakeExec,
      procdumpEnv: ['DSH_R_PROCDUMP'], dumpstackEnv: ['DSH_R_DUMPSTACK'], dacEnv: ['DSH_R_DAC'], toolsRoot: '',
    })
    check('★显式空串不回退注册表（测试能模拟"未配置"，不再驱动真实目标）',
      cleared.procdumpExists === false, JSON.stringify(cleared.procdump))

    // 进程环境有值时，注册表**不该**被问到（进程环境优先，且省一次 reg.exe）
    let asked = 0
    const countingExec = (file, args) => { asked++; return fakeExec(file, args) }
    const direct = resolveDumpTools({
      env: { DSH_R_PROCDUMP: pd }, exec: countingExec,
      procdumpEnv: ['DSH_R_PROCDUMP'], dumpstackEnv: ['DSH_R_DUMPSTACK'], dacEnv: ['DSH_R_DAC'], toolsRoot: '',
    })
    check('进程环境有值时直接采用、不去问注册表', direct.procdumpExists === true && asked === 0, 'asked=' + asked)
  }

} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: dump-tools 路径解析（一处配置三件套全好 + 缺失可自解释）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
