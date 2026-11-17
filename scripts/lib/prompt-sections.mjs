// scripts/lib/prompt-sections.mjs — find every DSH system-prompt registration in a JS source and
// report whether it is injected literally.
//
// Before every agent turn the DSH host renders all registered prompt sections and contexts through
// its template engine: a "{{name}}" group must name a registered prompt variable, the name must
// match /^[a-z][a-z0-9_]*$/, and a "{{" followed anywhere later by "}}" that is not such a group
// is malformed. Any violation throws, and the whole turn fails — for every user of the host, not
// just the plugin's own tools. Registrations with `interpolate: false` skip the engine. Our plugin
// texts never use prompt variables, so every registration must set it; the check below enforces
// that statically (no plugin code runs).

/**
 * The source with comments and string / template-literal contents blanked out (same length, newlines
 * kept), so a regex over it only sees code. Regex literals are not recognised; a quote inside one at
 * worst blanks the rest of that line.
 * @param {string} src
 * @returns {string}
 */
export function maskNonCode(src) {
  const out = src.split('')
  const n = src.length
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i)
      const end = e < 0 ? n : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e < 0 ? n : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') depth--
            j++
          }
          continue
        }
        j++
      }
      blank(i + 1, j)
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** Does an object-literal source (masked) set `interpolate: false` as one of its own top-level keys? */
function topLevelInterpolateFalse(objectMasked) {
  let depth = 0
  for (let k = 0; k < objectMasked.length; k++) {
    const ch = objectMasked[k]
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (depth === 1 && ch === 'i' && !/[\w$]/.test(objectMasked[k - 1] ?? '') && /^interpolate\s*:\s*false\b/.test(objectMasked.slice(k))) return true
  }
  return false
}

/**
 * Every `systemPrompt.section(...)` / `systemPrompt.context(...)` call in a JS source.
 * @param {string} src
 * @returns {{kind: 'section'|'context', line: number, literal: boolean, interpolateFalse: boolean}[]}
 *   literal = the argument is an object literal (the only shape the check can verify);
 *   interpolateFalse = that literal sets `interpolate: false` at its top level.
 */
export function findPromptRegistrations(src) {
  const masked = maskNonCode(src)
  const re = /\bsystemPrompt\s*\??\.\s*(section|context)\s*\(/g
  const found = []
  let m
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let close = open
    for (; close < masked.length; close++) {
      const ch = masked[close]
      if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) break
    }
    const arg = masked.slice(open + 1, close).trim()
    const literal = arg.startsWith('{')
    found.push({
      kind: m[1],
      line: src.slice(0, m.index).split('\n').length,
      literal,
      interpolateFalse: literal && topLevelInterpolateFalse(arg),
    })
  }
  return found
}
