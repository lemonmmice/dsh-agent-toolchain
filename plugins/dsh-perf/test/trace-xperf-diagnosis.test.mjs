// dsh-perf trace：**xperf 失败时的定向诊断**（F-027，2026-09-12 r29 真机端到端时查出）。
//
// 实测（真机、受控受害者、ETW 采集 10 秒）：xperf 因 **ETW 丢事件**失败，打印
//   `6728 Events were lost in this trace. … insufficient disk bandwidth for ETW logging.`
// 并以 0x80070030（ERROR_BUFFER_OVERFLOW）退出，**报告文件 0 字节**。
// 旧实现只给通用提示（"可能：符号未解析 / focus 太严 / xperf 输出为空"）—— **把用户引向符号**，
// 而真因是缓冲区/磁盘带宽。**错误信息把人引向错误的位置，比不给信息更糟。**
import { diagnoseXperfFailure } from '../lib/trace.mjs'

let failures = 0
const ok = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

// 真机原文（照抄，含制表符与换行）
const REAL_LOST = '\t\t6728 Events were lost in this trace.  Data may be unreliable.\r\n'
  + '\t\tThis is usually caused by insufficient disk bandwidth for ETW logging.\r\n'
  + '\t\tPlease try increasing the minimum and maximum number of buffers and/or\r\n'
  + '\t\tthe buffer size.  Doubling these values would be a good first attempt.\r\n'

{
  const d = diagnoseXperfFailure(-2147023504, REAL_LOST, 0)
  ok('★ 认出"丢事件"并解析出条数', d.eventsLost === 6728, JSON.stringify(d.eventsLost))
  ok('★ 退出码如实带出', d.exitCode === -2147023504, String(d.exitCode))
  ok('★ 诊断指明是 ETW 丢事件/磁盘带宽，并**明确排除符号**',
    /丢事件/.test(d.diagnosis) && /不是.*符号问题|不是\*\*符号|这不是\*\*符号问题/.test(d.diagnosis),
    String(d.diagnosis).slice(0, 160))
  ok('★ 给出可执行的下一步（缩短时长/减少磁盘写入/加大缓冲区/重采）',
    /缩短采集时长/.test(d.diagnosis) && /重采/.test(d.diagnosis), String(d.diagnosis).slice(0, 220))
  ok('原文尾部保留（可自行核对，不被我的转述吞掉）', /Events were lost/.test(d.tail), d.tail.slice(0, 100))
}

{
  const d = diagnoseXperfFailure(1, 'some other xperf failure text', 0)
  ok('非 0 退出且无丢事件时：给退出码 + 0 字节 + "别默认是符号问题"',
    d.eventsLost === null && /退出码 1/.test(d.diagnosis) && /不要默认是符号问题/.test(d.diagnosis),
    String(d.diagnosis).slice(0, 180))
  ok('这种情况不编造"丢事件"', !/丢事件/.test(d.diagnosis), String(d.diagnosis).slice(0, 120))
}

{
  const d = diagnoseXperfFailure(0, '', 0)
  ok('退出码 0 但报告 0 字节：仍要点明"0 字节报告"', /0 字节报告/.test(d.diagnosis), String(d.diagnosis).slice(0, 160))
}

{
  const d = diagnoseXperfFailure(0, 'normal output', 4096)
  ok('正常情形不给诊断（不刷噪音）', d.diagnosis === null, String(d.diagnosis))
}

{
  const d = diagnoseXperfFailure(undefined, null, null)
  ok('输入为 null/undefined 不炸', typeof d.tail === 'string' && d.exitCode === null, JSON.stringify(d).slice(0, 120))
}

if (failures > 0) {
  console.error(`\nXPERF-DIAGNOSIS TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nXPERF-DIAGNOSIS TEST PASSED')
