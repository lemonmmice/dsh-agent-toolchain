// 向量库：JSONL 持久化 + 余弦相似度（零依赖，几千块规模足够）
import fs from "node:fs";
import path from "node:path";

import { similarity } from "./embed-provider.mjs";
import { writeJsonlAtomic } from "./atomic-write.mjs";

export class VectorStore {
  constructor(dir, namespace = "default") {
    this.namespace = namespace;
    this.dir = dir;
    this.file = path.join(dir, namespace + ".jsonl");
    fs.mkdirSync(dir, { recursive: true });
    // 批量模式（F-053）：见 beginBatch 的说明
    this._rows = null;
    this._pending = 0;
    this._flushEvery = 200;
  }

  _read() {
    if (this._rows) return this._rows;           // 批量模式：以内存为准（避免每块都重读 43MB）
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  /**
   * 原子写（F-053）。**不再用 `writeFileSync` 原地覆盖** —— 那会在"截断之后、写完之前"
   * 被打断时把整个索引清零（2026-09-14 真事故：43.9MB / 2182 块 → 0 字节）。
   */
  _write(rows) {
    return writeJsonlAtomic(this.file, rows);
  }

  /**
   * 批量模式（F-053 的第二半）：索引一个工作区时，原来**每插一块**都会
   * `_read()` 全量解析 + `_write()` 重写整个文件 ⇒ 2182 块要重写 2182 次 43MB（约 95GB I/O），
   * **这才是"慢到会被打断"的根因**。现在在批量里只读一次、按 `flushEvery` 定期落盘、结束时收尾。
   *
   * ⚠ 中断语义：批量期间**已 flush 的部分**是完整的（每次 flush 都是原子的），
   *   未 flush 的部分丢掉 —— 也就是"少了一部分"，**不会再出现"全清"**。
   */
  beginBatch({ flushEvery = 200 } = {}) {
    if (this._rows) return;
    this._rows = this._read();
    this._pending = 0;
    this._flushEvery = Math.max(1, Number(flushEvery) || 200);
  }

  flushBatch() {
    if (!this._rows) return null;
    const rows = this._rows;
    this._pending = 0;
    return this._write(rows);
  }

  endBatch() {
    if (!this._rows) return null;
    const r = this.flushBatch();
    this._rows = null;
    return r;
  }

  _maybeFlush() {
    if (!this._rows) return;
    if (++this._pending >= this._flushEvery) this.flushBatch();
  }

  upsert(id, vector, meta = {}) {
    const rows = this._read();
    const idx = rows.findIndex(r => r.id === id);
    const row = { id, vector, meta, updatedAt: Date.now() };
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    if (this._rows) { this._maybeFlush(); return row; }   // 批量模式：延后落盘
    this._write(rows);
    return row;
  }

  remove(id) {
    const rows = this._read();
    const keep = rows.filter(r => r.id !== id);
    if (this._rows) { this._rows = keep; this._maybeFlush(); return; }
    this._write(keep);
  }

  clear() { if (this._rows) { this._rows = []; this._pending = 0; return; } this._write([]); }

  ids() {
    return this._read().map(r => r.id);
  }

  countPrefix(prefix) {
    return this._read().filter(r => r.id.startsWith(prefix)).length;
  }

  removePrefix(prefix) {
    const rows = this._read();
    const keep = rows.filter(r => !r.id.startsWith(prefix));
    const removed = rows.length - keep.length;
    if (removed) {
      if (this._rows) { this._rows = keep; this._maybeFlush(); }
      else this._write(keep);
    }
    return removed;
  }

  search(queryVector, k = 5) {
    return this._read()
      .map(r => ({ ...r, score: similarity(queryVector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  count() { return this._read().length; }
}
