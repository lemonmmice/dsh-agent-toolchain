/**
 * Shared child-process output decoder: try UTF-8 first, fall back to GBK
 * (the Windows system codepage — PowerShell/MSBuild emit GBK on CN-locale
 * boxes). Single source of truth for every process consumer in lib/ and
 * plugins/, so error text is never mojibake again.
 */
export function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  try {
    return { text: utf8.decode(b), enc: 'utf-8' }
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(b), enc: 'gbk' }
    } catch {
      return { text: b.toString('utf8'), enc: 'fallback' }
    }
  }
}
