import { createHash } from 'node:crypto'

export const PRIVATE_REFERENCES = [
  [3, '68ebcf03fd2a9e9456ce8a9ea4c880d7165748d1ebf1ca30efb48df0e5509678'],
  [9, '6413a03496fb2e5730f3f4284bea920488a0382cf0cbcacf9b820fb4b1a62d78'],
  [5, 'ddc7541aceb715778124982d9896c77f5e61cad681e80aaf1b66e15f0b93172f'],
  [9, '79829d8d240605df23e2d992ad3d8b931e732920165c2a38f8860fa276ae22c7'],
  [3, 'e9f140ed02c7be3b70deaba4bb3bbae02f27cf8b5c51bf61a4f54cebc79f8bc0'],
  [6, 'c5691d0c8eeb7d21bb6327d11612322445b5d36f909589c2701367322123e4b4'],
  [10, '620354639aa5ce6db51806569cc5c9c135805ffb4b0d7234a809cfdf0ea525b1'],
  [5, '603a9be53c6ec45dce1b9bfe0e92913d5f696aabd9382a1aafbb767967fc6ca9'],
  [5, '1889c03aee475cc8f8835e08d083530f72e774eee30906bb2446e671e391335a'],
  [9, '507ad8b5733703c72d4ec5b052d6d7347df236534ccf1142f201c00349a655be'],
  [18, '529ecbce5628cb2a71a137568a17359b113266b582db8f40247cc4e7f959ec78'],
  [9, '911d4d292dd5bcf2ffa60429013d29ce306f71262b2b7883c7fe0d6c5405f478'],
  [11, 'be137f42c255292afaffd50c8d893f56c407f6a6ed665c116511420825c7217b'],
  [13, '41e0a56e67e2fab1ca60f6f838387eacaf9a70256e74a035500b2e205dca018d'],
  [18, 'b251bc6e889624c3f2a003b3a401fcfed4232faeec14e07d6137f40a5a11589b'],
]

export function createPrivateReferenceScanner(references = PRIVATE_REFERENCES) {
  const byLength = new Map()
  for (const [length, digest] of references) {
    if (!byLength.has(length)) byLength.set(length, new Set())
    byLength.get(length).add(digest)
  }
  const cache = new Map()
  return (text) => {
    for (const match of String(text).toLowerCase().matchAll(/[\p{L}\p{N}_:\\/-]+/gu)) {
      const token = match[0]
      if (!cache.has(token)) {
        let found = false
        for (const [length, digests] of byLength) {
          for (let offset = 0; offset + length <= token.length; offset++) {
            const candidate = token.slice(offset, offset + length)
            if (/^[a-z]:[\\/]/.test(candidate) && offset > 0 && /[a-z0-9_]/.test(token[offset - 1])) continue
            const digest = createHash('sha256').update(candidate).digest('hex')
            if (digests.has(digest)) { found = true; break }
          }
          if (found) break
        }
        cache.set(token, found)
      }
      if (cache.get(token)) return true
    }
    return false
  }
}
