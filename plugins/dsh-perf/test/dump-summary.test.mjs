// dsh-perf 单测：dump 归纳（summarizeDump）—— F-011 与证据链健康度
//
// 两个真机实测踩出来的点：
//   F-011：DumpStack 会吐出 type/method/module **全为空**、只有 ip 的帧（原生/未解析帧）。
//          旧写法把它们拼成空字符串 → 栈里出现一行莫名奇妙的空白，看起来像渲染故障。
//   F-009 诚实面：一个帧都没映射到源码时，输出必须**明确说"这不是代码证据"**，
//          而不是给出一串看起来很像证据的 `模块!类型.方法` 就完事。
import { summarizeDump } from '../lib/perf.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 假 srcMap：可控制"命中/未命中/不可用"三种情形，避免测试依赖真实仓库
const fakeMap = (resolve) => ({
  mapFrames: (frames) => frames.map((f) => ({ ...f, src: resolve(f) })),
  status: () => ({ usable: true, srcRoot: 'C:/src', typesResolved: 1, typesMissed: 2 }),
})

const DUMP = {
  dump: 'client.dmp',
  threads: [
    { managedId: 1, osId: 100, uiLikely: true, lockCount: 0, frames: [
      { type: '', method: '', module: '', ip: '7670106C' },                       // 未解析帧
      { type: 'App.MainWindow', method: 'OnLoaded', module: 'Client.dll' },        // 可映射
      { type: 'App.Broken', method: 'Stuck', module: 'Client.dll' },               // 不可映射
    ] },
    { managedId: 12, osId: 200, uiLikely: false, lockCount: 3, frames: [
      { type: 'System.Threading.Monitor', method: 'Wait', module: 'mscorlib.dll' },
    ] },
  ],
}

// ------------------------------------------------- 1. F-011：未解析帧不得渲染成空行
{
  const out = summarizeDump(DUMP, fakeMap(() => null))
  const stack = out.uiThread.stack
  check('F-011：未解析帧被显式标注', /^\[未解析帧 ip=7670106C\]$/.test(stack[0]), JSON.stringify(stack[0]))
  check('F-011：栈里没有空行', stack.every((l) => l.trim() !== ''), JSON.stringify(stack))
  check('F-011：srcMap.framesUnresolved 如实计数', out.srcMap.framesUnresolved === 1, JSON.stringify(out.srcMap))
  check('正常帧仍按 模块!类型.方法 渲染', stack[1] === 'Client.dll!App.MainWindow.OnLoaded', JSON.stringify(stack[1]))
}

// ------------------------------------------------- 2. 命中：帧上带 文件:行号 + "方法声明"限定词
{
  const out = summarizeDump(DUMP, fakeMap((f) => (f.method === 'OnLoaded'
    ? { file: 'Client/App/MainWindow.xaml.cs', line: 42, where: 'method', text: 'public void OnLoaded()', candidates: 1 }
    : null)))
  const s = out.uiThread.stack[1]
  check('命中帧带 ← 文件:行号', /← Client\/App\/MainWindow\.xaml\.cs:42/.test(s), s)
  check('命中帧标注"方法声明"（不许看起来像精确执行行）', /\(方法声明\)/.test(s), s)
  check('未命中帧不编造行号', !/←/.test(out.uiThread.stack[2]), out.uiThread.stack[2])
  check('srcMap.framesResolved 如实计数', out.srcMap.framesResolved === 1, JSON.stringify(out.srcMap))
}

// ------------------------------------------------- 3. 一个都没命中 → 必须自曝"不是代码证据"
{
  const out = summarizeDump(DUMP, fakeMap(() => null))
  check('0 命中时 framesResolved=0（供渲染层报警）', out.srcMap.framesResolved === 0, JSON.stringify(out.srcMap.framesResolved))
  check('0 命中时 note 仍在（解释原因）', typeof out.srcMap.note === 'string' && out.srcMap.note.length > 0, out.srcMap.note)
  check('note 解释"框架类型未命中属正常"', /框架\/系统类型/.test(out.srcMap.note), out.srcMap.note)
}

// ------------------------------------------------- 4. 没有 srcMap（未配源根）也不能炸、且如实标注
{
  const out = summarizeDump(DUMP, null)
  check('无 srcMap 不炸且 src 全为 null', out.uiThread.frames.every((f) => f.src === null), '')
  check('无 srcMap 时 usable=false', out.srcMap.usable === false, JSON.stringify(out.srcMap))
  check('无 srcMap 时 note 指向缺失的源根配置', /DSH_PERF_SRC_ROOT/.test(out.srcMap.note), out.srcMap.note)
}

// ------------------------------------------------- 5. 坏输入
{
  const out = summarizeDump({}, null)
  check('空 data 不炸', out.threadCount === 0 && out.uiThread === null, JSON.stringify({ t: out.threadCount, u: out.uiThread }))
  const out2 = summarizeDump(null, null)
  check('null data 不炸', out2.threadCount === 0, JSON.stringify(out2.threadCount))
  const out3 = summarizeDump({ threads: [{ managedId: 1, uiLikely: true }] }, null)
  check('uiThread 无 frames 字段时不炸', out3.uiThread && out3.uiThread.stack.length === 0, JSON.stringify(out3.uiThread))
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-perf dump-summary（F-011 + 证据链健康度）')
process.exit(failures ? 1 : 0)
