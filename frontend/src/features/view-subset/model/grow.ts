/**
 * Growing a pick along its lineage, at the grain the view speaks.
 *
 * The links come from the lineage-bridges walk over the SOURCE view's own
 * members, so "one step upstream" of an entity is the nearest entities of the
 * view that feed it — however many raw steps lie between — and "all" is
 * everything upstream of it the view holds. Pure: the canvas hands in the
 * links; nothing here asks the network.
 */
import type { LineageBridgeLink } from '@/providers/GraphDataProvider'

export type GrowDirection = 'upstream' | 'downstream'
export type GrowDepth = 'one' | 'all'

export interface MemberGraph {
  /** member → the members it feeds */
  down: ReadonlyMap<string, readonly string[]>
  /** member → the members that feed it */
  up: ReadonlyMap<string, readonly string[]>
}

export function memberGraph(links: readonly LineageBridgeLink[]): MemberGraph {
  const down = new Map<string, string[]>()
  const up = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k)
    if (list) { if (!list.includes(v)) list.push(v) } else m.set(k, [v])
  }
  for (const l of links) {
    if (l.source === l.target) continue
    push(down, l.source, l.target)
    push(up, l.target, l.source)
  }
  return { down, up }
}

/**
 * The members reached from `from` going `direction` — the next ones (`one`)
 * or everything onward (`all`) — nearest first, ties in the order met. Never
 * `from` itself, and nothing in `from`: growing twice from a set that already
 * holds its neighbours adds nothing.
 */
export function reachFrom(
  graph: MemberGraph,
  from: Iterable<string>,
  direction: GrowDirection,
  depth: GrowDepth,
): string[] {
  const next = direction === 'upstream' ? graph.up : graph.down
  const start = new Set(from)
  const seen = new Set(start)
  const out: string[] = []
  let frontier = [...start]
  while (frontier.length > 0) {
    const level: string[] = []
    for (const u of frontier) {
      for (const v of next.get(u) ?? []) {
        if (seen.has(v)) continue
        seen.add(v)
        level.push(v)
      }
    }
    out.push(...level)
    if (depth === 'one') break
    frontier = level
  }
  return out
}
