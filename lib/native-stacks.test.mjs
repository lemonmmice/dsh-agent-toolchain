// lib/native-stacks 单测 —— 32 位原生栈 unwind 的解析、汇总与 cdb 定位
//
// 病（2026-09-20 实测）：`DumpStack` 只出**托管**栈，于是"有没有线程卡在图形驱动里"这类问题
// 在报告里永远停在"仍需原生线程栈"——两个不同来源的分析都卡在这一步。而原生栈其实能自动化，
// 只是有四个坑（x64 调试器才能解 WOW64、WindowsApps 下的 cdb 不能直接执行、`!wow64exts.sw` 是
// 切换不是设置、按 tid 选线程要写 `0n<十进制>`）。本测试把这些坑全部钉死，并且**锁死三态口径**：
// "没解析到帧"绝不能被写成"没有线程在驱动里"。
import {
  buildUnwindCommands,
  parseFrame,
  isVendorDriverFrame,
  isGraphicsStackFrame,
  parseNativeStacks,
  summarizeNativeStacks,
  resolveSymbolPath,
  resolveCdb,
  copyDebuggerOut,
  runNativeStacks,
  resolveNoSymbolDir,
} from './native-stacks.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 真实日志的形状（模块名已脱敏成通用 Windows/WPF 模块；厂商驱动帧是**故意**造的，用于验证识别）
const LOG_32BIT = `
   0  Id: 1234.ae20 Suspend: 0 Teb: 007ba000 Unfrozen
ChildEBP RetAddr      
0096d120 75eeef5f     ntdll_77e30000!NtWaitForMultipleObjects+0xc
0096d120 75eeedb8     KERNELBASE!WaitForMultipleObjectsEx+0x18f
0096d13c 68a2f2c0     KERNELBASE!WaitForMultipleObjects+0x18
0096d270 68a2f32f     wpfgfx_v0400!CMilChannel::WaitForNextMessage+0xf0
0096d290 64b53cdb     wpfgfx_v0400!MilComposition_WaitForNextMessage+0x6d
0096d2e4 64ad60fa     PresentationCore_ni+0x10f553
0096d478 655f8bbc     WindowsBase_ni+0xc88d1
WARNING: Frame IP not in any known module. Following frames may be wrong.
0096d5c0 77449693     0x11ad08e
*** WARNING: Unable to verify checksum for PresentationCore.ni.dll
   1  Id: 1234.4c9c Suspend: 0 Teb: 00000000\`35cee000 Unfrozen
ChildEBP RetAddr      
1fc7fd0c 689f3288     wpfgfx_v0400!CPartitionManager::GetWork+0x159
1fc7fd24 68a2539f     wpfgfx_v0400!CPartitionThread::Run+0x18
1fc7fd4c 76305d49     wpfgfx_v0400!CPartitionThread::ThreadMain+0x2f
   2  Id: 1234.1111 Suspend: 0 Teb: 00000000\`35c38000 Unfrozen
Child-SP          RetAddr               Call Site
00000000\`18bbee98 00000000\`77e21de4     wow64cpu!CpupSyscallStub+0x13
00000000\`18bbef50 00007ffc\`c865282d     wow64cpu!BTCpuSimulate+0x9
`

// 只有线程列表、没有帧的表头（`~` 的输出混进来时）必须被丢掉，不能算成"一条空栈线程"
const LOG_ONLY_LIST = `
  88  Id: 1234.605c Suspend: 0 Teb: 00000000\`35cd8000 Unfrozen
  89  Id: 1234.b43c Suspend: 0 Teb: 00000000\`35c38000 Unfrozen
`

