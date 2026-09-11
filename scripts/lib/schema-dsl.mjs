// scripts/lib/schema-dsl.mjs — static validator for the DSH author-facing
// value-schema DSL.
//
// WHY THIS EXISTS
// ---------------
// `defineTool` compiles each tool's `parameters` spec through dsh-tools'
// schema compiler (`parameterSchemaSpecToJsonSchema`). That compiler enforces a
// STRICT KEY WHITELIST, and an unknown key rejects the whole plugin load with
// `UNSUPPORTED_SCHEMA`. A plugin that throws while loading takes the entire host
// down with it, and the watchdog then relaunches node every few seconds — so the
// GUI never comes up at all.
//
// That is not hypothetical: `mods: { type: 'array', additionalItems: false }`
// in dsh-ui-drive crash-looped the host on restart. `additionalItems` is real
// JSON Schema, but it is NOT part of this DSL — arrays accept only `items`.
//
// The compiler states its own subset in the rejection message:
//   "... is not a supported keyword (subset: type/oneOf/properties/required/
//    additionalProperties/items/enum/const + annotations)"
//
// This module re-implements that rule set over SOURCE TEXT, so the ordinary
// repo gate can enforce it with no DSH install, no module resolution and no
// side effects. It is deliberately a whitelist: anything the DSL does not know
// about is a violation, so JSON-Schema habits cannot creep back in one keyword
// at a time.
//
// It reports only what it can prove. A node whose `type` is computed, or whose
// value is a reference rather than a literal, is skipped instead of guessed at.

/** Annotation keys, copied onto every node whatever its type. */
export const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/** Keys the compiler accepts on a node, beyond annotations, by declared type. */
const KEYS_BY_TYPE = {
  json: ['type'],
  object: ['type', 'properties', 'additionalProperties'],
  array: ['type', 'items'],
  ...Object.fromEntries(SCALAR_TYPES.map((t) => [t, ['type', 'enum', 'const']])),
}

/** Every keyword the DSL knows about, for the rejection message. */
export const KNOWN_KEYS = [
  ...new Set([...ANNOTATION_KEYS, 'required', ...Object.values(KEYS_BY_TYPE).flat()]),
].sort()

// ---------------------------------------------------------------------------
// Lexical scanning. Everything below must be string/comment aware: parameter
// descriptions legitimately contain braces (a description may document
// `{ms?:5000, state?:"appear"}`), so naive brace counting silently mis-slices
// and every finding after that point is fiction.
// ---------------------------------------------------------------------------

/** Index just past the string literal starting at `i`. */
function skipString(src, i) {
  const quote = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    // Template interpolation may itself contain braces and strings.
    if (quote === '`' && c === '$' && src[i + 1] === '{') { i = skipBlock(src, i + 1, '{', '}'); continue }
    if (c === quote) return i + 1
    if (quote !== '`' && c === '\n') return i // unterminated single-line string
    i++
  }
  return i
}

/** Index just past the balanced `open`..`close` run starting at `i`. */
function skipBlock(src, i, open, close) {
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl + 1; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return i + 1 }
    i++
  }
  return src.length
}

/** Offsets of every top-level `sep` in `text` (depth 0, outside strings). */
function topLevelOffsets(text, sep) {
  const out = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(text, i); continue }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl + 1; continue }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (c === sep && depth === 0) out.push(i)
    i++
  }
  return out
}

/** Split `text` into its top-level segments, each with its own offset. */
function splitTopLevel(text) {
  const cuts = topLevelOffsets(text, ',')
  const segs = []
  let from = 0
  for (const p of cuts) { segs.push({ text: text.slice(from, p).trim(), offset: from }); from = p + 1 }
  segs.push({ text: text.slice(from).trim(), offset: from })
  return segs.map((s) => ({ ...s, offset: s.offset + (text.slice(s.offset).length - text.slice(s.offset).trimStart().length) }))
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const QUOTED_KEY = /^'[^']*'$|^"[^"]*"$/

