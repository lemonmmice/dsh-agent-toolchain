const ERR_LINE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(?:([A-Z]{1,7}\d+):)?\s*(.*)$/
const ERR_TOP = /^MSBUILD\s*:\s*(?:error|错误)\s+([A-Z]{1,7}\d+):\s*(.*)$/
const ERR_PLAIN = /^(.*?)\s*:\s*(?:error|错误)\s+([A-Z]{1,7}\d+):\s*(.*)$/
const ERR_EMBED = /^(.*?)\s*:\s*(?:error|错误)\s*:\s*(.*)$/

export function createDiagnostics() {
  const errors = []
  const warnings = []
  const seenErrors = new Set()
  const seenWarnings = new Set()
  const add = (entry, warning = false) => {
    const key = `${entry.file}|${entry.line}|${entry.col}|${entry.code}`
    const seen = warning ? seenWarnings : seenErrors
    if (seen.has(key)) return
    seen.add(key)
    ;(warning ? warnings : errors).push(entry)
  }
  const line = text => {
    const positioned = text.match(ERR_LINE)
    if (positioned) {
      const kind = positioned[4]
      const code = positioned[5] || ''
      if (kind === 'error' && !code) return
      add({ file: positioned[1].trim(), line: Number(positioned[2]), col: Number(positioned[3]), code: code || '(none)', message: (positioned[6] || '').replace(/^:\s*/, '').trim() }, kind === 'warning')
      return
    }
    const top = text.match(ERR_TOP)
    if (top) { add({ file: '(top-level)', line: 0, col: 0, code: top[1], message: top[2].trim() }); return }
    const plain = text.match(ERR_PLAIN)
    if (plain) { add({ file: plain[1].trim() || '(top-level)', line: 0, col: 0, code: plain[2], message: plain[3].trim() }); return }
    const embedded = text.match(ERR_EMBED)
    if (embedded) {
      const code = embedded[2].match(/\b([A-Z]{1,7}\d{4,5})\b/)
      if (code) add({ file: embedded[1].trim() || '(top-level)', line: 0, col: 0, code: code[1], message: embedded[2].trim() })
    }
  }
  return { line, result: () => ({ errors, warnings }) }
}

export function parseErrors(text) {
  const parser = createDiagnostics()
  for (const line of text.split(/\r?\n/)) parser.line(line)
  return parser.result()
}
