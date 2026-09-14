// 原子写：**先写临时文件，再 rename 覆盖**，并留一份 `.bak`。
//
// 为什么必须有（2026-09-14 真事故，F-053）：
//   向量库与 KV 库原来都用 `fs.writeFileSync(file, …)` **原地覆盖** —— 它会**先截断再写**。
//   我在 `memory_index` 上被卡住、调用被打断，正好落在"截断之后、写完之前"，
//   于是 **43.9 MB / 2182 块的向量索引变成 0 字节**，而且**没有任何备份**。
//   ⇒ `writeFileSync` 原地覆盖 + 无备份 = **一次中断就能清掉全部历史**。
//
// `rename` 在同一卷上是原子的：要么看到旧文件，要么看到完整的新文件，**不会看到空的**。
import fs from "node:fs";
import path from "node:path";

/**
 * 把 rows（每项会被 JSON.stringify）原子地写进 file。
 * @param {string} file 目标路径
 * @param {any[]} rows 行数据
 * @param {{keepBak?: boolean}} [opts] keepBak 默认 true：写之前把旧文件留成 `<file>.bak`
 * @returns {{bytes:number, bak:string|null, tmp:string}}
 */
export function writeJsonlAtomic(file, rows, { keepBak = true } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // ⚠ 先把内容**全部序列化到内存**：序列化抛错时，磁盘上的旧文件**一个字节都没被碰过**。
  //   （这正是"截断后再序列化"最危险的地方 —— 序列化失败=文件已空。）
  const payload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const tmp = file + ".tmp-" + process.pid;
  let bak = null;
  fs.writeFileSync(tmp, payload);
  try {
    if (keepBak && fs.existsSync(file)) {
      bak = file + ".bak";
      fs.copyFileSync(file, bak);
    }
    fs.renameSync(tmp, file);   // 同卷原子替换
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 清理失败不改变结论 */ }
    throw e;
  }
  return { bytes: Buffer.byteLength(payload), bak, tmp };
}
