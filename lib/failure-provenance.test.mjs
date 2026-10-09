// producer（失败记录来源）与工具链版本的离线自测：node lib/failure-provenance.test.mjs
import { agentTurnFromMeta, buildProducer, CODEX_TURN_META_KEY } from './failure-provenance.mjs'
import { toolchainVersion, readHeadSha } from './toolchain-version.mjs'

let failures = 0
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg) } }

// ---- Codex 回合元数据（对象 / 字符串 / 认不出）
const obj = agentTurnFromMeta({ [CODEX_TURN_META_KEY]: { session_id: 's-1', thread_id: 'th-1', turn_id: 'tu-1', prompt: '绝不能被收进来' } })
ok(obj && obj.host === 'codex' && obj.sessionId === 's-1' && obj.threadId === 'th-1' && obj.turnId === 'tu-1', '对象形态：取出三个 id')
ok(obj && !('prompt' in obj) && Object.keys(obj).length === 4, '只收 id，不收任何内容字段')
const str = agentTurnFromMeta({ [CODEX_TURN_META_KEY]: JSON.stringify({ turn_id: 'tu-2' }) })
ok(str && str.turnId === 'tu-2' && str.sessionId === undefined, '字符串形态：解析后取 id')
ok(agentTurnFromMeta({ [CODEX_TURN_META_KEY]: '{坏 json' }) === null, '坏 JSON → null（不猜）')
ok(agentTurnFromMeta({ progressToken: 1 }) === null, '没有 Codex 元数据 → null')
ok(agentTurnFromMeta(undefined) === null, '没有 _meta → null')
ok(agentTurnFromMeta({ [CODEX_TURN_META_KEY]: { turn_id: 'x'.repeat(500) } }) === null, '超长/异常 id 被拒（不把任意文本塞进记录）')
ok(agentTurnFromMeta({ [CODEX_TURN_META_KEY]: { turn_id: 'a b;rm' } }) === null, '含非法字符的 id 被拒')

// ---- producer
const p = buildProducer({ runtime: 'mcp', client: { name: ' claude-code ', version: '2.1.175' }, agentTurn: obj, env: { DSH_TEST: '1' } })
ok(p.runtime === 'mcp' && p.client.name === 'claude-code' && p.client.version === '2.1.175', 'producer：runtime + client')
ok(p.agentTurn === obj && p.test === true, 'producer：agentTurn + test 标记')
ok(typeof p.toolchain?.version === 'string', 'producer：toolchain.version 来自 package.json')
const bare = buildProducer({ runtime: 'verify', client: { name: '' }, env: {} })
ok(!('client' in bare) && !('agentTurn' in bare) && !('test' in bare), '缺的项就不写（空客户端名不写成空对象）')

// ---- 版本：本仓库是 git checkout，HEAD 能解析出 40 位 sha；toolchainVersion 只给前 12 位
const head = readHeadSha()
ok(head === null || /^[0-9a-f]{40}$/.test(head), 'readHeadSha：40 位 hex 或 null（拿不到不猜）')
const v = toolchainVersion()
ok(v.sha === undefined || (head && v.sha === head.slice(0, 12)), 'toolchainVersion.sha = HEAD 前 12 位')
ok(toolchainVersion() === v, '进程内缓存')

console.log(failures === 0 ? '\nPASS: producer / agentTurn / toolchain version' : '\nFAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
