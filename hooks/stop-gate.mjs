#!/usr/bin/env node
// Stop 钩子入口：从 stdin 读钩子输入，交给 lib/stop-gate.mjs 裁决；有结论就把 JSON 写到 stdout。
// 任何情况下退出码都是 0 —— 闸门失灵时放行，绝不把会话卡住。
import { readFileSync } from 'node:fs'
import { runStopGate } from '../lib/stop-gate.mjs'

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch { raw = '' }
const out = runStopGate(raw, process.env)
if (out) process.stdout.write(JSON.stringify(out))
process.exit(0)
