// KV 记忆：跨会话持久化 key-value（命名空间隔离）
import fs from "node:fs";
import path from "node:path";

// 原子写（F-053）：KV 原来也是 `writeFileSync` 原地覆盖 —— 与向量库**同病**，
// 只是它文件小（几十 KB）、窗口短，所以还没炸过。同一条修法，共用一处实现。
import { writeJsonlAtomic } from "./atomic-write.mjs";

export class KvMemory {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "kv.jsonl");
    fs.mkdirSync(dir, { recursive: true });
  }

  _read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  _write(rows) { return writeJsonlAtomic(this.file, rows); }

  save(key, value, scope = "global") {
    const rows = this._read();
    const idx = rows.findIndex(r => r.key === key && r.scope === scope);
    const row = { key, value, scope, updatedAt: Date.now() };
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    this._write(rows);
    return row;
  }

  get(key, scope = "global") {
    const rows = this._read().filter(r => r.key === key && r.scope === scope);
    return rows.length ? rows[rows.length - 1] : null;
  }

  all(scope) {
    return this._read().filter(r => !scope || r.scope === scope);
  }

  forget(key, scope = "global") {
    this._write(this._read().filter(r => !(r.key === key && r.scope === scope)));
  }
}
