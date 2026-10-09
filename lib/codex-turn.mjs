function parsed(value) {
  try { return JSON.parse(value) } catch { return null }
}

function codeStrings(code) {
  const strings = []
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (token) => {
    if (!token.startsWith('/')) {
      const value = token[0] === '"' ? parsed(token) : token.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|[nrt\\'"`])/g, (_, escape) => {
        if (escape.startsWith('u')) return String.fromCharCode(parseInt(escape.slice(1), 16))
        return ({ n: '\n', r: '\r', t: '\t' })[escape] ?? escape
      })
      if (typeof value === 'string') strings.push(value)
    }
    return ' '.repeat(token.length)
  })
  return { strings, masked }
}

function verdictsIn(value, out = [], depth = 0) {
  if (depth > 12 || value == null) return out
  if (typeof value === 'string') {
    const json = parsed(value)
    if (json !== null) return verdictsIn(json, out, depth + 1)
    for (const line of value.split('\n')) {
      const candidate = parsed(line)
      if (candidate !== null) verdictsIn(candidate, out, depth + 1)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) verdictsIn(item, out, depth + 1)
  } else if (typeof value === 'object') {
    if (['pass', 'fail', 'incomplete'].includes(value.verdict)) out.push(value)
    else for (const key of ['content', 'text', 'output', 'result', 'value', 'structuredContent']) verdictsIn(value[key], out, depth + 1)
  }
  return out
}

export function parseCodexTurn(text, turnId) {
  const entries = String(text ?? '').split('\n').map(parsed).filter(Boolean)
  const recognized = entries.some((entry) => entry.type === 'response_item' && entry.payload?.type)
  const edits = []
  const verifies = []
  const calls = new Map()
  const turnOf = (entry) => entry.type === 'turn_context' || (entry.type === 'event_msg' && entry.payload?.type === 'task_started') ? entry.payload?.turn_id : null
  const hasIds = entries.some((entry) => turnOf(entry))
  let active = false
  let turnFound = false
  let fallbackStart = -1
  if (!hasIds) {
    for (const [index, entry] of entries.entries()) {
      if ((entry.type === 'event_msg' && entry.payload?.type === 'user_message') || (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'user')) fallbackStart = index
    }
    if (fallbackStart < 0) return { recognized, turnFound: false, edits, verifies }
  }
  for (const [index, entry] of entries.entries()) {
    const id = turnOf(entry)
    if (id) { active = id === turnId; if (active) turnFound = true }
    if (hasIds ? !active : index <= fallbackStart) continue
    if (!hasIds && fallbackStart >= 0) turnFound = true
    if (entry.type !== 'response_item') continue
    const item = entry.payload
    if (!item) continue
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const name = String(item.name || '')
      const raw = item.arguments ?? item.input ?? ''
      const args = typeof raw === 'string' ? parsed(raw) : raw
      const directPatch = /(?:^|[.__])apply_patch$/.test(name)
      const code = typeof raw === 'string' ? (typeof args?.code === 'string' ? args.code : raw) : String(args?.code ?? '')
      const scan = codeStrings(code)
      const nestedPatch = /\b(?:tools|functions)\.[\w.]*apply_patch\s*\(/.test(scan.masked)
      const patches = directPatch ? [typeof raw === 'string' ? (args?.patch ?? raw) : args?.patch ?? ''] : nestedPatch ? scan.strings : []
      for (const patch of patches) {
        for (const match of String(patch).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)\r?$/gm)) edits.push({ tool: 'apply_patch', file: match[1].trim() })
        for (const match of String(patch).matchAll(/^\*\*\* Move to: (.+)\r?$/gm)) edits.push({ tool: 'apply_patch', file: match[1].trim() })
      }
      const names = /verify_report$/.test(name) ? [name] : [...scan.masked.matchAll(/\b(?:tools|functions)\.([\w.]*verify_report)\s*\(/g)].map((match) => match[1])
      const invoked = names.map((tool) => ({ id: item.call_id, tool, verdict: null, isError: false }))
      verifies.push(...invoked)
      if (invoked.length) calls.set(item.call_id, invoked)
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type) && calls.has(item.call_id)) {
      const invoked = calls.get(item.call_id)
      const results = verdictsIn(item.output)
      for (const [resultIndex, result] of results.entries()) {
        const verify = invoked[Math.min(resultIndex, invoked.length - 1)]
        Object.assign(verify, { verdict: result.verdict, ...(result.counts ? { counts: result.counts } : {}), ...(result.reportPath ? { reportPath: result.reportPath } : {}) })
      }
    }
  }
  return { recognized, turnFound, edits, verifies }
}
