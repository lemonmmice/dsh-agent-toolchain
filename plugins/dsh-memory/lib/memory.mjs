// dsh-memory 插件核心：索引 / 检索 / KV 记忆
import fs from "node:fs";
import path from "node:path";
import { splitIntoChunks } from "./chunker.mjs";
import { VectorStore } from "./store.mjs";
import { KvMemory } from "./kv.mjs";
import { EmbedProvider } from "./embed-provider.mjs";
import { findSensitive } from "./sensitive.mjs";

const SKIP = new Set([".git", "node_modules", "bin", "obj", ".vs", "dist", ".venv", "packages", ".memory"]);

export function defaultDataDir() {
  const home = process.env.DSH_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : "");
  return path.join(home, "memory");
}

export class DshMemory {
  constructor({ dataDir = null, project = "default", embedProvider = null } = {}) {
    this.dataDir = dataDir || defaultDataDir();
    this.project = project;
    this.embed = embedProvider || new EmbedProvider({ cacheDir: path.join(this.dataDir, ".cache") });
    this.store = new VectorStore(path.join(this.dataDir, "vectors"), project);
    this.kv = new KvMemory(path.join(this.dataDir, "kv"));
  }

  async indexFile(filePath, relPath, { evict = true } = {}) {
    const st = fs.statSync(filePath);
    const meta = { file: relPath, mtime: st.mtimeMs, size: st.size };
    const prefix = "file:" + relPath + ":";
    if (evict) this.store.removePrefix(prefix); // 陈旧分块淘汰：文件更新后不留旧块
    const key = prefix + st.mtimeMs;
    const chunks = splitIntoChunks(fs.readFileSync(filePath, "utf-8"));
    for (const c of chunks) {
      const vector = await this.embed.embed(c.text);
      this.store.upsert(key + "#" + c.index, vector, { ...meta, chunkIndex: c.index, text: c.text });
    }
    return chunks.length;
  }

  async indexWorkspace(rootDir) {
    const files = [];
    const stack = [rootDir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(md|txt|json|yaml|yml|cs|ts|js|mjs|py|xaml|xml|html|vue|sql)$/i.test(e.name)) files.push(p);
      }
    }
    let total = 0, indexed = 0, skipped = 0;
    const relPaths = new Set();
    for (const f of files) {
      const rel = path.relative(rootDir, f);
      relPaths.add(rel);
      const st = fs.statSync(f);
      if (this.store.countPrefix("file:" + rel + ":" + st.mtimeMs) > 0) { skipped++; continue; } // mtime 未变 → 增量跳过
      try { total += await this.indexFile(f, rel); indexed++; }
      catch { /* skip unreadable */ }
    }
    // 清理已从磁盘删除的文件的陈旧分块
    let deleted = 0;
    for (const id of this.store.ids()) {
      const i = id.lastIndexOf(":");
      if (i <= 0) continue;
      const p = id.slice(0, i);
      if (!p.startsWith("file:")) continue;
      if (!relPaths.has(p.slice("file:".length))) deleted += this.store.removePrefix(p + ":");
    }
    return { files: files.length, chunks: total, indexed, skipped, deleted };
  }

  async search(query, k = 5) {
    const qv = await this.embed.embed(query);
    return this.store.search(qv, k);
  }

  remember(key, value, scope = "global") {
    const hits = findSensitive(String(value));
    if (hits.length) {
      throw new Error("value contains sensitive content (" + hits.map(h => h.name).join(", ") + ") — rewrite without tokens/keys and retry");
    }
    return this.kv.save(key, value, scope);
  }
  recall(key, scope = "global") { return this.kv.get(key, scope); }
  memories(scope) { return this.kv.all(scope); }
  forget(key, scope = "global") { return this.kv.forget(key, scope); }

  status() {
    return { project: this.project, chunks: this.store.count(), kvEntries: this.kv.all().length, dataDir: this.dataDir, embed: this.embed.label };
  }
}
