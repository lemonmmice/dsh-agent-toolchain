// dsh-perf srcmap 单测：`类型.方法` → 源码「文件:行号」
//
// 夹具是**临时新建的 git 仓库**（不是本机某个真实仓库），所以这个测试在哪台机器上都能跑，
// 也顺带钉住一条设计约束：**找不到就返回 null，绝不猜行号**。
//
// 背景（F-009）：这套工具链声称能把卡死的线程栈"映射到项目源码展示代码问题"，
// 但实测发现帧里只有 `模块!类型.方法`，唯一做定位的 locateType 是死代码、
// 且写了 `git grep -n -l`（`-l` 只列文件名，把行号丢了）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeSrcMap, simpleName } from '../lib/srcmap.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-perf-srcmap-'))
const repo = join(TMP, 'repo')
mkdirSync(join(repo, 'src'), { recursive: true })

// 夹具 1：一个文件里放**两个类**（真实客户端常见），用来验证方法查找不会指错类
writeFileSync(join(repo, 'src', 'Two.cs'), [
  'namespace Demo {',
  '  // 第 3 行：无关的类，故意让方法名与目标类的方法**重名**',
  '  public class Decoy {',
  '    public void OnTick() { }',
  '  }',
  '',
  '  // 第 7 行起：真正的目标类',
  '  public class RealViewModel {',
  '    public RealViewModel() { }',
  '    public void OnTick() { }',
  '    public void OnlyHere() { }',
  '  }',
  '}',
].join('\n'), 'utf8')

// 夹具 2：泛型类 + 另一个普通类
writeFileSync(join(repo, 'src', 'Base.cs'), [
  'namespace Demo {',
  '  public abstract class GridBase<TParent, TEntity> : object {',
  '    protected abstract void OnDoubleClick(object o);',
  '    public void Refresh() { }',
  '  }',
  '}',
].join('\n'), 'utf8')

execFileSync('git', ['-C', repo, 'init', '-q'], { windowsHide: true })
execFileSync('git', ['-C', repo, 'add', '-A'], { windowsHide: true })
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { windowsHide: true })

const sm = makeSrcMap({ srcRoot: repo })

// ------------------------------------------------- 1. simpleName：泛型/嵌套
{
  check('simpleName 取最后一段', simpleName('A.B.C.D') === 'D', simpleName('A.B.C.D'))
  check('simpleName 去反引号泛型后缀', simpleName('Demo.GridBase`2') === 'GridBase', simpleName('Demo.GridBase`2'))
  check('simpleName 空值安全', simpleName('') === '' && simpleName(null) === '', JSON.stringify([simpleName(''), simpleName(null)]))
}

// ------------------------------------------------- 2. 类型 → 文件:声明行（含泛型）
{
  const r = sm.mapFrames([
    { type: 'Demo.RealViewModel', method: 'OnlyHere', module: 'Demo.dll' },
    { type: 'Demo.GridBase`2', method: 'Refresh', module: 'Demo.dll' },
  ])
  check('F-009：类型命中并给出文件', r[0].src && /Two\.cs$/.test(r[0].src.file), JSON.stringify(r[0].src))
  check('F-009：给出**行号**（旧实现被 -l 丢掉的东西）', r[0].src && r[0].src.line === 11, JSON.stringify(r[0].src))
  check('泛型类型能被命中', r[1].src && /Base\.cs$/.test(r[1].src.file), JSON.stringify(r[1].src))
  // 注意：这里要的是**方法** Refresh 的行（第 4 行），不是类声明行（第 2 行）——
  // 能定位到方法就比只给类更好；写这条断言时我自己先写错成 2，被测试本身抓了出来。
  check('泛型类的方法行号正确（不是类声明行）', r[1].src && r[1].src.line === 4 && r[1].src.where === 'method', JSON.stringify(r[1].src))
  check('标注 where=method（而非只给类型）', r[0].src && r[0].src.where === 'method', JSON.stringify(r[0].src))
}

// ------------------------------------------------- 3. 关键正确性：不指错类
{
  const r = sm.mapFrames([{ type: 'Demo.RealViewModel', method: 'OnTick', module: 'Demo.dll' }])
  // Decoy.OnTick 在第 4 行、RealViewModel.OnTick 在第 10 行 —— 必须取后者
  check('同名方法不指到前面那个类', r[0].src && r[0].src.line === 10, JSON.stringify(r[0].src))
}

