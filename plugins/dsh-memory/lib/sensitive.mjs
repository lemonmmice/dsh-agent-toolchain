// 敏感字符串过滤器：memory_save 落盘前的最后一道闸。
// 命中即拒绝保存（fail-closed）——宁可重写记忆内容，也不让真实凭证落盘。
export const PATTERNS = [
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'x-access-token', re: /\bx-access-token:[A-Za-z0-9_]+/gi },
  { name: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9._-]{16,}/gi },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'labeled-secret', re: /\b(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd)\b[\s"':=]+["']?[A-Za-z0-9+/_-]{16,}/gi },
]

export function findSensitive(text) {
  const s = String(text ?? '')
  const hits = []
  for (const p of PATTERNS) {
    const m = s.match(p.re)
    if (m) hits.push({ name: p.name, sample: m[0].slice(0, 40) })
  }
  return hits
}

export function isSensitive(text) {
  return findSensitive(text).length > 0
}
