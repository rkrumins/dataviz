/**
 * The identity a virtual-hop answer is filed under: WHICH entities a view
 * holds, and whether each takes in what sits beneath it — nothing else about
 * them. Two listings of the same set key the same, in any order, so
 * rearranging a view's layers or renaming it never costs a fresh walk.
 *
 * Hashed rather than joined: a view can hold two thousand members, and the
 * query cache stringifies its keys on every lookup.
 */
import type { LineageBridgeMember } from '@/providers/GraphDataProvider'

export function memberSetKey(members: readonly LineageBridgeMember[]): string {
  const parts = members.map(m => `${m.inheritsChildren === false ? '0' : '1'}${m.urn}`)
  parts.sort()
  return `${parts.length}:${cyrb53(parts.join('\n'))}`
}

/** A fast 53-bit string hash (cyrb53). A collision would serve one member
 *  set another's answer; at 2^53 that is not a practical concern. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
