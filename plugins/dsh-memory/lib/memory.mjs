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

/**
 * 索引的**时间预算**（每次 `memory_index` 调用最多跑多久）。
 *
 * ⚠ 为什么必须有（2026-09-15 用户当场报的缺陷：「每次调用 memory_index 就把自己卡死」）：
 *   `embed()` 单个请求**有** 20 秒超时（F-053），所以卡的**不是单个请求** —— 卡的是**总量**：
 *   原实现对一个目录里的**每个分块串行 `await embed()`**，没有预算、没有进度、不能续跑。
 *   一个 1 MB 的目录就有几百块，每块一次远程往返（几百 ms ~ 秒级）⇒ 一次调用就是几分钟到几十分钟。
 *   调用方（agent）在上限内等不到返回就被打断，而它拿不到任何"做到哪了"的信息 ⇒ 只能重来 ⇒ 又卡死。
 *   ⇒ 修法不是"调大超时"，是**让每次调用都有确定的上界**，并把"没做完的部分"变成**下次能接着做**。
 */
const DEFAULT_BUDGET_MS = Math.max(5000, Number(process.env.DSH_MEMORY_INDEX_BUDGET_MS) || 60000);
/** 并发度：串行是"卡死"的主因之一；有上界即可，别把远程 API 打爆。 */
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.DSH_MEMORY_INDEX_CONCURRENCY) || 4));
/** 单个文件的字节上限：**一个几十 MB 的文件能吃掉整个预算**，而它对检索的价值密度极低。超限就跳过并如实报出。 */
const DEFAULT_MAX_FILE_BYTES = Math.max(64 * 1024, Number(process.env.DSH_MEMORY_MAX_FILE_BYTES) || 2 * 1024 * 1024);


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

  /**
   * 索引**一个文件**。
   *
   * ★ 2026-09-15 重写（用户报「每次调用 memory_index 就把自己卡死」）—— 两条不变量：
   *
   *   ① **全有或全无**：这个文件的分块要么**全部**落库，要么**一块都不留**。
   *      为什么不是"能写多少写多少"：`indexWorkspace` 的增量跳过判据是
   *      `countPrefix("file:<路径>:<mtime>:") > 0`（只要有一块就当已索引）——
   *      半索引的文件**会被永久跳过**，那部分内容**静默地从检索里消失**。
   *      所以预算用尽或被中断时，要把这次写进去的块**删掉**，让下一次干净重做。
   *   ② **有界**：每个分块前检查 `deadline`，到点就停（返回 `deferred`），绝不"再等一会儿就完了"。
   *      并发有上界（串行是卡死主因；但仍要有限，别把远程 API 打爆）。
   */
  async indexFile(filePath, relPath, rootDir, { evict = true, deadline = Infinity, concurrency = DEFAULT_CONCURRENCY, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    const st = fs.statSync(filePath);
    if (st.size > maxFileBytes) return { chunks: 0, sensitive: [], tooBig: st.size };   // 如实报"没索引，因为太大"
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
    let failed = null, done = 0, cursor = 0;
    const worker = async () => {
      for (;;) {
        if (failed) return;
        if (Date.now() >= deadline) return;                 // 预算用尽：交给下一次
        const i = cursor++;
        if (i >= chunks.length) return;
        const c = chunks[i];
        try {
          const vector = await this.embed.embed(c.text);
          this.store.upsert(key + "#" + c.index, vector, { ...meta, chunkIndex: c.index, text: c.text });
          done++;
        } catch (e) { failed = e; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, worker));
    if (done === chunks.length) return { chunks: chunks.length, sensitive: [] };
    // 没做完 ⇒ **回滚这一个文件**（不变量①）。回滚数量如实带出去，便于人核对"确实一块都没留"。
    const removed = this.store.removePrefix(key);
    if (failed) {
      return { chunks: 0, sensitive: [], failed: String((failed && failed.message) || failed).slice(0, 300), rolledBack: removed };
    }
    return { chunks: 0, sensitive: [], deferred: true, rolledBack: removed };
  }

  /**
   * 索引一个目录。
   *
   * ⚠ 返回里**必须**能看出"这次做到哪了、还剩多少、为什么停"（2026-09-15）：
   *   原实现只返回 `{files, chunks, indexed, skipped, sensitiveSkipped, deleted}` ——
   *   被预算/超时打断时，调用方看到的数字**和"全做完了"长得一模一样**（既没说没做完，也没说还剩多少）。
   *   而"再调一次就能接着做"这件事本来天然成立（已完成的文件按 mtime 被跳过），**只是没人告诉调用方**。
   */
  async indexWorkspace(rootDir, opts = {}) {
    const startedAt = Date.now();
    const budgetMs = Number.isFinite(Number(opts.budgetMs)) && Number(opts.budgetMs) > 0
      ? Math.max(1000, Number(opts.budgetMs)) : DEFAULT_BUDGET_MS;
    const deadline = startedAt + budgetMs;
    const concurrency = Number.isFinite(Number(opts.concurrency)) && Number(opts.concurrency) > 0
      ? Math.max(1, Math.min(16, Number(opts.concurrency))) : DEFAULT_CONCURRENCY;
    const maxFileBytes = Number.isFinite(Number(opts.maxFileBytes)) && Number(opts.maxFileBytes) > 0
      ? Number(opts.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;

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
    files.sort();   // 定序：连续两次调用处理的是同一串文件（进度可预测、可核对）
    let total = 0, indexed = 0, skipped = 0, sensitiveSkipped = 0;
    let processed = 0, deferred = 0, stoppedBy = 'done';
    let stoppedIn = null;
    const failedFiles = [], sizeSkippedFiles = [];
    // ⚠ F-053：整段索引放进**批量模式**。原来每插一块都会"全量解析 + 重写整个 43MB 文件"，
    //   2182 块 ⇒ 约 95GB I/O —— 这才是"慢到会被打断"的根因；而被打断又撞上非原子写 ⇒ 一次全清。
    //   现在：只读一次、每 200 块原子落盘一次、结束时收尾。**中断最多丢最后一批，不会丢历史。**
    //
    // ⚠ 2026-09-15（本机实测）：`beginBatch()` 要**读并解析整个索引文件**（实测 59 MB / 2953 块时，
    //   这一步本身就要一两分钟）—— 而 deadline 是从函数入口算起的**绝对时刻**，于是真机上出现过
    //   「预算 90 秒、调用跑了 242 秒」：时间**全花在装载上**，装载完才开始干活。
    //   所以：① 把装载耗时单独报出来（`loadMs`，让人看得见时间去哪了）；
    //        ② **装载完先看预算还在不在** —— 不在就立刻返回，一个字都不处理
    //           （否则调用方等的是"装载 + 一段工作"，比只等装载更没有上界）。
    const loadStart = Date.now();
    this.store.beginBatch({ flushEvery: 200 });
    const loadMs = Date.now() - loadStart;
    try {
      if (Date.now() >= deadline) {
        stoppedBy = 'budget'; stoppedIn = 'load';   // 预算在装载阶段就用完了
      } else
      for (const f of files) {
        if (Date.now() >= deadline) { stoppedBy = 'budget'; stoppedIn = 'files'; break; }
        const rel = path.relative(rootDir, f);
        let st;
        try { st = fs.statSync(f); } catch { processed++; continue; }
        if (this.store.countPrefix("file:" + f + ":" + st.mtimeMs) > 0) { skipped++; processed++; continue; } // mtime 未变 → 增量跳过
        try {
          const r = await this.indexFile(f, rel, rootDir, { deadline, concurrency, maxFileBytes });
          processed++;
          if (r.tooBig) sizeSkippedFiles.push({ file: rel, bytes: r.tooBig });
          else if (r.failed) failedFiles.push({ file: rel, error: r.failed });
          else if (r.sensitive.length) sensitiveSkipped++;
          else if (r.deferred) { deferred++; stoppedBy = 'budget'; break; }   // 这一个文件都没做完 ⇒ 后面的下次再说
          else { total += r.chunks; indexed++; }
        } catch (e) {
          processed++;
          failedFiles.push({ file: rel, error: String((e && e.message) || e).slice(0, 300) });
        }
      }
    } finally {
      // 无论成功、抛错还是被中断，**已 flush 的分块都在盘上**（每次都原子）；
      // 这里再收尾一次，把最后不足一批的部分落下去。
      try { this.store.endBatch(); } catch { /* 收尾落盘失败不改变已落盘部分 */ }
    }
    // 清理已从磁盘删除的文件的陈旧分块。判定只看"磁盘上文件是否还存在"，
    // 与当前索引的根无关——索引 B 仓库不再清掉 A 仓库的块。
    // 兼容护栏：旧版（升级前）的键存的是相对路径，isAbsolute 为 false——
    // 这类旧键一律不动（孤儿块无害），绝不误删。
    let deleted = 0;
    const sweepStart = Date.now();
    for (const id of this.store.ids()) {
      const i = id.lastIndexOf(":");
      if (i <= "file:".length) continue;
      const p = id.slice(0, i);
      if (!p.startsWith("file:")) continue;
      const abs = p.slice("file:".length);
      if (!path.isAbsolute(abs)) continue;
      if (!fs.existsSync(abs)) deleted += this.store.removePrefix(p + ":");
    }
    const sweepMs = Date.now() - sweepStart;
    const remaining = Math.max(0, files.length - processed);
    const elapsedMs = Date.now() - startedAt;
    return {
      files: files.length, chunks: total, indexed, skipped, sensitiveSkipped, deleted,   // 原有字段（兼容）
      processedFiles: processed, remainingFiles: remaining, deferredFiles: deferred,
      failedFiles, sizeSkippedFiles, stoppedBy, stoppedIn, budgetMs, concurrency,
      loadMs, sweepMs, elapsedMs,   // 时间去哪了：装载 / 收尾清扫 / 总计
      nextStep: (stillWork => stillWork
        ? '**本次没做完**（' + (stoppedBy === 'budget' ? '到了时间预算 ' + budgetMs + 'ms' : '有中断') +
          (stoppedIn === 'load' ? '，而且**预算是花在装载索引上的**（loadMs=' + loadMs + '）' : '') +
          '）：还剩 ' + remaining +
          ' 个文件。**再调一次 memory_index(同一个 path) 就能接着做** —— 已完成的文件按 mtime 被跳过，不会重做；' +
          '想一次多做一些可以传更大的 budgetMs（或设 DSH_MEMORY_INDEX_BUDGET_MS）。' +
          (stoppedIn === 'load' ? '⚠ 索引文件越大装载越慢（实测 59MB/2953 块要一两分钟）—— 这种情况**再调一次也没用**，要么显著调大 budgetMs，要么把索引目录拆小。' : '')
        : '本次已处理完全部文件。')(remaining > 0 || deferred > 0 || failedFiles.length > 0),
    };
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
