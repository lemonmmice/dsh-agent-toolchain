// dsh-ui-drive UD-05 / UD-06 单测（原 P1 清单第 5、6 条）
//
// UD-05：`ui_live` 的 `frame.path` 一直是**文件名**（相对 live 目录），而工具描述承诺
//        "path 是 latest.png 绝对路径，read_image(frame.path) 即看见当前画面" ——
//        照描述的 agent 会去**当前工作目录**找 latest.png，必然失败。
//        修法：新增 `pathAbs`（可直接喂给 read_image），并且**脱敏名单必须一起更新**
//        （只清 path 而留 pathAbs = 把像素路径换个字段泄漏出去）。
//
// UD-06：`ui_launch` **半成功被当成成功**：进程起了但主窗口没出现时 `started:true`，
//        而"没有窗口"只写在 `warning` 里；旧渲染在 started 分支**根本不打印 warning** ——
//        agent 看到"已启动 pid=… 窗口=null"，接着去用别的 ui_* 工具，全部失败却不知原因。
import { sanitizeLive, framePathText, launchText, renderLive } from '../lib/render.mjs'
let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ------------------------------------------------- 1. UD-05 帧路径
{
  const frame = { seq: 7, hash: 'abcdef012345', w: 2560, h: 1184, path: 'latest.png', pathAbs: 'D:\\ui-live\\latest.png' }
  const t = framePathText(frame)
  check('UD-05 印绝对路径（可直接 read_image）', t.includes(frame.pathAbs), t)
  check('UD-05 明说 path 只是文件名', /frame\.path 只是文件名/.test(t), t)
  check('UD-05 保留尺寸信息', /2560x1184/.test(t), t)

  // 老记录/别的路径没 pathAbs 时：绝不能把文件名说成绝对路径
  const legacy = framePathText({ seq: 1, path: 'latest.png' })
  check('UD-05 没有 pathAbs 时明说"这不是绝对路径"', /不是绝对路径/.test(legacy) && !/可直接 read_image/.test(legacy), legacy)
  check('UD-05 无路径时返回空串（不编一个）', framePathText({ seq: 1 }) === '' && framePathText(null) === '', JSON.stringify(framePathText({ seq: 1 })))

  const okSnap = { live: { running: true, frameCount: 3, intervalMs: 1500 }, client: { pid: 123, window: 'W' }, frame, dir: 'D:\\x' }
  const okText = renderLive(okSnap)
  check('UD-05 renderLive 印的是绝对路径', okText.includes(frame.pathAbs), okText.slice(0, 220))
  check('UD-05 renderLive 不再声称 path 可直接读', !/read_image\(frame\.path\)/.test(okText), okText.slice(0, 220))

  // 敏感帧脱敏：path 与 pathAbs **必须一起置空**
  const sens = sanitizeLive({ ...okSnap, frame: { ...frame, secretFocused: true } }, false)
  check('UD-05 敏感帧：path 置空', sens.frame.path === null, JSON.stringify(sens.frame))
  check('UD-05 敏感帧：pathAbs 也必须置空（否则像素路径换个字段泄漏）', sens.frame.pathAbs === null, JSON.stringify(sens.frame))
  check('UD-05 敏感帧：带 sensitiveBlocked 标记', sens.frame.sensitiveBlocked === true, JSON.stringify(sens.frame))
  const sensText = renderLive(sens)
  check('UD-05 敏感帧渲染里不出现任何 png 路径', !/latest\.png|ui-live/.test(sensText), sensText.slice(0, 220))
  const allowed = sanitizeLive({ ...okSnap, frame: { ...frame, secretFocused: true } }, true)
  check('UD-05 allowSensitive=true 时放行（显式解锁）', allowed.frame.pathAbs === frame.pathAbs, JSON.stringify(allowed.frame))
  check('UD-05 非敏感帧不受影响（零回归）', sanitizeLive(okSnap, false) === okSnap)
}

