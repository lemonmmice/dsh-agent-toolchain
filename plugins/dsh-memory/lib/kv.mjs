// KV 记忆：跨会话持久化 key-value（命名空间隔离）
import fs from "node:fs";
import path from "node:path";

// 原子写（F-053）：KV 原来也是 `writeFileSync` 原地覆盖 —— 与向量库**同病**，
// 只是它文件小（几十 KB）、窗口短，所以还没炸过。同一条修法，共用一处实现。
import { writeJsonlAtomic } from "./atomic-write.mjs";
import { withFileTransaction } from "../../../lib/file-transaction.mjs";

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

  _write(rows) {
    try { return writeJsonlAtomic(this.file, rows); }
    finally { this._snapshot = null; }
  }

  save(key, value, scope = "global", metadata = {}) {
    return withFileTransaction(this.file, () => {
      const rows = [...this._read()];
      const idx = rows.findIndex(row => row.key === key && row.scope === scope);
      const row = { key, value, scope, ...metadata, updatedAt: Date.now() };
      if (idx >= 0) rows[idx] = row; else rows.push(row);
      this._write(rows);
      return row;
    });
  }

  get(key, scope = "global") {
    this._read();
    return structuredClone(this._snapshot.keys.get(JSON.stringify([scope, key])) ?? null);
  }

  all(scope) {
    return structuredClone(this._read().filter(row => !scope || row.scope === scope));
  }

  forget(key, scope = "global") {
    return withFileTransaction(this.file, () => {
      const rows = this._read();
      const kept = rows.filter(row => !(row.key === key && row.scope === scope));
      const deleted = rows.length - kept.length;
      if (deleted) this._write(kept);
      return { deleted };
    });
  }
}
