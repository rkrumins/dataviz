/**
 * How a set of picks hangs together, as the Connect step tells it: which of
 * them lineage joins directly, which only through steps the subset leaves
 * out (virtual hops), which join nothing else picked (isolated), and which
 * the walk could not finish for.
 */
import type { LineageBridgeIncomplete, LineageBridgeLink } from '@/providers/GraphDataProvider'

export interface SubsetConnectivity {
  /** Links of one raw step. */
  direct: readonly LineageBridgeLink[]
  /** Links through hidden steps, shortest first. */
  virtual: readonly LineageBridgeLink[]
  /** Picks no link reaches or leaves. */
  isolated: readonly string[]
  /** Picks whose links may be missing (the walk could not finish). */
  incomplete: readonly string[]
}

export function summarizeConnectivity(
  pickUrns: readonly string[],
  links: readonly LineageBridgeLink[],
  incomplete: readonly LineageBridgeIncomplete[] = [],
): SubsetConnectivity {
  const picked = new Set(pickUrns)
  const joined = new Set<string>()
  const direct: LineageBridgeLink[] = []
  const virtual: LineageBridgeLink[] = []
  for (const l of links) {
    if (!picked.has(l.source) || !picked.has(l.target)) continue
    joined.add(l.source)
    joined.add(l.target)
    if (l.hops <= 1) direct.push(l)
    else virtual.push(l)
  }
  virtual.sort((a, b) => a.hops - b.hops || a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
  const unfinished = new Set(incomplete.map(i => i.urn).filter(u => picked.has(u)))
  return {
    direct,
    virtual,
    // An entity the walk could not finish for may well have links — it is
    // unknown, not isolated.
    isolated: pickUrns.filter(u => !joined.has(u) && !unfinished.has(u)),
    incomplete: pickUrns.filter(u => unfinished.has(u)),
  }
}