// ------------------------------------------------- 2. UD-06 启动半成功
{
  check('UD-06 正常启动 → 说"已启动"', /^已启动 pid=42 窗口=W/.test(launchText({ ok: true, started: true, pid: 42, title: 'W' })), launchText({ ok: true, started: true, pid: 42, title: 'W' }))
  check('UD-06 已在运行 → 说"已在运行"', /已在运行/.test(launchText({ ok: true, alreadyRunning: true, pid: 42, title: 'W' })), launchText({ ok: true, alreadyRunning: true, pid: 42, title: 'W' }))

  const half = { ok: false, windowReady: false, partial: true, started: true, pid: 99, title: null, waitedMs: 60000, warning: '进程已起但主窗口超时未出现', hint: '进程在跑但没有可用的主窗口：不要当成启动成功' }
  const t = launchText(half)
  check('UD-06 半成功**不再**渲染成"已启动"', !/^已启动/.test(t), t.slice(0, 160))
  check('UD-06 半成功显式标「半成功」', /半成功/.test(t), t.slice(0, 160))
  check('UD-06 半成功带 pid 与等待时长（可判断发生了什么）', /pid=99/.test(t) && /60000ms/.test(t), t.slice(0, 220))
  check('UD-06 半成功给出下一步（hint 不再被丢掉）', /不要当成启动成功/.test(t), t.slice(0, 260))

  const fail = { ok: false, started: false, partial: false, error: '', warning: '启动超时', hint: '先 ui_status 看是否已在运行' }
  const tf = launchText(fail)
  check('UD-06 真失败：印出 warning（error 为空时）', /启动超时/.test(tf), tf)
  check('UD-06 真失败：印出 hint', /ui_status/.test(tf), tf)
  check('UD-06 空结果不抛', typeof launchText(null) === 'string' && typeof launchText(undefined) === 'string')

  // Claude 第八轮 Q3：hint 不能再劝"重发 ui_launch"（进程已存在时会拉起第二个实例）
  const half2 = { ok: false, partial: true, started: false, alreadyRunning: true, pid: 5, waitedMs: 0, hint: '进程已经在运行（pid=5）但主窗口还没出现：**不会重复拉起第二个实例**。下一步：ui_status / ui_windows 看窗口列表与状态。' }
  const t2 = launchText(half2)
  check('Q3 半成功的下一步指向只读观测（ui_status/ui_windows）', /ui_status|ui_windows/.test(t2), t2.slice(0, 320))
  check('Q3 半成功明说不会重复拉起第二个实例', /不会重复拉起第二个实例/.test(t2), t2.slice(0, 320))
}

// ------------------------------------------------- 2b. Claude 第八轮 Q2：脱敏不能留下可重组的字段
{
  const leak = sanitizeLive({ dir: 'D:\\live', frame: { seq: 1, secretFocused: true, path: 'latest.png', pathAbs: 'D:\\live\\latest.png', file: 'latest.png' } }, false)
  check('Q2 敏感帧：file 与 dir 一起清（否则 join(dir,file) 正好重组出被清掉的 pathAbs）',
    leak.frame.file === null && leak.dir === null, JSON.stringify(leak).slice(0, 240))
  check('Q2 敏感帧：四个路径字段全为 null，重组不出任何路径',
    !leak.frame.path && !leak.frame.pathAbs && !leak.frame.file && !leak.dir, JSON.stringify(leak).slice(0, 240))
  check('Q2 敏感帧：带 sensitiveBlocked 标记（消费方可判"是被脱敏了，不是没有帧"）', leak.frame.sensitiveBlocked === true, JSON.stringify(leak.frame).slice(0, 200))
  const okFrame = sanitizeLive({ dir: 'D:\\live', frame: { seq: 1, secretFocused: false, path: 'latest.png', pathAbs: 'D:\\live\\latest.png' } }, false)
  check('Q2 非敏感帧不受影响（dir 保留，零回归）', okFrame.dir === 'D:\\live', JSON.stringify(okFrame).slice(0, 160))
  check('Q2 allowSensitive=true 时放行（显式解锁仍是唯一出口）', sanitizeLive({ dir: 'D:\\live', frame: { secretFocused: true, pathAbs: 'D:\\live\\latest.png' } }, true).frame.pathAbs === 'D:\\live\\latest.png')
}

// ------------------------------------------------- 3. renderLive 的 wait 分支同样给绝对路径
{
  const wait = { ok: true, changed: true, seq: 9, hash: 'f'.repeat(32), waitedMs: 1200, snapshot: { live: { running: true, frameCount: 9 }, frame: { seq: 9, path: 'latest.png', pathAbs: 'D:\\live\\latest.png' } } }
  const t = renderLive(wait)
  check('UD-05 wait 分支印绝对路径', t.includes('D:\\live\\latest.png'), t.slice(0, 240))
  check('UD-05 wait 分支保留变化信息', /已变化/.test(t) && /1200ms/.test(t), t.slice(0, 240))
  check('renderLive 对 null / 无 error 的对象不抛', typeof renderLive(null) === 'string' && typeof renderLive({}) === 'string')
}

console.log(failures === 0 ? '\nPASS: ui-drive UD-05/UD-06（帧绝对路径 + 启动半成功诚实性）' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