// ------------------------------------------------- 4. 找不到就诚实返回 null（绝不猜）
{
  const r = sm.mapFrames([
    { type: 'Demo.NoSuchType', method: 'Foo', module: 'Demo.dll' },
    { type: 'Demo.RealViewModel', method: 'NoSuchMethod', module: 'Demo.dll' },
  ])
  check('类型不存在 → src=null（不猜）', r[0].src === null, JSON.stringify(r[0].src))
  check('方法不存在时回落**类型声明**行，并标明 where=type', r[1].src && r[1].src.where === 'type' && r[1].src.line === 8,
    JSON.stringify(r[1].src))
}

// ------------------------------------------------- 5. 未配置源根 / 源根无效 → 全部 null，且 status 如实
{
  const none = makeSrcMap({ srcRoot: '' })
  const r = none.mapFrames([{ type: 'Demo.RealViewModel', method: 'OnTick' }])
  check('无源根 → src=null（不编造）', r[0].src === null, JSON.stringify(r[0].src))
  check('无源根 → status.usable=false', none.status().usable === false, JSON.stringify(none.status()))

  const bad = makeSrcMap({ srcRoot: join(TMP, 'does-not-exist') })
  check('源根不存在 → usable=false 且不抛异常', bad.status().usable === false, JSON.stringify(bad.status()))
  check('源根不存在时 mapFrames 仍返回原帧', bad.mapFrames([{ type: 'X.Y', method: 'Z' }])[0].src === null, '')
}

// ------------------------------------------------- 6. 非 git 目录不炸（git grep 会失败）
{
  const plain = join(TMP, 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'A.cs'), 'public class Foo { public void Bar() {} }', 'utf8')
  const smp = makeSrcMap({ srcRoot: plain })
  const r = smp.mapFrames([{ type: 'Foo', method: 'Bar' }])
  check('非 git 目录：不抛异常，src=null 或命中其一（如实）', r.length === 1, JSON.stringify(r))
}

// ------------------------------------------------- 7. 坏输入不炸
{
  const r = sm.mapFrames([null, {}, { type: null, method: null }])
  check('null/空帧不炸且保留形状', r.length === 3 && r[0].src === null && r[1].src === null, JSON.stringify(r.map((x) => x && x.src)))
  check('mapFrames(非数组) 不炸', Array.isArray(sm.mapFrames(undefined)) && sm.mapFrames(undefined).length === 0, '')
}

