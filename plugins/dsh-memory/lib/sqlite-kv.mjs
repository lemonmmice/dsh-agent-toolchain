import { createRequire } from 'node:module'
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileTransaction } from '../../../lib/file-transaction.mjs'

const require = createRequire(import.meta.url)
const markerName = 'kv-sqlite-v1.json'
function identity(file) {
  try {
    const value = statSync(file, { bigint: true })
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const entryId = (key, scope) => JSON.stringify([scope, key])

export class SqliteKv {
  static available(directory) { return existsSync(join(directory, markerName)) || existsSync(join(directory, 'kv.sqlite')) }

  constructor(directory, { migrating = false } = {}) {
    if (/^\\\\/.test(realpathSync(directory))) throw new Error('SQLite WAL KV requires a local filesystem')
    const { DatabaseSync } = require('node:sqlite')
    this.directory = directory
    this.legacy = join(directory, 'kv.jsonl')
    this.marker = null
    this.database = new DatabaseSync(join(directory, 'kv.sqlite'))
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, expires REAL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope); CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind); CREATE INDEX IF NOT EXISTS memories_expiry ON memories(expires); CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);')
    if (!migrating) {
      const marker = this.database.prepare('SELECT payload FROM migration WHERE id=1').get()
      if (!marker) { this.database.close(); throw Object.assign(new Error('Incomplete KV migration; rerun the migration before accessing this store'), { code: 'KV_MIGRATION_INCOMPLETE', incomplete: true }) }
      this.marker = JSON.parse(marker.payload)
      if (this.marker.version !== 1) { this.database.close(); throw new Error('Unsupported SQLite KV migration version') }
    }
    this.select = this.database.prepare('SELECT payload FROM memories WHERE id = ?')
    this.upsert = this.database.prepare('INSERT INTO memories(id,scope,kind,expires,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,kind=excluded.kind,expires=excluded.expires,payload=excluded.payload')
    this.remove = this.database.prepare('DELETE FROM memories WHERE id = ?')
  }

  assertLegacyUnchanged() {
    if (this.marker && identity(this.legacy) !== this.marker.legacyIdentity) throw Object.assign(new Error('Legacy KV changed after SQLite migration; stop the old writer and reconcile before continuing'), { code: 'KV_LEGACY_CHANGED', incomplete: true, writesApplied: false })
  }

  put(row) {
    const expiry = row.expiresAt ? Date.parse(row.expiresAt) : NaN
    this.upsert.run(entryId(row.key, row.scope), JSON.stringify(row.scope), row.kind || 'fact', Number.isFinite(expiry) ? expiry : null, JSON.stringify(row))
  }

  save(key, value, scope, metadata) {
    this.assertLegacyUnchanged()
    const row = JSON.parse(JSON.stringify({ key, value, scope, ...metadata, updatedAt: Date.now() }))
    this.mutate(() => this.put(row))
    return structuredClone(row)
  }

  get(key, scope) {
    this.assertLegacyUnchanged()
    const found = this.select.get(entryId(key, scope))
    return found ? JSON.parse(found.payload) : null
  }

  all(scope) {
    this.assertLegacyUnchanged()
    const rows = scope ? this.database.prepare('SELECT payload FROM memories WHERE scope = ? ORDER BY rowid').all(JSON.stringify(scope)) : this.database.prepare('SELECT payload FROM memories ORDER BY rowid').all()
    return rows.map(row => JSON.parse(row.payload))
  }

  forget(key, scope) {
    this.assertLegacyUnchanged()
    return this.mutate(() => ({ deleted: Number(this.remove.run(entryId(key, scope)).changes) }))
  }

  mutate(action) {
    try { this.database.exec('BEGIN IMMEDIATE') }
    catch (error) {
      if ([5, 6].includes(error.errcode)) throw Object.assign(new Error('SQLite writer is busy; no changes were made'), { code: 'FILE_TRANSACTION_BUSY', retryable: true, retryAfterMs: 25, writesApplied: false })
      throw error
    }
    try { const result = action(); this.database.exec('COMMIT'); return result }
    catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  stats(now = Date.now()) {
    this.assertLegacyUnchanged()
    const byKind = { fact: 0, convention: 0, debug: 0 }
    let kvEntries = 0
    for (const row of this.database.prepare('SELECT kind,COUNT(*) AS count FROM memories GROUP BY kind').all()) { byKind[row.kind] = row.count; kvEntries += row.count }
    const expired = this.database.prepare('SELECT COUNT(*) AS count FROM memories WHERE expires <= ?').get(now).count
    return { kvEntries, byKind, expired }
  }

  close() { this.database.close() }
}

export function migrateKvToSqlite(directory, { confirm = false } = {}) {
  const legacy = join(directory, 'kv.jsonl')
  return withFileTransaction(legacy, () => {
    if (SqliteKv.available(directory)) {
      let existing
      try {
        existing = new SqliteKv(directory)
        existing.assertLegacyUnchanged()
        return { migrated: false, alreadyMigrated: true, ...existing.stats() }
      } catch (error) { if (error.code !== 'KV_MIGRATION_INCOMPLETE') throw error }
      finally { existing?.close() }
    }
    const before = identity(legacy)
    const rows = before === null ? [] : readFileSync(legacy, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const keys = new Set()
    for (const row of rows) {
      const key = entryId(row.key, row.scope)
      if (keys.has(key)) throw new Error('Duplicate KV keys require reconciliation before migration')
      keys.add(key)
    }
    if (before !== identity(legacy)) throw Object.assign(new Error('KV changed during migration scan'), { code: 'KV_LEGACY_CHANGED', writesApplied: false })
    if (!confirm) return { migrated: false, dryRun: true, entries: rows.length, requiresNode: '22.13+', requiresLocalDisk: true, legacyIdentity: before }
    const backup = before === null ? null : join(directory, 'kv.pre-sqlite-' + randomUUID() + '.jsonl')
    if (backup) copyFileSync(legacy, backup)
    const store = new SqliteKv(directory, { migrating: true })
    let transaction = false
    const temporary = join(directory, markerName + '.' + randomUUID() + '.tmp')
    try {
      store.database.exec('BEGIN IMMEDIATE; DELETE FROM memories;')
      transaction = true
      for (const row of rows) store.put(row)
      if (before !== identity(legacy)) throw new Error('KV changed during migration; database not published')
      const marker = { version: 1, legacyIdentity: before, backup, migratedAt: new Date().toISOString(), entries: rows.length }
      store.database.prepare('INSERT OR REPLACE INTO migration(id,payload) VALUES(1,?)').run(JSON.stringify(marker))
      store.database.exec('COMMIT')
      transaction = false
      let markerWriteError = null
      try { writeFileSync(temporary, JSON.stringify(marker)); renameSync(temporary, join(directory, markerName)) }
      catch (error) { markerWriteError = error.code || error.message }
      return { migrated: true, entries: rows.length, backup, database: join(directory, 'kv.sqlite'), markerWriteError }
    } finally {
      if (transaction) store.database.exec('ROLLBACK')
      store.close()
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  })
}
