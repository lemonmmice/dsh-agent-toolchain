// Stop 收尾裁决闸门的离线自测：node lib/stop-gate.test.mjs
// 会话记录按 Claude Code 的真实 JSONL 结构构造（type / message.content / tool_use / tool_result / isMeta / isSidechain）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseClaudeTurn, decideStop, gateConfig, runStopGate } from './stop-gate.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

let seq = 0
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text }, uuid: 'u' + seq++ })
const meta = (text) => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] }, uuid: 'm' + seq++ })
const use = (name, input, id = 'toolu_' + seq++, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra })
const result = (id, payload, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) }], ...extra }] } })
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
const block = { mode: 'block', ignore: gateConfig({}).ignore }
const decide = (entries, input = {}, config = block) => decideStop({ input, turn: parseClaudeTurn(jsonl(entries)), config })

// ① 改了代码、没裁决 → 拦一次
let d = decide([prompt('修个 bug'), use('Edit', { file_path: 'C:\\repo\\src\\a.mjs' }), use('Write', { file_path: '/repo/src/b.cs' }), say('改好了')])
ok(d && d.decision === 'block' && /2 个文件/.test(d.reason) && /verify_report/.test(d.reason), '改了 2 个代码文件、没调 verify_report → block')
ok(/a\.mjs/.test(d.reason) && !/C:\\repo/.test(d.reason), '原因里列文件名（不带完整路径）')

// ② 已经拦过一次（stop_hook_active）→ 放行，但告诉用户
d = decide([prompt('修个 bug'), use('Edit', { file_path: '/r/a.mjs' }), say('需要你确认一下')], { stop_hook_active: true })
ok(d && !d.decision && /已提醒过一次/.test(d.systemMessage), 'stop_hook_active → 放行 + 用户可见提示（不会无限拦）')

// ③ 裁决过且 pass → 静默放行
let id = 'toolu_v1'
d = decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }), use('mcp__dsh-agent-toolchain__verify_report', { runId: 'r1' }, id), result(id, { verdict: 'pass', counts: { pass: 2, fail: 0, unverified: 0 } })])
ok(d === null, 'verify_report=pass → 静默放行')

// ④ 裁决过但 fail → 放行，把机器裁决原样告诉用户（插件命名空间的工具名也认）
id = 'toolu_v2'
d = decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }), use('mcp__plugin_dsh-agent-toolchain_dsh__verify_report', {}, id), result(id, { verdict: 'fail', counts: { pass: 1, fail: 1, unverified: 0 }, reportPath: '/tmp/r.json' })])
ok(d && !d.decision && /verify_report = fail/.test(d.systemMessage) && /fail 1/.test(d.systemMessage) && /\/tmp\/r\.json/.test(d.systemMessage), 'verify_report=fail → 放行 + systemMessage 带裁决、计数、报告路径（插件前缀工具名）')

// ⑤ 调用被拒（is_error、非 JSON）
id = 'toolu_v3'
d = decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }), use('mcp__dsh-agent-toolchain__verify_report', {}, id), result(id, 'verify_report rejected: runId and task are required', { is_error: true })])
ok(d && /调用被拒绝/.test(d.systemMessage), 'verify_report 被拒 → 如实告诉用户')

// ⑥ 只改了文档 / 配置目录 → 不拦
ok(decide([prompt('x'), use('Write', { file_path: '/r/README.md' }), use('Edit', { file_path: 'C:\\Users\\me\\.claude\\settings.json' })]) === null, '只改 .md 与 .claude 目录 → 不拦')

// ⑦ 只看**本回合**：上一回合的改动不算
ok(decide([prompt('上一轮'), use('Edit', { file_path: '/r/a.mjs' }), say('done'), prompt('这一轮只问问题'), say('答案')]) === null, '上一回合的改动不计入本回合')

// ⑧ 子 agent（sidechain）的调用不算；meta 消息不切回合
ok(decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }, 'toolu_s', { isSidechain: true })]) === null, 'sidechain 的改动不计入')
d = decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }), meta('<system-reminder>…</system-reminder>'), say('ok')])
ok(d && d.decision === 'block', 'isMeta 消息不会把回合切断')

// ⑨ 模式
ok(decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' })], {}, { ...block, mode: 'warn' })?.systemMessage !== undefined, 'warn 模式：只提醒不拦')
ok(decide([prompt('x'), use('Edit', { file_path: '/r/a.mjs' })], {}, { ...block, mode: 'off' }) === null, 'off 模式：静默')
ok(gateConfig({ DSH_STOP_GATE: 'WARN' }).mode === 'warn' && gateConfig({ DSH_STOP_GATE: 'bogus' }).mode === 'block', '配置：大小写不敏感，未知值回到默认 block')
ok(gateConfig({ DSH_STOP_GATE_IGNORE: '\\.cs$' }).ignore.test('x.cs') && gateConfig({ DSH_STOP_GATE_IGNORE: '(' }).ignore.test('a.md'), '自定义忽略正则；坏正则回到默认')

// ⑩ 失败放行：Codex 输入 / 读不到 / 认不出 / 坏 JSON
ok(runStopGate(JSON.stringify({ turn_id: 't1', transcript_path: '/x' }), {}) === null, 'Codex 会话记录读不到 → 放行')
ok(runStopGate(JSON.stringify({ transcript_path: '/definitely/missing.jsonl' }), {}) === null, '会话记录读不到 → 放行')
ok(runStopGate(JSON.stringify({ transcript_path: 'x' }), {}, { readTranscript: () => '{"foo":1}\nnot json\n' }) === null, '不像 Claude 会话记录 → 放行')
ok(runStopGate('{坏', {}) === null, 'stdin 不是 JSON → 放行')

// ⑪ 钩子入口脚本：真进程、真 stdin/stdout
const tmp = mkdtempSync(join(tmpdir(), 'stop-gate-'))
try {
  const transcript = join(tmp, 't.jsonl')
  writeFileSync(transcript, jsonl([prompt('x'), use('Edit', { file_path: '/r/a.mjs' }), say('好了')]), 'utf8')
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'stop-gate.mjs')
  const env = { ...process.env }
  delete env.DSH_STOP_GATE
  const r = spawnSync(process.execPath, [entry], { input: JSON.stringify({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }), encoding: 'utf8', env })
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null
  ok(r.status === 0 && out && out.decision === 'block', '入口脚本：退出码 0 + stdout 输出 block JSON')
  const r2 = spawnSync(process.execPath, [entry], { input: 'garbage', encoding: 'utf8', env })
  ok(r2.status === 0 && r2.stdout.trim() === '', '入口脚本：坏输入 → 退出码 0、无输出（放行）')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS: stop gate' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
