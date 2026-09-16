/**
 * W4 —— 后台构建执行器（分离子进程入口）。见 builder.mjs 的 startBackground()。
 *
 * 被 `spawn(process.execPath, [此文件, markerPath], {detached:true})` 拉起。职责：
 *   1) 读标记文件拿到 build() 的入参（opts）与 builder 配置（cfg）；
 *   2) 把自己的 pid 写回标记（好让 build_status 判活 / 识别 crashed）；
 *   3) 用**同一个** makeBuilder().build() 跑真正的构建（逻辑零改动）；
 *   4) 把结果写回标记（state=done/failed + result），失败也要落盘。
 *
 * 铁律：**任何异常都必须落到标记文件**，绝不能静默退出 —— 否则 build_status 只能看到
 * 「进程没了、也没结果」= crashed，虽然诚实但丢了原因。所以这里把错误写进 marker.error。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { makeBuilder } from './builder.mjs'

const markerPath = process.argv[2]

function patchMarker(patch) {
  let m = {}
  try { m = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { /* 读不出就以空对象为底，至少把状态写下去 */ }
  const next = { ...m, ...patch }
  try { writeFileSync(markerPath, JSON.stringify(next, null, 2), 'utf8') } catch { /* 写不出也没别的手段了 */ }
  return next
}

async function main() {
  if (!markerPath) { process.exit(2); return }
  let marker
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch (e) {
    // 连标记都读不出：没有 opts 就没法构建，直接退出（父进程会把它当 crashed）。
    process.exit(2); return
  }
  // 记录 pid：build_status 用它判活（进程没了却仍 running ⇒ crashed）。
  patchMarker({ pid: process.pid })
  try {
    const builder = makeBuilder(marker.cfg || {})
    const result = await builder.build(marker.buildOpts || {})
    patchMarker({
      state: result.ok ? 'done' : 'failed',
      finishedAt: new Date().toISOString(),
      result,
    })
    process.exit(0)
  } catch (e) {
    patchMarker({
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: '后台构建执行异常：' + (e && e.stack ? e.stack : String(e)),
    })
    process.exit(1)
  }
}

main()
