#!/usr/bin/env node
// SessionStart 钩子入口：.NET 桌面仓库里开会话时注入几行工具链上下文。退出码恒为 0。
import { readFileSync } from 'node:fs'
import { runSessionStartHook } from '../lib/session-start-hook.mjs'

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch { raw = '' }
const out = runSessionStartHook(raw, process.env)
if (out) process.stdout.write(JSON.stringify(out))
process.exit(0)
