// 向量库：JSONL 持久化 + 余弦相似度（零依赖，几千块规模足够）
import fs from "node:fs";
import path from "node:path";

import { similarity } from "./embed-provider.mjs";

export class VectorStore {
  constructor(dir, namespace = "default") {
    this.namespace = namespace;
    this.dir = dir;
    this.file = path.join(dir, namespace + ".jsonl");
    fs.mkdirSync(dir, { recursive: true });
  }

  _read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  _write(rows) {
    fs.writeFileSync(this.file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  }

  upsert(id, vector, meta = {}) {
    const rows = this._read();
    const idx = rows.findIndex(r => r.id === id);
    const row = { id, vector, meta, updatedAt: Date.now() };
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    this._write(rows);
    return row;
  }

  remove(id) {
    const rows = this._read().filter(r => r.id !== id);
    this._write(rows);
  }

  clear() { this._write([]); }

  ids() {
    return this._read().map(r => r.id);
  }

  countPrefix(prefix) {
    return this._read().filter(r => r.id.startsWith(prefix)).length;
  }

  removePrefix(prefix) {
    const rows = this._read();
    const keep = rows.filter(r => !r.id.startsWith(prefix));
    if (keep.length !== rows.length) this._write(keep);
    return rows.length - keep.length;
  }

  search(queryVector, k = 5) {
    return this._read()
      .map(r => ({ ...r, score: similarity(queryVector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  count() { return this._read().length; }
}
