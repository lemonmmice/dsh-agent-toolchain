// lib/env-fallback.mjs 单测：环境变量解析（进程 → 用户级 → 机器级），并在"配了但没继承"时说实话。
//
// 真实事故（2026-09-11，本机实测）：
//   注册表 HKCU\Environment 里 DSH_UI_PROC_NAME=AcmeClient、DSH_UI_CLIENT_EXE=…\AcmeClient.exe 齐全，
//   而同一时刻 `ui_status` 返回 `{running:false, unconfigured:true}` —— 因为变量是在宿主启动**之后**
//   才设置的，长活宿主的 process.env 里没有它。工具不但帮不上忙，还把"去设置它"当成下一步
//   （用户已经设过了），并顺带让整条工具链看起来没配好（G1/G2 双输）。
import { envValue, envValues, envOr, unconfiguredHint, readRegistryEnv, resetEnvCache, decodeConsole } from './env-fallback.mjs'
import { readFileSync } from 'node:fs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 假 reg.exe：按 hive 返回预设输出（真实 reg query 的格式，含 REG_SZ / REG_EXPAND_SZ）
const REG_OUT = {
  'HKCU DSH_UI_PROC_NAME': 'HKEY_CURRENT_USER\\Environment\r\n    DSH_UI_PROC_NAME    REG_SZ    AcmeClient\r\n\r\n',
  'HKCU DSH_UI_CLIENT_EXE': 'HKEY_CURRENT_USER\\Environment\r\n    DSH_UI_CLIENT_EXE    REG_EXPAND_SZ    %TESTHOMEDIR%\\AcmeClient.exe\r\n\r\n',
  'HKLM DSH_UI_PROC_NAME': 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    DSH_UI_PROC_NAME    REG_SZ    MachineWideProc\r\n\r\n',
}
function fakeExec(file, args) {
  // args = ['query', hive, '/v', name]；真实 reg.exe 对值名**大小写不敏感**，这里如实模拟
  const hive = args[1]
  const name = String(args[3]).toUpperCase()
  const key = (hive === 'HKCU\\Environment' ? 'HKCU ' : 'HKLM ') + name
  const out = REG_OUT[key]
  if (!out) { const e = new Error('reg: 找不到'); e.status = 1; throw e }
  return out
}

// ------------------------------------------------- 1. 进程环境优先
{
  resetEnvCache()
  const r = envValue('DSH_UI_PROC_NAME', { env: { DSH_UI_PROC_NAME: 'FromProcess' }, exec: fakeExec })
  check('进程环境优先于注册表', r.value === 'FromProcess' && r.source === 'process' && r.inherited === true, JSON.stringify(r))
  check('进程环境命中时不查注册表（note 为空）', r.note === '', JSON.stringify(r.note))
}

// ------------------------------------------------- 2. 进程里没有 → 回退用户级（并标注"没继承"）
{
  resetEnvCache()
  const r = envValue('DSH_UI_PROC_NAME', { env: {}, exec: fakeExec })
  check('进程缺失 → 取用户级值', r.value === 'AcmeClient' && r.source === 'user', JSON.stringify(r))
  check('来源标注 inherited=false（进程未继承）', r.inherited === false)
  check('note 说明"是在进程启动之后设置的"+建议重启宿主', /之后/.test(r.note) && /重启宿主/.test(r.note), r.note.slice(0, 200))
  check('note 不谎报"没配置"', !/不存在|未设置/.test(r.note), r.note.slice(0, 200))
}

// ------------------------------------------------- 3. REG_EXPAND_SZ 展开
{
  resetEnvCache()
  process.env.TESTHOMEDIR = 'C:\\Users\\tester'
  const r = envValue('DSH_UI_CLIENT_EXE', { env: {}, exec: fakeExec })
  check('REG_EXPAND_SZ 里的 %VAR% 按进程环境展开', r.value === 'C:\\Users\\tester\\AcmeClient.exe', r.value)
  delete process.env.TESTHOMEDIR
}