/**
 * Parse the top level of an object/array literal body into
 * `{ key, raw, rawOffset }` entries, `rawOffset` being relative to `inner`.
 * Computed keys (`[x]: ...`) and spreads are skipped rather than guessed at —
 * this validator must never invent a finding.
 */
function parseEntries(inner) {
  const out = []
  for (const seg of splitTopLevel(inner)) {
    const colon = topLevelOffsets(seg.text, ':')[0]
    if (colon === undefined) continue
    const key = seg.text.slice(0, colon).trim()
    if (!IDENT.test(key) && !QUOTED_KEY.test(key)) continue
    const value = seg.text.slice(colon + 1)
    const lead = value.length - value.trimStart().length
    out.push({
      key: QUOTED_KEY.test(key) ? key.slice(1, -1) : key,
      raw: value.trim(),
      rawOffset: seg.offset + colon + 1 + lead,
    })
  }
  return out
}

/** The string value of a literal, or undefined when it is not a plain literal. */
function stringLiteral(raw) {
  const m = /^(['"])([^'"]*)\1$/.exec(raw ?? '')
  return m ? m[2] : undefined
}

/** Inner text of a literal starting with `open`, or undefined. */
function innerOf(raw, open, close) {
  if (!raw.startsWith(open)) return undefined
  const end = skipBlock(raw, 0, open, close)
  if (end <= 0 || raw[end - 1] !== close) return undefined
  return raw.slice(1, end - 1)
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

// ---------------------------------------------------------------------------
// Rules.
// ---------------------------------------------------------------------------

/**
 * Validate one value-schema node literal.
 * @param source - whole file text (for line numbers).
 * @param raw - trimmed source text of this node.
 * @param absStart - index of `raw[0]` inside `source`.
 * @param path - human path such as `parameters.mods`.
 * @param allowRequired - whether `required: true` is legal in this position.
 * @param report - (absIndex, path, message) => void
 */
function checkNode(source, raw, absStart, path, allowRequired, report) {
  const inner = innerOf(raw, '{', '}')
  if (inner === undefined) return // reference or computed expression
  // `{ ...SHARED, description: 'x' }` inherits keys this pass cannot see, so the
  // node's vocabulary is unknowable from source. Stay silent rather than
  // invent a finding: dsh-verify legitimately spreads a shared OBJECT schema.
  if (splitTopLevel(inner).some((s) => s.text.startsWith('...'))) return
  const innerAbs = absStart + 1
  const entries = parseEntries(inner)
  const byKey = new Map(entries.map((e) => [e.key, e]))
  const absOf = (e) => innerAbs + e.rawOffset

  const hasOneOf = byKey.has('oneOf')
  const typeLiteral = byKey.has('type') ? stringLiteral(byKey.get('type').raw) : undefined

  if (hasOneOf && byKey.has('type')) report(absOf(byKey.get('type')), path, `${path} cannot declare both type and oneOf`)

  // Which keys are legal depends on the declared type. The compiler's switch
  // has a `default` that rejects a node with no type, so a node carrying
  // neither `type` nor `oneOf` is itself a violation — not something to skip.
  let allowed = null
  if (hasOneOf) {
    allowed = new Set([...ANNOTATION_KEYS, 'oneOf'])
    if (allowRequired) allowed.add('required')
  } else if (!byKey.has('type')) {
    report(absStart, path, `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  } else if (typeLiteral === undefined) {
    // A computed type cannot be judged from source. Stay silent rather than
    // invent a finding; the runtime compiler still enforces it.
  } else if (!Object.hasOwn(KEYS_BY_TYPE, typeLiteral)) {
    report(absOf(byKey.get('type')), path, `${path}.type "${typeLiteral}" is not one of ${Object.keys(KEYS_BY_TYPE).join('/')}`)
  } else {
    allowed = new Set([...ANNOTATION_KEYS, ...KEYS_BY_TYPE[typeLiteral]])
    if (allowRequired) allowed.add('required')
  }

  if (allowed) {
    for (const e of entries) {
      if (!allowed.has(e.key)) {
        report(absOf(e), `${path}.${e.key}`, `${path}.${e.key} is not supported by the value schema DSL (subset: ${KNOWN_KEYS.join('/')})`)
      }
    }
  }

  if (allowRequired) {
    const req = byKey.get('required')
    if (req && req.raw !== 'true') report(absOf(req), `${path}.required`, `${path}.required must be true when present`)
  }

  if (typeLiteral === 'object') {
    const ap = byKey.get('additionalProperties')
    if (!ap) report(absStart, path, `${path}.additionalProperties must be explicitly true or false`)
    else if (!/^(true|false)$/.test(ap.raw)) report(absOf(ap), `${path}.additionalProperties`, `${path}.additionalProperties must be a boolean literal`)
  }

  // Recurse. `properties` is a property map (`required: true` is legal there);
  // `items` and `oneOf` branches are plain value schemas (it is not).
  const props = byKey.get('properties')
  if (props) {
    const pInner = innerOf(props.raw, '{', '}')
    if (pInner !== undefined) {
      const pAbs = absOf(props) + 1
      for (const e of parseEntries(pInner)) {
        checkNode(source, e.raw, pAbs + e.rawOffset, `${path}.properties.${e.key}`, true, report)
      }
    }
  }
  const items = byKey.get('items')
  if (items) checkNode(source, items.raw, absOf(items), `${path}.items`, false, report)

  const oneOf = byKey.get('oneOf')
  if (oneOf) {
    const oInner = innerOf(oneOf.raw, '[', ']')
    if (oInner !== undefined) {
      const oAbs = absOf(oneOf) + 1
      splitTopLevel(oInner).forEach((seg, i) => {
        if (!seg.text) return
        checkNode(source, seg.text, oAbs + seg.offset, `${path}.oneOf[${i}]`, false, report)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function matchAll(source, re) {
  const out = []
  re.lastIndex = 0
  let m
  while ((m = re.exec(source)) !== null) out.push(m)
  return out
}

/**
 * Validate every tool parameter/output schema in one source file.
 *
 * Scoped to `defineTool({...})` arguments on purpose: the DSL only governs
 * tool schemas, and an unrelated `parameters:` object elsewhere in a file (an
 * inbox client, a fetch wrapper) must not be read as one.
 *
 * @returns Array of `{ file, line, path, message }`; empty means clean.
 */
export function validateSchemas(source, { file = '<source>' } = {}) {
  const findings = []
  const report = (absIndex, path, message) => findings.push({ file, line: lineOf(source, absIndex), path, message })

  for (const m of matchAll(source, /\bdefineTool\s*\(\s*(?=\{)/g)) {
    const argAt = m.index + m[0].length
    const argEnd = skipBlock(source, argAt, '{', '}')
    const argInner = source.slice(argAt + 1, argEnd - 1)
    const argAbs = argAt + 1

    for (const p of matchAll(argInner, /\bparameters\s*:\s*(?=\{)/g)) {
      const braceAt = argAbs + p.index + p[0].length
      const end = skipBlock(source, braceAt, '{', '}')
      for (const e of parseEntries(source.slice(braceAt + 1, end - 1))) {
        checkNode(source, e.raw, braceAt + 1 + e.rawOffset, `parameters.${e.key}`, true, report)
      }
    }

    for (const p of matchAll(argInner, /\boutput\s*:\s*(?=\{)/g)) {
      const braceAt = argAbs + p.index + p[0].length
      const end = skipBlock(source, braceAt, '{', '}')
      for (const e of parseEntries(source.slice(braceAt + 1, end - 1))) {
        if (e.key !== 'schema' || !e.raw.startsWith('{')) continue // const ref / computed
        checkNode(source, e.raw, braceAt + 1 + e.rawOffset, 'output.schema', false, report)
      }
    }
  }

  return findings
}

/** Convenience wrapper for the repo gate: validate a file on disk. */
export function validateSchemaFile(path, readFile) {
  return validateSchemas(readFile(path, 'utf8'), { file: path })
}