// ------------------------------------------------- 8. UD-01：Claude 第三轮给的两个客户端真实反例
//
// 反例A（同名类跨文件 + 方法重名 → 旧实现**静默指错**）：
//   客户端里 `ResourceHelper.GetColor` 在 3 个策略文件里**逐字节相同**。
//   旧实现的方法路径**不带 duplicates**，于是返回一个满分自信的 file:line，
//   agent 完全不知道还有别的候选文件，真凶在另一个文件时就被送错了。
// 反例B（partial class）：
//   一个类 split 到多个文件时，旧实现只搜**首个**文件 → 方法在兄弟 partial 里命不中 →
//   退回错片段的类声明行。
{
  const repo2 = join(TMP, 'repo2')
  mkdirSync(join(repo2, 'src'), { recursive: true })
  // 反例A：两个文件里有逐字节相同的同名类与同名方法
  writeFileSync(join(repo2, 'src', 'StrategyA.cs'), [
    'namespace Demo {',
    '  internal static class ResourceHelper {',
    '    public static string GetColor(string k) { return "A"; }',
    '  }',
    '}',
  ].join('\n'), 'utf8')
  writeFileSync(join(repo2, 'src', 'StrategyB.cs'), [
    'namespace Demo {',
    '  internal static class ResourceHelper {',
    '    public static string GetColor(string k) { return "B"; }',
    '  }',
    '}',
  ].join('\n'), 'utf8')
  // 反例B：partial class 的**方法只写在第二个文件里**
  writeFileSync(join(repo2, 'src', 'Loop.Part1.cs'), [
    'namespace Demo {',
    '  public partial class Loop {',
    '    public void OnlyInPart1() { }',
    '  }',
    '}',
  ].join('\n'), 'utf8')
  writeFileSync(join(repo2, 'src', 'Loop.Part2.cs'), [
    'namespace Demo {',
    '  public partial class Loop {',
    '    public void OnlyInPart2() { }',
    '  }',
    '}',
  ].join('\n'), 'utf8')
  execFileSync('git', ['-C', repo2, 'init', '-q'], { windowsHide: true })
  execFileSync('git', ['-C', repo2, 'add', '-A'], { windowsHide: true })
  execFileSync('git', ['-C', repo2, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { windowsHide: true })

  const sm2 = makeSrcMap({ srcRoot: repo2 })

  // 反例A：方法路径必须带 duplicates，并列出全部候选文件
  const a = sm2.mapFrames([{ type: 'Demo.ResourceHelper', method: 'GetColor', module: 'D.dll' }])
  check('UD-01/A 同名类的方法路径带 duplicates（旧实现不带 → 静默指错）', a[0].src && a[0].src.duplicates === 1, JSON.stringify(a[0].src))
  check('UD-01/A 列出全部候选文件（不是只给首个）', a[0].src && Array.isArray(a[0].src.typeFiles) && a[0].src.typeFiles.length === 2, JSON.stringify(a[0].src && a[0].src.typeFiles))
  check('UD-01/A 候选文件里两个都在', a[0].src && /StrategyA\.cs/.test(a[0].src.typeFiles.join(',')) && /StrategyB\.cs/.test(a[0].src.typeFiles.join(',')), JSON.stringify(a[0].src && a[0].src.typeFiles))
  check('UD-01/A 仍给出一个确定位置（首个，且标注了歧义）', a[0].src && a[0].src.where === 'method' && a[0].src.line > 0, JSON.stringify(a[0].src))

  // 反例B：方法在兄弟 partial 里也必须能找到
  const b1 = sm2.mapFrames([{ type: 'Demo.Loop', method: 'OnlyInPart1', module: 'D.dll' }])
  const b2 = sm2.mapFrames([{ type: 'Demo.Loop', method: 'OnlyInPart2', module: 'D.dll' }])
  check('UD-01/B part1 里的方法命中 part1', b1[0].src && /Loop\.Part1\.cs$/.test(b1[0].src.file) && b1[0].src.where === 'method', JSON.stringify(b1[0].src))
  check('UD-01/B **兄弟 partial 里的方法也能命中**（旧实现只搜首个文件 → 命不中）', b2[0].src && /Loop\.Part2\.cs$/.test(b2[0].src.file) && b2[0].src.where === 'method', JSON.stringify(b2[0].src))
  check('UD-01/B partial 场景标注了"多处声明"', b2[0].src && b2[0].src.duplicates === 1, JSON.stringify(b2[0].src && b2[0].src.duplicates))

  // UD-01 勘误（Claude 第四轮）：第一版把 *.py 列进允许集，于是一个 .py 工具脚本里的同名类
  // 会把 duplicates 从 2 推到 3 —— 注释却说"排除非源码文件"。现在默认只认 CLR 家族（.cs/.vb/.fs）。
  writeFileSync(join(repo2, 'src', 'gen.py'), [
    'class ResourceHelper:',
    '    def GetColor(self, k): return "py"',
  ].join('\n'), 'utf8')
  execFileSync('git', ['-C', repo2, 'add', '-A'], { windowsHide: true })
  execFileSync('git', ['-C', repo2, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'py'], { windowsHide: true })
  const sm3 = makeSrcMap({ srcRoot: repo2 })
  const c = sm3.mapFrames([{ type: 'Demo.ResourceHelper', method: 'GetColor', module: 'D.dll' }])
  check('UD-01 勘误 .py 同名类**不再**进候选池（duplicates 仍为 1，不是 2）', c[0].src && c[0].src.duplicates === 1, JSON.stringify(c[0].src && { d: c[0].src.duplicates, f: c[0].src.typeFiles }))
  check('UD-01 勘误 候选文件里没有 .py', c[0].src && !/\.py$/.test((c[0].src.typeFiles || []).join(',')), JSON.stringify(c[0].src && c[0].src.typeFiles))
}

rmSync(TMP, { recursive: true, force: true })

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-perf srcmap（F-009：类型.方法 → 文件:行号）')
process.exit(failures ? 1 : 0)