// ------------------------------------------------- 4. 用户级没有 → 机器级；都没有 → missing（绝不编造）
{
  resetEnvCache()
  const r = envValue('DSH_UI_WINDOW_NAME', { env: {}, exec: fakeExec })
  check('两级注册表都没有 → missing 且值为空', r.value === '' && r.source === 'missing', JSON.stringify(r))
  check('missing 时不冒充有值', r.inherited === false)
}

// ------------------------------------------------- 5. 显式空串 = 主动清空，不回退注册表
{
  resetEnvCache()
  const r = envValue('DSH_UI_PROC_NAME', { env: { DSH_UI_PROC_NAME: '' }, exec: fakeExec })
  check('显式空串视为未配置（不回退注册表）', r.value === '' && r.source === 'missing', JSON.stringify(r))
  check('显式空串说明原因（不是"变量不存在"）', /显式设为空串/.test(r.note), r.note)
}

// ------------------------------------------------- 6. 非 Windows / reg 不可用：静默降级，不抛
{
  resetEnvCache()
  const boom = () => { throw new Error('reg.exe 不存在') }
  const r = envValue('DSH_UI_PROC_NAME', { env: {}, exec: boom })
  check('reg 调用失败 → 降级 missing，不抛异常', r.value === '' && r.source === 'missing', JSON.stringify(r))
  resetEnvCache()
  const r2 = envValue('DSH_UI_PROC_NAME', { env: {}, exec: () => '垃圾输出\n不是 REG 行\n' })
  check('输出格式不认识 → missing（不瞎解析）', r2.value === '' && r2.source === 'missing', JSON.stringify(r2))
}

// ------------------------------------------------- 7. unconfiguredHint 区分两种情况（下一步动作不同）
{
  resetEnvCache()
  const h1 = unconfiguredHint(['DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE'], { env: {}, exec: fakeExec })
  check('已配但未继承 → 说"已经配好了"+建议重启宿主', /已经配好了/.test(h1) && /重启宿主/.test(h1), h1.slice(0, 200))
  check('已配但未继承 → 不再教用户"去设置它"', !/请先设置/.test(h1), h1.slice(0, 200))
  resetEnvCache()
  const h2 = unconfiguredHint(['DSH_UI_PROC_NAME'], { env: {}, exec: () => { throw new Error('no') } })
  check('真的没配 → 说清"都不存在"+要给哪个变量', /都不存在/.test(h2) && /DSH_UI_PROC_NAME/.test(h2), h2.slice(0, 200))
}

// ------------------------------------------------- 8. envOr 便利函数与缓存
{
  resetEnvCache()
  check('envOr 返回原始值', envOr('DSH_UI_PROC_NAME', 'fallback', { env: {}, exec: fakeExec }) === 'AcmeClient')
  check('envOr 无值时用 fallback', envOr('DSH_UI_NOPE_X', 'fb', { env: {}, exec: fakeExec }) === 'fb')
  // 缓存：第二次不再调 exec（用会抛的 exec 证明）
  check('结果被缓存（第二次不再查注册表）', envValue('DSH_UI_PROC_NAME', { env: {}, exec: () => { throw new Error('不该再调') } }).value === 'AcmeClient')
  resetEnvCache()
}

// ------------------------------------------------- 9. readRegistryEnv 直测（格式解析）
{
  const v = readRegistryEnv('DSH_UI_PROC_NAME', 'HKCU\\Environment', fakeExec)
  check('readRegistryEnv 解析 REG_SZ', v === 'AcmeClient', String(v))
  check('readRegistryEnv 大小写不敏感', readRegistryEnv('dsH_ui_proc_name', 'HKCU\\Environment', fakeExec) === 'AcmeClient')
  check('readRegistryEnv 缺值 → null', readRegistryEnv('NOPE', 'HKCU\\Environment', fakeExec) === null)
}

