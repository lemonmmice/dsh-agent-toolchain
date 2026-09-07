// 文档切块：按段落/行数切，中文友好，带重叠
const MAX_CHARS = 800;
const OVERLAP = 100;

export function splitIntoChunks(text, { maxChars = MAX_CHARS, overlap = OVERLAP } = {}) {
  const paragraphs = String(text ?? "").split(/\n{2,}|(?<=[。！？；])\s*/);
  const chunks = [];
  let buf = "";
  for (const p of paragraphs) {
    const t = p.trim();
    if (!t) continue;
    if ((buf + "\n" + t).length <= maxChars) {
      buf = buf ? buf + "\n" + t : t;
      continue;
    }
    if (buf) { chunks.push(buf); buf = t; }
    else {
      // 单段超长：硬切
      for (let i = 0; i < t.length; i += maxChars - overlap) {
        chunks.push(t.slice(i, i + maxChars));
      }
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks.map((c, i) => ({ index: i, text: c.trim() })).filter(c => c.text);
}
