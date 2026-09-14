// dsh-memory 插件核心：索引 / 检索 / KV 记忆
import fs from "node:fs";
import path from "node:path";
import { splitIntoChunks } from "./chunker.mjs";
import { VectorStore } from "./store.mjs";
import { KvMemory } from "./kv.mjs";
import { EmbedProvider } from "./embed-provider.mjs";
import { findSensitive } from "./sensitive.mjs";
import { envOr } from "../../../lib/env-fallback.mjs";

const SKIP = new Set([".git", "node_modules", "bin", "obj", ".vs", "dist", ".venv", "packages", ".memory"]);

export function defaultDataDir() {
  // 用户级配置 → 经 env-fallback（DSH 宿主是长活进程，进程环境里没有用户后来设的变量）。
  if (envOr('DSH_MEMORY_DIR')) return envOr('DSH_MEMORY_DIR')
  const home = envOr('DSH_HOME') || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : "");
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

  /**
   * 语义检索。
   *
   * ⚠ **返回里不带向量**（2026-09-11 真机自查）：`store.search` 的每一行都含 1536 维浮点向量，
   * 而 MCP 面是 `jtext()` **直出原始对象**的 —— 一次 k=5 的检索会往 agent 的上下文里塞约 5×1536 个数
   * （几万字符），真正的信息（文件、片段、分数）被淹没。agent 用不上向量，这里一律剥掉，
   * 只留 `id / score / meta`，并给 `text` 设一个上限（片段本来就是给人读的）。
   */
  async search(query, k = 5) {
    const { hits } = await this.searchDetailed(query, k);
    return hits;
  }

  /**
   * 带**索引新鲜度**的检索（两个面都用它；`search()` 保持返回数组不变，避免破坏既有调用方）。
   *
   * 为什么必须回答"索引是不是旧的"（2026-09-12「用户可见结论的最坏情况」主题实测，最后一条）：
   *   改文件后**不重索引**再检索，命中的 3 条**全是旧内容**（文本里根本没有新 token），而返回里
   *   没有任何字段提示"这是索引里的旧快照" ⇒ agent 会把**过期内容当现状引用** ——
   *   这比"没命中"更危险（没命中至少会促使人去查）。
   *   索引本来就存了 `meta.mtime`（增量跳过靠它），所以可以**精确**判断：拿命中文件在索引时的 mtime
   *   与磁盘现在的 mtime 比 —— 变了 / 文件没了，就如实标出来。
   */
  async searchDetailed(query, k = 5) {
    const qv = await this.embed.embed(query);
    const hits = this.store.search(qv, k);
    const out = hits.map(({ vector, ...rest }) => {
      const o = { ...rest, score: typeof rest.score === 'number' ? Math.round(rest.score * 10000) / 10000 : rest.score };
      if (o.meta && typeof o.meta.text === 'string' && o.meta.text.length > 800) {
        o.meta = { ...o.meta, text: o.meta.text.slice(0, 800) + '…（片段已截断，需要全文请直接读该文件）' };
      }
      return o;
    });
    const stale = [];
    const gone = [];
    for (const h of out) {
      const meta = h.meta || {};
      if (!meta.root || !meta.file) continue;
      let now;
      try { now = fs.statSync(path.join(meta.root, meta.file)); } catch { gone.push(meta.file); continue; }
      if (Number.isFinite(Number(meta.mtime)) && Math.abs(now.mtimeMs - Number(meta.mtime)) > 1000) stale.push(meta.file);
    }
    const uniq = (a) => [...new Set(a)];
    const staleFiles = uniq(stale);
    const goneFiles = uniq(gone);
    return {
      hits: out,
      freshness: {
        indexedSnapshot: true,
        staleFiles,
        deletedFiles: goneFiles,
        note: (staleFiles.length || goneFiles.length)
          ? '⚠ 命中来自**索引快照**，但源文件已变化：' +
            (staleFiles.length ? staleFiles.length + ' 个文件**在索引之后被改过**（' + staleFiles.slice(0, 3).join('、') + (staleFiles.length > 3 ? ' 等' : '') + '）' : '') +
            (staleFiles.length && goneFiles.length ? '；' : '') +
            (goneFiles.length ? goneFiles.length + ' 个文件**已不存在**' : '') +
            ' —— **返回的片段可能是旧内容**，不要直接当成现状引用。下一步：对该目录重跑 memory_index 后重新检索。'
          : null,
      },
    };
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
