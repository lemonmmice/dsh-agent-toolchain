// dsh-memory 插件核心：索引 / 检索 / KV 记忆
import fs from "node:fs";
import path from "node:path";
import { splitIntoChunks } from "./chunker.mjs";
import { VectorStore } from "./store.mjs";
import { KvMemory } from "./kv.mjs";
import { EmbedProvider } from "./embed-provider.mjs";

const SKIP = new Set([".git", "node_modules", "bin", "obj", ".vs", "dist", ".venv", "packages", ".memory"]);

export function defaultDataDir() {
  const home = process.env.DSH_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : "");
  return path.join(home, "memory");
}

export class DshMemory {
  constructor({ dataDir = null, project = "default" } = {}) {
    this.dataDir = dataDir || defaultDataDir();
    this.project = project;
    this.embed = new EmbedProvider({ cacheDir: path.join(this.dataDir, ".cache") });
    this.store = new VectorStore(path.join(this.dataDir, "vectors"), project);
    this.kv = new KvMemory(path.join(this.dataDir, "kv"));
  }

  async indexFile(filePath, relPath) {
    const st = fs.statSync(filePath);
    const meta = { file: relPath, mtime: st.mtimeMs, size: st.size };
    const key = "file:" + relPath + ":" + st.mtimeMs;
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
    let total = 0;
    for (const f of files) {
      try { total += await this.indexFile(f, path.relative(rootDir, f)); }
      catch { /* skip unreadable */ }
    }
    return { files: files.length, chunks: total };
  }

  async search(query, k = 5) {
    const qv = await this.embed.embed(query);
    return this.store.search(qv, k);
  }

  remember(key, value, scope = "global") { return this.kv.save(key, value, scope); }
  recall(key, scope = "global") { return this.kv.get(key, scope); }
  memories(scope) { return this.kv.all(scope); }
  forget(key, scope = "global") { return this.kv.forget(key, scope); }

  status() {
    return { project: this.project, chunks: this.store.count(), kvEntries: this.kv.all().length, dataDir: this.dataDir, embed: this.embed.label };
  }
}
