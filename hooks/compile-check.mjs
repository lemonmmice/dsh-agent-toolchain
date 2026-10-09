#!/usr/bin/env node
// PostToolUse 钩子入口：写/改 .cs/.vb/.fs 后核对编译集，能证明"不在"才提醒。退出码恒为 0。
import { readFileSync } from 'node:fs'
import { runCompileCheckHook } from '../lib/compile-check-hook.mjs'

let raw = ''
try { raw = readFileSync(0, 'utf8') } catch { raw = '' }
const out = runCompileCheckHook(raw)
if (out) process.stdout.write(JSON.stringify(out))
process.exit(0)
