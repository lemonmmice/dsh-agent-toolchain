import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'smol-toml'

export const serverName = 'dsh-agent-toolchain'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value
}

export function updateJson(text, entry, type) {
  const config = object(text.trim() ? JSON.parse(text.replace(/^\uFEFF/, '')) : {}, 'Client configuration')
  config.mcpServers ??= {}
  object(config.mcpServers, 'mcpServers')
  const previous = config.mcpServers[serverName] || {}
  object(previous, 'Existing MCP entry')
  config.mcpServers[serverName] = { ...previous, ...entry, env: { ...previous.env, ...entry.env } }
  delete config.mcpServers[serverName].url
  delete config.mcpServers[serverName].headers
  if (type === 'claude-code') config.mcpServers[serverName].type = 'stdio'
  else delete config.mcpServers[serverName].type
  return JSON.stringify(config, null, 2) + '\n'
}

function advanceStringState(line, state) {
  for (let offset = 0; offset < line.length; offset++) {
    const character = line[offset]
    if (state === '"""' || state === "'''") {
      if (state === '"""' && character === '\\') { offset++; continue }
      if (line.slice(offset, offset + 3) === state) {
        offset += 2
        while (line[offset + 1] === character) offset++
        state = null
      }
    } else if (state) {
      if (state === '"' && character === '\\') offset++
      else if (character === state) state = null
    } else {
      if (character === '#') break
      if (character === '"' || character === "'") {
        state = line.slice(offset, offset + 3) === character.repeat(3) ? character.repeat(3) : character
        if (state.length === 3) offset += 2
      }
    }
  }
  return state
}

export function updateToml(text, entry) {
  const original = text.replace(/^\uFEFF/, '')
  const config = parse(original)
  const lines = original.split(/(?<=\n)/)
  const sections = []
  let state = null
  let offset = 0
  for (const line of lines) {
    if (!state && /^\s*\[/.test(line)) {
      const header = parse(line)
      const target = Object.hasOwn(header.mcp_servers || {}, serverName)
      sections.push({ start: offset, target })
    }
    state = advanceStringState(line, state)
    offset += line.length
  }
  const existing = config.mcp_servers?.[serverName]
  if (existing && !sections.some(section => section.target)) {
    throw new Error('Existing dsh-agent-toolchain uses inline TOML. Move it to [mcp_servers.dsh-agent-toolchain] before installing; configuration was not changed.')
  }
  if (existing) object(existing, 'Existing MCP entry')
  const merged = { ...(existing || {}), ...entry, env: { ...existing?.env, ...entry.env }, enabled: true }
  for (const key of ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'oauth']) delete merged[key]
  merged.startup_timeout_sec ??= 30
  merged.tool_timeout_sec ??= 300
  let result = original
  for (let index = sections.length - 1; index >= 0; index--) {
    if (!sections[index].target) continue
    result = result.slice(0, sections[index].start) + result.slice(sections[index + 1]?.start ?? original.length)
  }
  result = result.trimEnd() + '\n\n' + stringify({ mcp_servers: { [serverName]: merged } })
  parse(result)
  return result.trimStart()
}

export function planClientConfigs({ home, appData, codexHome, claudeConfigDir, clients, entry }) {
  return clients.map(client => {
    const path = client === 'codex' ? join(codexHome || join(home, '.codex'), 'config.toml')
      : client === 'claude-code' ? (claudeConfigDir ? join(claudeConfigDir, '.claude.json') : join(home, '.claude.json'))
      : client === 'claude-desktop' ? join(appData, 'Claude', 'claude_desktop_config.json')
      : null
    if (!path) throw new Error('Unknown client: ' + client)
    const before = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const after = client === 'codex' ? updateToml(before, entry) : updateJson(before, entry, client)
    return { client, path, before, after }
  })
}

export function writeWithBackup(path, text, expected) {
  const exists = existsSync(path)
  const current = exists ? readFileSync(path, 'utf8') : ''
  if (expected !== undefined && current !== expected) throw new Error('Configuration changed during installation: ' + path)
  if (current === text) return { path, changed: false, backup: null }
  mkdirSync(dirname(path), { recursive: true })
  const backup = exists ? path + '.dsh-backup-' + randomUUID() : null
  if (backup) copyFileSync(path, backup)
  const temporary = path + '.dsh-' + randomUUID() + '.tmp'
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
  return { path, changed: true, backup }
}

export function applyConfigPlans(plans) {
  const applied = []
  try {
    for (const plan of plans) {
      const existed = existsSync(plan.path)
      const change = writeWithBackup(plan.path, plan.after, plan.before)
      applied.push({ plan, existed, change })
    }
    return applied.map(item => item.change)
  } catch (error) {
    for (const item of applied.reverse()) {
      if (!item.change.changed) continue
      if (readFileSync(item.plan.path, 'utf8') !== item.plan.after) {
        console.error('Concurrent edit preserved; restore manually from ' + item.change.backup)
        continue
      }
      if (item.existed) writeWithBackup(item.plan.path, item.plan.before, item.plan.after)
      else unlinkSync(item.plan.path)
    }
    throw error
  }
}
