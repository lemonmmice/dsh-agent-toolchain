// Rust owns the resident vector index, prefix index and atomic JSONL writes.
// JS parses only on load and for selected hits, preserving existing JSON semantics.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let Binding
function binding() {
  if (Binding) return Binding
  const file = process.env.DSH_MEMORY_STORE_NATIVE || fileURLToPath(new URL(
    `../bin/${process.platform}-${process.arch}/memory-store.node`, import.meta.url))
  try { Binding = require(file).MemoryStore }
  catch (cause) { throw new Error('Memory native module unavailable. Run npm run build:memory-store and deploy the dsh-memory bin directory.', { cause }) }
  return Binding
}
const keyOf = value => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
function idOf(key) {
  let text = ''
  for (let i = 0; i < key.length; i += 4096) text += String.fromCharCode(...key.slice(i, i + 4096))
  return text
}
function vectorInput(v) {
  const empty = { kind: 0, dense: new Float64Array(0), keys: [], values: [], norm: 0 }
  if (Array.isArray(v)) return { ...empty, kind: 1, dense: Float64Array.from(v) }
  if (v?.kind === 'bigram') {
    const entries = v.sparse instanceof Map ? [...v.sparse] : Object.entries(v.sparse || {})
    return { ...empty, kind: 2, keys: entries.map(([k]) => keyOf(k)), values: entries.map(([, n]) => Number(n)), norm: Number(v.norm) }
  }
  return empty
}
function storedVector(v) {
  return v?.kind === 'bigram' && v.sparse instanceof Map ? { ...v, sparse: Object.fromEntries(v.sparse) } : v
}
function encode(row, alreadyPersisted = false, originalJson = null) {
  if (typeof row?.id !== 'string') throw new TypeError('Memory row id must be a string')
  const json = originalJson ?? JSON.stringify({ ...row, vector: storedVector(row.vector) })
  // Match the persisted representation (NaN/Infinity/null, sparse keys, toJSON).
  const persisted = alreadyPersisted ? row : JSON.parse(json)
  return { key: keyOf(persisted.id), json, vector: vectorInput(persisted.vector) }
}
const changed = error => String(error.message).includes('MEMORY_STORE_CHANGED:')

export class VectorStore {
  constructor(dir, namespace = 'default') {
    this.namespace = namespace
    this.dir = dir
    this.file = path.join(dir, namespace + '.jsonl')
    fs.mkdirSync(dir, { recursive: true })
    this._native = null
    this._batch = false
    this._pending = 0
    this._flushEvery = 200
  }

  _ensure() {
    if (!this._native) { const Native = binding(); this._native = new Native(path.resolve(this.file)) }
    for (let attempt = 0; ; attempt++) {
      try {
        const text = this._native.load()
        if (text != null) {
          const rows = text.split('\n').filter(line => line.trim() !== '').map(line => encode(JSON.parse(line), true, line))
          this._native.hydrate(rows)
        }
        return this._native
      } catch (error) {
        // A dirty batch must be reported as conflicting, never silently reloaded.
        if (!changed(error) || this._batch || attempt >= 2) throw error
      }
    }
  }

  _read() { return this._ensure().rows().map(json => JSON.parse(json)) }
  _write() { return this._native.flush() }

  beginBatch({ flushEvery = 200 } = {}) {
    if (this._batch) return
    this._ensure()
    this._batch = true
    this._pending = 0
    this._flushEvery = Math.max(1, Number(flushEvery) || 200)
  }
  flushBatch() {
    if (!this._batch) return null
    const result = this._write()
    this._pending = 0
    return result
  }
  endBatch() {
    if (!this._batch) return null
    const result = this.flushBatch()
    this._batch = false
    return result
  }
  abortBatch() {
    this._native?.discard()
    this._batch = false
    this._pending = 0
  }
  _mutate(fn, weight = 1) {
    const native = this._ensure()
    try {
      const result = fn(native)
      if (this._batch) {
        this._pending += Math.max(1, weight)
        if (this._pending >= this._flushEvery) this.flushBatch()
      } else this._write()
      return result
    } catch (error) {
      // Failed publication must not leak phantom rows through later reads.
      if (!this._batch) native.discard()
      throw error
    }
  }
  upsert(id, vector, meta = {}) {
    const row = { id, vector: storedVector(vector), meta, updatedAt: Date.now() }
    const encoded = encode(row)
    this._mutate(native => native.upsert(encoded))
    return row
  }
  replacePrefix(prefix, rows) {
    const encoded = rows.map(row => encode(row)) // validate every row before mutation
    this._mutate(native => native.replacePrefix(keyOf(prefix), encoded), rows.length)
  }
  remove(id) { this._mutate(native => native.removePrefix(keyOf(id), true)) }
  clear() { this._mutate(native => native.removePrefix([], false)) }
  ids() { return this._ensure().ids().map(idOf) }
  countPrefix(prefix) { return this._ensure().countPrefix(keyOf(prefix)) }
  removePrefix(prefix) { return this._mutate(native => native.removePrefix(keyOf(prefix), false)) }
  count() { return this._ensure().count() }
  search(queryVector, k = 5) {
    const native = this._ensure()
    const length = native.count(), number = Number(k)
    const end = Number.isNaN(number) ? 0 : Math.trunc(number)
    const limit = end < 0 ? Math.max(0, length + end) : Math.min(length, end)
    const result = native.search(vectorInput(queryVector), limit)
    const hits = result.hits.map(({ json, score }) => ({ ...JSON.parse(json), score }))
    // JS treats a NaN comparison as a tie. Keep its exact stable-sort behavior
    // for malformed/unequal-dimensional legacy vectors rather than inventing scores.
    return result.needsJsSort ? hits.sort((a, b) => b.score - a.score).slice(0, limit) : hits
  }
}
