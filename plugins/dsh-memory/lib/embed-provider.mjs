// embedding provider：MiniMax embo-01 优先；无 key 时降级为字符 bigram 稀疏向量（零成本开箱可用）
import fs from "node:fs";
import path from "node:path";

function readCreds() {
  try {
    const f = path.join(process.env.DSH_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : path.join(require("node:os").homedir(), ".dsh")), ".credentials.yaml");
    if (!fs.existsSync(f)) return {};
    const out = {};
    for (const line of fs.readFileSync(f, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+):\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

// 字符 bigram 稀疏向量：中文友好、零依赖、可比较相似度
function bigramVector(text) {
  const s = String(text ?? "").toLowerCase();
  const map = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  let norm = 0;
  for (const v of map.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return { map, norm };
}

export class EmbedProvider {
  constructor({ cacheDir = null, apiKey = undefined } = {}) {
    this.mode = "minimax";
    this.apiKey = apiKey !== undefined ? apiKey : (process.env.MINIMAX_CN_API_KEY || readCreds().MINIMAX_CN_API_KEY || null);
    this.baseURL = "https://api.minimax.chat/v1";
    this.model = "embo-01";
    if (!this.apiKey) this.mode = "bigram";
    this.cacheDir = cacheDir;
  }

  get label() { return this.mode === "minimax" ? "MiniMax embo-01" : "bigram（本地降级）"; }

  async embed(text) {
    if (this.mode === "bigram") {
      const { map, norm } = bigramVector(text);
      return { sparse: map, norm, dim: 0, kind: "bigram" };
    }
    if (this.cacheDir) {
      let h = 0;
      for (const ch of text) { h = ((h << 5) - h + ch.charCodeAt(0)) | 0; }
      const cp = path.join(this.cacheDir, "emb-" + (h >>> 0).toString(36) + ".json");
      if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, "utf-8")).vector;
    }
    const res = await fetch(this.baseURL + "/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.apiKey },
      body: JSON.stringify({ model: this.model, texts: [String(text).slice(0, 8000)], type: "query" })
    });
    const data = await res.json();
    if (!res.ok || !data.vectors?.[0]) throw new Error("embedding 失败: " + res.status + " " + JSON.stringify(data).slice(0, 200));
    const vector = data.vectors[0];
    if (this.cacheDir) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      let h = 0;
      for (const ch of text) { h = ((h << 5) - h + ch.charCodeAt(0)) | 0; }
      fs.writeFileSync(path.join(this.cacheDir, "emb-" + (h >>> 0).toString(36) + ".json"), JSON.stringify({ vector }));
    }
    return vector;
  }
}

// 混合余弦：dense 向量用标准余弦；bigram 稀疏向量用内积/范数
export function similarity(a, b) {
  if (a && a.kind === "bigram" && b && b.kind === "bigram") {
    let dot = 0;
    // sparse 在内存中是 Map，但经 JSONL 持久化读回后是普通对象——两种都要能吃
    const am = a.sparse instanceof Map ? a.sparse : new Map(Object.entries(a.sparse || {}));
    const bm = b.sparse instanceof Map ? b.sparse : new Map(Object.entries(b.sparse || {}));
    for (const [g, v] of am) {
      const w = bm.get(g);
      if (w) dot += v * w;
    }
    return dot / (a.norm * b.norm);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }
  return 0;
}
