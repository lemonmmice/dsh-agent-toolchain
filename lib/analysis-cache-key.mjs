/**
 * 分析缓存键（审计 L07：「缓存的 key 至少包含输入内容/版本、工具版本、PID/进程过滤、provider、
 * 符号策略、JIT 数据和参数。路径相同不意味着证据相同」）。
 *
 * 现状：trace/perf 的复用多按**输出路径是否存在**判定（reuse=true + xmlPath 存在）。本模块给出一个
 * **按输入指纹**的稳定键，供 ETL / JIT / dump 分析缓存统一口径 —— 相同输入才命中，任一维度变化即不同键，
 * 缺失的维度用显式 'none' 占位（而非忽略），避免"少一个维度的旧键"误命中。
 *
 * ⚠ 边界（分级交付 / Windows 真机待验）：本模块是纯 JS 的键构造 + 失效判定，可离线单测；但把它接到
 * PerfView / xperf / ClrMD 的 ETL/JIT 解码结果共享缓存、以及实际的缓存命中率与耗时收益度量，需要
 * Windows 真机 + 真实 ETL/dump —— 本环境不声称验证过那部分收益。
 */
import { createHash } from 'node:crypto'

const str = (v) => (v === undefined || v === null ? 'none' : String(v))

function stableParams(params) {
  if (!params || typeof params !== 'object') return str(params)
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))
}

/**
 * 构造分析缓存键。返回 { key, parts }：key 是 sha256 十六进制，parts 是参与计算的规范化维度（便于诊断）。
 */
export function analysisCacheKey({ kind, inputDigest, toolVersion, pid, processFilter, provider, symbolStrategy, jitData, params } = {}) {
  const parts = {
    kind: str(kind),
    inputDigest: str(inputDigest),       // 输入内容/版本指纹（ETL/dump 的 sha 或 size+mtime 指纹）
    toolVersion: str(toolVersion),       // 分析器 / 工具链版本
    pid: str(pid),                       // 采集时进程身份
    processFilter: str(processFilter),
    provider: str(provider),             // clr / kernel / alloc 等
    symbolStrategy: str(symbolStrategy), // offline / srv* / none
    jitData: str(jitData),
    params: stableParams(params),        // 其余参数（键排序后稳定序列化，顺序无关）
  }
  return { key: createHash('sha256').update(JSON.stringify(parts)).digest('hex'), parts }
}

/** 两次分析的输入是否等价（同键即可复用缓存结果）。 */
export function sameAnalysisInputs(a, b) {
  return Boolean(a && b && a.key === b.key)
}
