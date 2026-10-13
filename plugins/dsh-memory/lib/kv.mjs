// KV 记忆：跨会话持久化 key-value（命名空间隔离）
import fs from "node:fs";
import path from "node:path";

// 原子写（F-053）：KV 原来也是 `writeFileSync` 原地覆盖 —— 与向量库**同病**，
// 只是它文件小（几十 KB）、窗口短，所以还没炸过。同一条修法，共用一处实现。
import { writeJsonlAtomic } from "./atomic-write.mjs";
import { withFileTransaction } from "../../../lib/file-transaction.mjs";
import { SqliteKv, migrateKvToSqlite } from './sqlite-kv.mjs';

export class KvMemory {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "kv.jsonl");
    this._snapshot = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  _read() {
    let stat;
    try { stat = fs.statSync(this.file, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this._snapshot = { version: null, rows: [], keys: new Map() };
      return this._snapshot.rows;
    }
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (this._snapshot?.version === version) return this._snapshot.rows;
    const rows = fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    this._snapshot = { version, rows, keys: new Map(rows.map(row => [JSON.stringify([row.scope, row.key]), row])) };
    return rows;
  }

  backend() {
    if (!this.sqlite && SqliteKv.available(this.dir)) this.sqlite = new SqliteKv(this.dir);
    return this.sqlite;
  }

  migrate(options) { const result = migrateKvToSqlite(this.dir, options); this.backend(); return result; }
  close() { this.sqlite?.close(); this.sqlite = null; }

  _write(rows) {
    this._snapshot = null;
    const result = writeJsonlAtomic(this.file, rows);
    const stat = fs.statSync(this.file, { bigint: true });
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    this._snapshot = { version, rows, keys: new Map(rows.map(row => [JSON.stringify([row.scope, row.key]), row])) };
    return result;
  }

  save(key, value, scope = "global", metadata = {}) {
    if (this.backend()) return this.sqlite.save(key, value, scope, metadata);
    return withFileTransaction(this.file, () => {
      if (this.backend()) return this.sqlite.save(key, value, scope, metadata);
      const rows = [...this._read()];
      const idx = rows.findIndex(row => row.key === key && row.scope === scope);
      const row = { key, value, scope, ...metadata, updatedAt: Date.now() };
      const stored = JSON.parse(JSON.stringify(row));
      if (idx >= 0) rows[idx] = stored; else rows.push(stored);
      this._write(rows);
      return row;
    });
  }

  get(key, scope = "global") {
    if (this.backend()) return this.sqlite.get(key, scope);
    this._read();
    return structuredClone(this._snapshot.keys.get(JSON.stringify([scope, key])) ?? null);
  }

  all(scope) {
    if (this.backend()) return this.sqlite.all(scope);
    return structuredClone(this._read().filter(row => !scope || row.scope === scope));
  }

  stats(now = Date.now()) {
    if (this.backend()) return this.sqlite.stats(now);
    this._read();
    if (!this._snapshot.summary) {
      const byKind = { fact: 0, convention: 0, debug: 0 };
      const expiries = [];
      for (const row of this._snapshot.rows) {
        const kind = row.kind || 'fact';
        byKind[kind] = (byKind[kind] || 0) + 1;
        const expiry = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
        if (Number.isFinite(expiry)) expiries.push(expiry);
      }
      expiries.sort((first, second) => first - second);
      this._snapshot.summary = { byKind, expiries };
    }
    const { byKind, expiries } = this._snapshot.summary;
    let lower = 0, upper = expiries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (expiries[middle] <= now) lower = middle + 1;
      else upper = middle;
    }
    return { kvEntries: this._snapshot.rows.length, byKind: { ...byKind }, expired: lower };
  }

  forget(key, scope = "global") {
    if (this.backend()) return this.sqlite.forget(key, scope);
    return withFileTransaction(this.file, () => {
      if (this.backend()) return this.sqlite.forget(key, scope);
      const rows = this._read();
      const kept = rows.filter(row => !(row.key === key && row.scope === scope));
      const deleted = rows.length - kept.length;
      if (deleted) this._write(kept);
      return { deleted };
    });
  }
}
