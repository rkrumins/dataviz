/**
 * Anchor Rail selection — pure ranking/budgeting for the docked partner
 * proxies (focus-scoped rail).
 *
 * Every rendering layer on the canvas has an explicit budget; the rail's
 * is ANCHOR_RAIL_CAP chips per column. Candidates are ranked by bundled
 * edge count (strongest flows earn the slots) with the node id as a
 * deterministic tie-break so the rail never reshuffles between frames.
 * Partners beyond the cap are reported as `moreCount` — the UI routes
 * that overflow to the Lineage Lens, which lists every connection,
 * grouped and searchable.
 */
import type { AnchorProxy, AnchorProxyGroup } from './types'

export const ANCHOR_RAIL_CAP = 5
/** How many of a proxy's entities it keeps (`realIds`) for a click to open
 *  the card down to. */
export const RAIL_REVEAL_CAP = 5

export type AnchorProxyCandidate = AnchorProxy & { layerId: string }

/** Who a focus line really reaches, and which way it flows. */
export type RailPartner = Pick<AnchorProxy, 'flow' | 'realId' | 'partners' | 'realIds'>

/** A drawn line as the projection hands it over. Its `members` are the
 *  relationships it stands for, filed under the drawn ends (`source`,
 *  `target`) with the ends they name kept in `_origSource`/`_origTarget` —
 *  what the relationship drawer lists (drawerEdgeTarget's memberRef). */
export interface RailLine {
  source: string
  isBidirectional?: boolean
  data?: {
    members?: ReadonlyArray<{ source: string; target: string; _origSource?: string; _origTarget?: string }>
  }
}

/**
 * The partner a focus line docks for, and its flow relative to the focus.
 * `partnerId` is the card drawn at the far end; the entities the line's
 * relationships really reach there may be inside it. Several of them are
 * counted (`partners`), never named for one: the rail would name the card.
 */
export function railPartner(line: RailLine, focusId: string, partnerId: string): RailPartner {
  const members = line.data?.members
  if (!members || members.length === 0) {
    // A trace wire carries no members: its ends are the entities.
    return { flow: line.isBidirectional ? 'both' : line.source === focusId ? 'out' : 'in' }
  }
  const far = new Set<string>()
  let out = false
  let into = false
  for (const m of members) {
    if (m.source === focusId) {
      out = true
      far.add(m._origTarget ?? m.target)
    } else {
      into = true
      far.add(m._origSource ?? m.source)
    }
  }
  const flow = out && into ? 'both' : out ? 'out' : 'in'
  if (far.size > 1) {
    const realIds: string[] = []
    for (const id of far) {
      if (realIds.length === RAIL_REVEAL_CAP) break
      realIds.push(id)
    }
    return { flow, partners: far.size, realIds }
  }
  const [only] = far
  return only === partnerId ? { flow } : { flow, realId: only }
}

export function groupAnchorProxies(
  candidates: Iterable<AnchorProxyCandidate>,
  cap: number = ANCHOR_RAIL_CAP,
): Map<string, AnchorProxyGroup> {
  const byLayer = new Map<string, AnchorProxyCandidate[]>()
  for (const c of candidates) {
    const list = byLayer.get(c.layerId)
    if (list) list.push(c)
    else byLayer.set(c.layerId, [c])
  }
  const out = new Map<string, AnchorProxyGroup>()
  byLayer.forEach((list, layerId) => {
    list.sort((a, b) => b.count - a.count || (a.nodeId < b.nodeId ? -1 : 1))
    out.set(layerId, {
      proxies: list.slice(0, cap).map(({ layerId: _layerId, ...proxy }) => proxy),
      moreCount: Math.max(0, list.length - cap),
    })
  })
  return out
}

/** Stable fingerprint of a rail payload — the overlay pushes a payload
 *  to React only when this changes (its compute pass runs per frame
 *  during scroll). Empty string means "no rail". A proxy's `isFocus` is
 *  its `nodeId` being the focus, already in it. */
export function anchorRailFingerprint(
  focusId: string | null,
  groups: Map<string, AnchorProxyGroup>,
): string {
  if (!focusId || groups.size === 0) return ''
  const parts: string[] = [focusId]
  const layerIds = Array.from(groups.keys()).sort()
  for (const layerId of layerIds) {
    const g = groups.get(layerId)!
    parts.push(
      `${layerId}=${g.proxies.map(p =>
        `${p.nodeId}:${p.count}:${p.direction}:${p.flow}:${p.realId ?? ''}:${p.partners ?? ''}:${p.realIds?.join(' ') ?? ''}`,
      ).join(',')}+${g.moreCount}`,
    )
  }
  return parts.join('|')
}