// ------------------------------------------------- 10. 测试硬闸 DSH_NO_ENV_FALLBACK=1
// 真实事故（2026-09-11）：env 回退上线后，用 `delete process.env.X` 模拟"未配置"的测试拿到了
// 本机真配好的客户端路径 → `build(killClient=true)` 把用户**正在跑的客户端**杀掉了。
// 因此测试运行器给每个测试进程设这个闸：对机器上真配了什么完全失明。
{
  resetEnvCache()
  const r = envValue('DSH_UI_PROC_NAME', { env: { DSH_NO_ENV_FALLBACK: '1' }, exec: fakeExec })
  check('闸生效：不看注册表（即使注册表里有值）', r.value === '' && r.source === 'missing', JSON.stringify(r))
  check('闸生效时说明原因（不是"变量不存在"）', /DSH_NO_ENV_FALLBACK=1/.test(r.note), r.note)
  const h = unconfiguredHint(['DSH_UI_PROC_NAME'], { env: { DSH_NO_ENV_FALLBACK: '1' }, exec: fakeExec })
  check('闸生效时 hint 说"都不存在"（不会误导成"已配好"）', /都不存在/.test(h), h.slice(0, 160))
  resetEnvCache()
  const r2 = envValue('DSH_UI_PROC_NAME', { env: { DSH_NO_ENV_FALLBACK: '1', DSH_UI_PROC_NAME: 'FromProcess' }, exec: fakeExec })
  check('闸只挡注册表，进程环境里显式给的值照常可用', r2.value === 'FromProcess' && r2.source === 'process', JSON.stringify(r2))
  // 测试运行器必须真的设了它（否则闸等于没装）
  const runner = readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')
  check('run-tests.mjs 给子进程设了硬闸', /DSH_NO_ENV_FALLBACK: '1'/.test(runner))
}

// ------------------------------------------------- 11. 控制台 OEM 代码页解码（中文值必须正确）
// 真机事故：reg.exe 输出按 OEM 代码页编码，按 UTF-8 硬解会把 `示例窗口` 变成乱码 →
// 探针报「未找到主窗口」、exe 路径 existsSync=false。ASCII 值看不出问题，所以必须专门测中文。
{
  // Node 没有 GBK **编码**器（TextDecoder 只能解不能编），所以手工构造字节。
  // '示例窗口' 的 GBK 字节 = CA BE C0 FD B4 B0 BF DA（用 [Text.Encoding]::GetEncoding(936) 核对过）。
  // 断言写成**双向**：① 解出来必须是那串中文；② 必须等于原生 GBK 解码 —— 万一我硬编码的字节写错了，
  // ① 会红；万一解码逻辑退化回"按 UTF-8 硬解"，①② 都红。
  const gbkLine = Buffer.concat([
    Buffer.from('HKEY_CURRENT_USER\\Environment\r\n    DSH_UI_WINDOW_NAME    REG_SZ    ', 'ascii'),
    Buffer.from([0xCA, 0xBE, 0xC0, 0xFD, 0xB4, 0xB0, 0xBF, 0xDA]),
    Buffer.from('\r\n\r\n', 'ascii'),
  ])
  const decoded = decodeConsole(gbkLine)
  check('GBK 字节被正确解码（不再乱码）', decoded.includes('示例窗口'), JSON.stringify(decoded))
  check('解码结果与原生 GBK 解码一致（不是碰巧）', decoded === new TextDecoder('gbk').decode(gbkLine), JSON.stringify(decoded.slice(0, 60)))
  check('ASCII 输出解码不变（零行为变化）', decodeConsole(Buffer.from('    X    REG_SZ    ABC\r\n', 'ascii')).includes('ABC'))
  check('非法 UTF-8 序列不会静默变成替换字符', !decodeConsole(gbkLine).includes('\uFFFD'))
  // 端到端：readRegistryEnv 走同一个解码路径
  const v = readRegistryEnv('DSH_UI_WINDOW_NAME', 'HKCU\\Environment', () => gbkLine)
  check('readRegistryEnv 返回正确中文值', v === '示例窗口', JSON.stringify(v))
}

