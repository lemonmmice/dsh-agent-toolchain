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
  if (process.env.DSH_MEMORY_DIR) return process.env.DSH_MEMORY_DIR
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

  async indexFile(filePath, relPath, rootDir, { evict = true } = {}) {
    const st = fs.statSync(filePath);
    const meta = { file: relPath, root: rootDir, mtime: st.mtimeMs, size: st.size };
    // Keys carry the ABSOLUTE path so multiple roots can coexist and the
    // eviction sweep can judge existence on disk instead of on "is this file
    // part of the root being indexed right now" (which wiped other roots).
    const prefix = "file:" + filePath + ":";
    if (evict) this.store.removePrefix(prefix); // 陈旧分块淘汰：文件更新后不留旧块
    const key = prefix + st.mtimeMs;
    const text = fs.readFileSync(filePath, "utf-8");
    // Fail-closed sensitive screening on the INDEX path, not just KV save:
    // a chunk containing a token/secret must never be embedded, because
    // embedding may egress to a remote API.
    const hits = findSensitive(text);
    if (hits.length) return { chunks: 0, sensitive: hits.map((h) => h.name) };
    const chunks = splitIntoChunks(text);
    for (const c of chunks) {
      const vector = await this.embed.embed(c.text);
      this.store.upsert(key + "#" + c.index, vector, { ...meta, chunkIndex: c.index, text: c.text });
    }
    return { chunks: chunks.length, sensitive: [] };
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
    let total = 0, indexed = 0, skipped = 0, sensitiveSkipped = 0;
    for (const f of files) {
      const rel = path.relative(rootDir, f);
      const st = fs.statSync(f);
      if (this.store.countPrefix("file:" + f + ":" + st.mtimeMs) > 0) { skipped++; continue; } // mtime 未变 → 增量跳过
      try {
        const r = await this.indexFile(f, rel, rootDir);
        if (r.sensitive.length) sensitiveSkipped++;
        else { total += r.chunks; indexed++; }
      }
      catch { /* skip unreadable */ }
    }
    // 清理已从磁盘删除的文件的陈旧分块。判定只看"磁盘上文件是否还存在"，
    // 与当前索引的根无关——索引 B 仓库不再清掉 A 仓库的块。
    // 兼容护栏：旧版（升级前）的键存的是相对路径，isAbsolute 为 false——
    // 这类旧键一律不动（孤儿块无害），绝不误删。
    let deleted = 0;
    for (const id of this.store.ids()) {
      const i = id.lastIndexOf(":");
      if (i <= "file:".length) continue;
      const p = id.slice(0, i);
      if (!p.startsWith("file:")) continue;
      const abs = p.slice("file:".length);
      if (!path.isAbsolute(abs)) continue;
      if (!fs.existsSync(abs)) deleted += this.store.removePrefix(p + ":");
    }
    return { files: files.length, chunks: total, indexed, skipped, sensitiveSkipped, deleted };
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
    return {
      project: this.project,
      chunks: this.store.count(),
      kvEntries: this.kv.all().length,
      dataDir: this.dataDir,
      embed: this.embed.label,
      embedEndpoint: this.embed.mode === "minimax" ? "remote (api.minimax.chat)" : "local",
      note: this.embed.mode === "minimax"
        ? "embedding runs on a REMOTE API: indexed file chunks leave this machine. Unset the MiniMax API key to force local bigram mode."
        : "embeddings are computed locally (bigram fallback).",
    };
  }
}