const work = mkdtempSync(join(tmpdir(), 'nativestacks-'))
try {
  // ---------------------------------------------- ① 帧文本解析（四种实测形态）
  {
    const a = parseFrame('ntdll_77e30000!NtWaitForSingleObject+0xc')
    check('① 模块!符号+偏移', a.module === 'ntdll_77e30000' && a.symbol === 'NtWaitForSingleObject' && a.offset === '0xc' && a.resolved)
    const b = parseFrame('WindowsBase_ni+0xc88d1')
    check('① 模块+偏移（无符号，NGEN 托管程序集）', b.module === 'WindowsBase_ni' && b.symbol === '' && b.resolved === false)
    const c = parseFrame('0x11ad08e')
    check('① 裸地址（未解析）', c.module === '' && c.resolved === false)
    check('① 空串不抛', parseFrame('').module === '')
  }

  // ---------------------------------------------- ② 驱动帧 vs 图形框栈帧
  {
    check('② igc32（Intel 驱动）判为厂商驱动', isVendorDriverFrame('igc32!SomeInternal+0x1a2b3') === true)
    check('② nvwgf2umx（NVIDIA 驱动）判为厂商驱动', isVendorDriverFrame('nvwgf2umx!X+0x1') === true)
    check('② wpfgfx_v0400 判为图形栈（**不是**驱动）', isGraphicsStackFrame('wpfgfx_v0400!CMilChannel::WaitForNextMessage+0xf0') === true && isVendorDriverFrame('wpfgfx_v0400!x+0x1') === false)
    check('② KERNELBASE/ntdll 既不是驱动也不是图形栈', isVendorDriverFrame('KERNELBASE!WaitForSingleObject+0x12') === false && isGraphicsStackFrame('KERNELBASE!X+0x1') === false)
    check('② 不做子串误判（libcef 里的 …igc… 不算驱动）', isVendorDriverFrame('libcef!cef_string_igc_helper+0x1') === false)
  }

  // ---------------------------------------------- ③ 解析 ~*k 输出
  {
    const r = parseNativeStacks(LOG_32BIT)
    check('③ 解析出 3 条线程', r.threads.length === 3, JSON.stringify(r.threads.map((t) => t.tid)))
    check('③ tid 按十六进制还原成十进制', r.threads.map((t) => t.tid).join(',') === '44576,19612,4369', JSON.stringify(r.threads.map((t) => t.tid)))
    check('③ 32 位段识别为 x86', r.threads[0].mode === 'x86')
    check('③ 64 位段识别为 x64（同一次输出里混排也要对）', r.threads[2].mode === 'x64')
    check('③ 无 `ChildEBP` 头的块不会被当成帧', r.threads[0].frames[0].indexOf('ntdll_77e30000!') === 0, r.threads[0].frames[0])
    check('③ WARNING/DBGHELP 之类噪声行被跳过', r.threads[0].frames.every((f) => !/WARNING|DBGHELP|ChildEBP/.test(f)), JSON.stringify(r.threads[0].frames))
    check('③ 未解析帧（0x…）仍保留在栈里（不能悄悄丢）', r.threads[0].frames.some((f) => f === '0x11ad08e'))

    const list = parseNativeStacks(LOG_ONLY_LIST)
    check('③ ★只有 Id 没有帧的表头被丢弃（否则会把线程数虚报）', list.threads.length === 0 && list.skippedHeaders === 2, JSON.stringify(list))
  }

  // ---------------------------------------------- ④ 三态口径（本仓最硬的一条）
  {
    const parsed = parseNativeStacks(LOG_32BIT)
    const sum = summarizeNativeStacks(parsed.threads)
    check('④ 有帧但无驱动帧 → 结论是"没有线程在驱动里执行"', /没有任何一条在执行显卡驱动模块/.test(sum.verdict), sum.verdict)
    check('④ ★同一句里必须写明"不等于驱动无问题"（不许把没看到说成没有）', /不等于驱动无问题/.test(sum.verdict), sum.verdict)
    check('④ 图形栈线程被点名（含 UI 线程那条，命中帧要标出来——栈顶是 ntdll，不是渲染帧）',
      sum.graphicsStackThreads.some((t) => t.tid === 44576 && /CMilChannel/.test(t.hit) && t.hitIndex === 3),
      JSON.stringify(sum.graphicsStackThreads))
    check('④ 未解析帧计数如实给出', sum.unresolvedFrames >= 1 && sum.resolvedFrames > 0, JSON.stringify({ r: sum.resolvedFrames, u: sum.unresolvedFrames }))

    const withDriver = summarizeNativeStacks(parseNativeStacks(LOG_32BIT + `
   3  Id: 1234.2222 Suspend: 0 Teb: 00000000\`35c68000 Unfrozen
ChildEBP RetAddr      
2bd2f6f0 55667788     igc32!CompilerSomething+0x1a2b3
`).threads)
    check('④ 出现厂商驱动帧 → 点名 tid 与帧', withDriver.runningInVendorDriver.length === 1 && withDriver.runningInVendorDriver[0].tid === 8738, JSON.stringify(withDriver.runningInVendorDriver))
    check('④ 出现厂商驱动帧 → 结论改口径（"这才是正在驱动里执行"）', /正在驱动里执行/.test(withDriver.verdict), withDriver.verdict)

    const empty = summarizeNativeStacks([])
    check('④ ★一帧都没解析到 → 明说"未解析到任何原生栈（未知，不是没有）"', /未解析到任何原生栈/.test(empty.verdict) && /未知/.test(empty.verdict), empty.verdict)
    check('④ ★此时**绝不**能说"没有线程在驱动里"', !/没有任何一条在执行/.test(empty.verdict), empty.verdict)

    const partial = summarizeNativeStacks(parseNativeStacks(LOG_32BIT).threads, { partial: true, reason: 'cdb 在 900s 超时被结束' })
    check('④ ★没跑完时结论必须自曝（半份日志不能当全量：实测只解出 2/94 条线程那次就是这么被误读的）',
      partial.partial === true && /没有跑完/.test(partial.verdict) && /不能当全量结论/.test(partial.verdict) && /900s/.test(partial.verdict), partial.verdict)
  }

  // ---------------------------------------------- ⑤ 命令串（两个坑）
  {
    const one = buildUnwindCommands({ frames: 12 })
    check('⑤ 默认全量走 ~*k', /~\*k/.test(one) && /\.kframes 12/.test(one) && /q$/.test(one), one)
    check('⑤ `!wow64exts.sw` 出现（默认切 32 位视图）', (one.match(/!wow64exts\.sw/g) || []).length === 1, one)
    const many = buildUnwindCommands({ threads: [15188, 14432, 14428] })
    check('⑤ ★多条线程时 `!wow64exts.sw` 仍然只出现一次（它是切换，不是设置）', (many.match(/!wow64exts\.sw/g) || []).length === 1, many)
    check('⑤ ★按 tid 选线程用 `~~[0n<十进制>]s`（WinDbg 默认十六进制）', /~~\[0n15188\]s/.test(many) && !/~~\[15188\]s/.test(many), many)
    check('⑤ --no-wow64-switch 时不出现切换命令', !/wow64exts/.test(buildUnwindCommands({ switchWow64: false })))
  }

  // ---------------------------------------------- ⑥ 符号路径
  {
    const a = resolveSymbolPath({ DSH_PERF_SYMBOL_PATH: 'srv*cache*https://msdl' })
    check('⑥ 显式 env 优先且原样使用', a.value === 'srv*cache*https://msdl' && a.from === 'DSH_PERF_SYMBOL_PATH', JSON.stringify(a))
    const b = resolveSymbolPath({}, join(work, 'sym'))
    check('⑥ 默认回落到本地缓存 + 微软符号服务器', /^srv\*/.test(b.value) && /download\/symbols$/.test(b.value), b.value)
  }

  // ---------------------------------------------- ⑦ cdb 定位（含 WindowsApps 必须拷出来）
  {
    const direct = join(work, 'cdb.exe')
    writeFileSync(direct, 'x')
    const r1 = resolveCdb({ env: { DSH_NATIVE_CDB: direct }, envNames: ['DSH_NATIVE_CDB'], storeWindbg: [], onPath: [] })
    check('⑦ env 指定且存在 → 直接用', r1.path === direct && r1.origin === 'DSH_NATIVE_CDB', JSON.stringify(r1))

    // 造一个"商店版 WinDbg 包"布局：…/WindowsApps/Microsoft.WinDbg_9.9.9_x64__test/amd64/cdb.exe
    const pkgDir = join(work, 'WindowsApps', 'Microsoft.WinDbg_9.9.9_x64__test', 'amd64')
    mkdirSync(join(pkgDir, 'winxp'), { recursive: true })
    writeFileSync(join(pkgDir, 'cdb.exe'), 'x')
    writeFileSync(join(pkgDir, 'dbgeng.dll'), 'x')
    writeFileSync(join(pkgDir, 'winxp', 'wow64exts.dll'), 'x')
    const cache = join(work, 'cache')
    const r2 = resolveCdb({ env: {}, envNames: ['DSH_NOPE_CDB'], storeWindbg: [join(pkgDir, 'cdb.exe')], onPath: [], cacheDir: cache })
    check('⑦ ★WindowsApps 下的 cdb 自动拷到可写目录（那里直接执行会被拒）', r2.path !== join(pkgDir, 'cdb.exe') && r2.path.startsWith(cache) && existsSync(r2.path), JSON.stringify({ p: r2.path, from: r2.copiedFrom }))
    check('⑦ 拷贝与源路径都如实回报（可审计）', /WindowsApps/.test(r2.copiedFrom) && /拷贝|拷到|不能直接执行/.test(r2.origin), JSON.stringify(r2.origin))
    check('⑦ 引擎 dll 与扩展目录一起拷（否则 !wow64exts 加载不了）', existsSync(join(cache, 'Microsoft.WinDbg_9.9.9_x64__test', 'amd64', 'dbgeng.dll')) && existsSync(join(cache, 'Microsoft.WinDbg_9.9.9_x64__test', 'amd64', 'winxp', 'wow64exts.dll')))
    const again = copyDebuggerOut(join(pkgDir, 'cdb.exe'), cache)
    check('⑦ 重复调用是幂等的（不重复拷贝）', again === r2.path, again)

    const r3 = resolveCdb({ env: {}, envNames: ['DSH_NOPE_CDB'], storeWindbg: [], onPath: [] })
    check('⑦ 全缺时不抛、path 为空、警告点名要设哪个变量', r3.path === '' && r3.warnings.some((w) => /DSH_NOPE_CDB/.test(w)), JSON.stringify(r3.warnings).slice(0, 200))
    check('⑦ 全缺时警告里说明"只有 64 位调试器解得出来"并给出安装办法', r3.warnings.some((w) => /64 位调试器/.test(w) && /WinDbg|SDK/.test(w)), JSON.stringify(r3.warnings).slice(0, 300))
    check('⑦ 全缺时列出"试过哪些路径"（可核对）', r3.warnings.some((w) => /试过：/.test(w)), JSON.stringify(r3.warnings).slice(0, 300))
  }
  // ---------------------------------------------- ⑧ 真跑 cdb 这一层（注入假 spawn，离线可测）
  {
    let seen = null
    const fakeSpawn = (file, args) => { seen = { file, args }; return { status: 0, stdout: LOG_32BIT, stderr: '' } }
    const r = runNativeStacks({ dump: 'x.dmp', cdbPath: 'cdb.exe', symbols: '', commands: 'q', spawnSync: fakeSpawn })
    check('⑧ 参数按 cdb 约定传（-z dump -y <符号> -c <命令>）',
      seen.file === 'cdb.exe' && seen.args.join(' ') === '-z x.dmp -y  -c q' && r.exitCode === 0, JSON.stringify(seen))
    check('⑧ 符号路径原样透传给 -y', seen.args[3] === '', JSON.stringify(seen.args))
    const nd = resolveNoSymbolDir(join(work, 'nosym'))
    check('⑧ ★快速档给的是**存在的空目录**（传空串会被 cdb 回退到内置 msdl 默认路径，实测卡掉 600s）',
      existsSync(nd) && readdirSync(nd).length === 0, nd)
    const killed = runNativeStacks({
      dump: 'x', cdbPath: 'c', symbols: '', commands: 'q', timeoutMs: 5000,
      spawnSync: () => ({ status: null, stdout: 'partial', stderr: '', error: new Error('ETIMEDOUT') }),
    })
    check('⑧ ★超时被杀 → killed=true / 退出码 -1 / 错误原文带上（半份日志绝不能当全量）',
      killed.killed === true && killed.exitCode === -1 && /ETIMEDOUT/.test(killed.error), JSON.stringify(killed))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: native-stacks（原生栈解析 + 三态口径 + cdb 定位）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
