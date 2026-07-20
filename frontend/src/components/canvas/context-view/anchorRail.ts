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

export type AnchorProxyCandidate = AnchorProxy & { layerId: string }

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
 *  during scroll). Empty string means "no rail". */
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
      `${layerId}=${g.proxies.map(p => `${p.nodeId}:${p.count}:${p.direction}`).join(',')}+${g.moreCount}`,
    )
  }
  return parts.join('|')
}
