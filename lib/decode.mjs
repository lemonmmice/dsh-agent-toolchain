/**
 * Shared child-process output decoder: try UTF-8 first, fall back to GBK
 * (the Windows system codepage — PowerShell/MSBuild emit GBK on CN-locale
 * boxes). Single source of truth for every process consumer in lib/ and
 * plugins/, so error text is never mojibake again.
 */
export function decodeBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '')
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b), enc: 'utf-16le' }
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b), enc: 'utf-16be' }
  }
  let oddNuls = 0
  let evenNuls = 0
  const sampleLength = Math.min(b.length, 512)
  for (let index = 0; index < sampleLength; index++) {
    if (b[index] !== 0) continue
    if ((index & 1) === 0) evenNuls++
    else oddNuls++
  }
  if (b.length % 2 === 0 && sampleLength >= 8 && (oddNuls >= sampleLength / 4 || evenNuls >= sampleLength / 4)) {
    const littleEndian = oddNuls >= evenNuls
    const encoding = littleEndian ? 'utf-16le' : 'utf-16be'
    return { text: new TextDecoder(encoding).decode(b), enc: encoding }
  }
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