// ------------------------------------------------- 12. ★ 缓存**按名字**、**不看注入的 env/exec**
// 这条是我在写 `lib/toolchain-status.mjs` 的测试时**被自己的用例抓到的**：
//   第一次用 exec=A 读 → 拿到 A 的值并被缓存；第二次用 exec=B 读 → **直接命中缓存**拿到 A 的值，
//   于是"换了注入也没用"，测试里表现为"明明没配却读到了值"。
// 这不是 bug（缓存按名字设计如此），但它是一个**会让人写出假测试**的坑，
// 所以在这里把它**当成契约钉住**：带注入的调用必须传 `fresh: true`。
{
  resetEnvCache()
  const execA = (file, args) => Buffer.from(
    '    DSH_UI_PROC_NAME    REG_SZ    FromA\r\n', 'ascii')
  const execB = () => { throw new Error('no registry') }

  const a = envValue('DSH_UI_PROC_NAME', { env: {}, exec: execA })
  check('注入 A：读到 A 的值', a.value === 'FromA' && a.source === 'user', JSON.stringify(a))

  // ⚠ 契约：不传 fresh 时**会**命中缓存（按名字）—— 这是设计，不是缺陷，但调用方必须知道。
  const bNoFresh = envValue('DSH_UI_PROC_NAME', { env: {}, exec: execB })
  check('★ 契约：不传 fresh 时缓存命中（换成 exec=B 也仍返回 A 的值）—— 所以带注入的调用必须传 fresh',
    bNoFresh.value === 'FromA', JSON.stringify(bNoFresh))

  const bFresh = envValue('DSH_UI_PROC_NAME', { env: {}, exec: execB, fresh: true })
  check('★★ 传 fresh: true 时**真的**重新读 ⇒ 得到 B 的结论（"没配"），注入才名副其实',
    bFresh.value === '' && bFresh.source === 'missing', JSON.stringify(bFresh))
  resetEnvCache()
}

{
  resetEnvCache()
  const calls = []
  let userValue = 'First'
  const snapshotExec = (file, args) => {
    calls.push([file, ...args])
    return args[1] === 'HKCU\\Environment'
      ? '    SNAP_USER    REG_SZ    ' + userValue + '\r\n    SNAP_SHARED    REG_SZ    User\r\n    SNAP_EMPTY    REG_SZ    RegistryValue\r\n'
      : '    SNAP_MACHINE    REG_SZ    Machine\r\n    SNAP_SHARED    REG_SZ    Machine\r\n'
  }
  const names = ['SNAP_USER', 'SNAP_MACHINE', 'SNAP_SHARED', 'SNAP_PROCESS', 'SNAP_EMPTY', 'SNAP_MISSING']
  const env = { SNAP_PROCESS: 'Process', SNAP_EMPTY: '' }
  const first = envValues(names, { env, exec: snapshotExec, fresh: true })
  check('批量快照每个 hive 最多查询一次，不逐值启动 reg', calls.length === 2 && calls.every((args) => args.length === 3), JSON.stringify(calls))
  check('批量快照保留 process > user > machine 来源', first.SNAP_PROCESS.source === 'process' && first.SNAP_USER.source === 'user' && first.SNAP_MACHINE.source === 'machine' && first.SNAP_SHARED.value === 'User')
  check('批量快照保留显式空串与缺失语义', first.SNAP_EMPTY.value === '' && first.SNAP_EMPTY.inherited === true && first.SNAP_MISSING.source === 'missing')
  userValue = 'Second'
  const second = envValues(names, { env, exec: snapshotExec, fresh: true })
  check('fresh 快照跨调用重新读，不能复用旧结果', second.SNAP_USER.value === 'Second' && calls.length === 4, JSON.stringify(calls))
  const cached = envValues(['SNAP_USER'], { env: {}, exec: () => { throw new Error('must use existing cache') } })
  check('批量 API 未传 fresh 时保留现有缓存契约', cached.SNAP_USER.value === 'Second')
  let disabledCalls = 0
  const disabled = envValues(names, { env: { DSH_NO_ENV_FALLBACK: '1' }, fresh: true, exec: () => { disabledCalls++; return '' } })
  check('批量快照遵守测试硬闸，不查注册表', disabledCalls === 0 && disabled.SNAP_USER.source === 'missing')
  let failedCalls = 0
  const failed = envValues(names, { env: {}, fresh: true, exec: () => { failedCalls++; throw new Error('registry unavailable') } })
  check('失败 hive 在本次快照中不重复外部查询', failedCalls === 2 && failed.SNAP_MACHINE.source === 'missing', String(failedCalls))
  resetEnvCache()
}

console.log(failures === 0 ? '\nPASS: lib/env-fallback 单测' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
