/**
 * Words and actions the relationship drawer shares between its relationship
 * and connection views.
 */
import type { EdgeKind } from '@/services/ontologyPreflightService'
import type { RelationshipTypeSchema } from '@/types/schema'
import { edgeTypeCopy, relationshipLabel } from '@/lib/relationshipLabel'
import { useCanvasStore } from '@/store/canvas'
import { useEdgeFiltersStore } from '@/hooks/useEdgeFilters'

/** A relationship type's name and meaning: this app's own wording first, then
 *  the ontology's, then the id made readable. */
export function relationshipCopy(
  type: string,
  relationshipTypes: RelationshipTypeSchema[],
): { label: string; description?: string } {
  const own = edgeTypeCopy(type)
  const rt = relationshipTypes.find((r) => r.id.toLowerCase() === type.toLowerCase())
  return {
    label: own?.label ?? rt?.name ?? (type ? relationshipLabel(type) : 'Relationship'),
    description: own?.description ?? rt?.description,
  }
}

/** What each kind of relationship is, and — for all but lineage — why it is not edited here. */
export const KIND_COPY: Readonly<Record<EdgeKind, { label: string; readOnly?: string }>> = {
  lineage: { label: 'Lineage' },
  rollup: {
    label: 'Combined flow',
    readOnly: 'A summary the aggregation job computes from the relationships beneath it — change those instead.',
  },
  containment: {
    label: 'Hierarchy',
    readOnly: 'A hierarchy link. Change where an item sits with “Move to”.',
  },
  other: {
    label: 'Association',
    readOnly: 'This type of relationship is not authored on the canvas.',
  },
}

/** Swap the drawer for the Edge Explorer, with these edges selected in it. */
export function openInEdgeExplorer(edgeIds: string[]): void {
  const s = useCanvasStore.getState()
  s.closeNodeDrawer()
  s.clearSelection()
  edgeIds.forEach((id, i) => s.selectEdge(id, i > 0))
  useEdgeFiltersStore.getState().openDetailPanel()
}
