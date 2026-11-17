/**
 * committedEdges — which drawn line a relationship saved on the draft (by hand, or by an import)
 * is, and the colour of its halo: emerald added, orange edited, rose removed — the entities' ring
 * colours. A line is found by its id, or else by its two ends: an imported edge's id is not the
 * canvas's, its ends are.
 */
import type { ChangeSet, ChangeStatus } from '../model/changeModel'

export const COMMITTED_EDGE_COLOR: Record<ChangeStatus, string> = {
  added: '#10b981', modified: '#f97316', removed: '#f43f5e',
}

export interface CommittedEdgeLookup {
  /** The halo colour for a drawn line, or undefined when the draft did not change it. */
  colorOf: (line: { id: string; source: string; target: string }) => string | undefined
}

const NONE: CommittedEdgeLookup = { colorOf: () => undefined }

export function committedEdgeLookup(changeSet: ChangeSet | null | undefined): CommittedEdgeLookup {
  if (!changeSet || changeSet.changes.length === 0) return NONE
  const byId = new Map<string, string>()
  const byEnds = new Map<string, string>()
  for (const c of changeSet.changes) {
    if (c.kind !== 'edge') continue
    const color = COMMITTED_EDGE_COLOR[c.status]
    byId.set(c.entityId, color)
    if (c.sourceUrn && c.targetUrn) byEnds.set(`${c.sourceUrn}|${c.targetUrn}`, color)
  }
  if (byId.size === 0) return NONE
  return { colorOf: (l) => byId.get(l.id) ?? byEnds.get(`${l.source}|${l.target}`) }
}
