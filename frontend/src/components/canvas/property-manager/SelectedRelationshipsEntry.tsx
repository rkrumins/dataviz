/**
 * SelectedRelationshipsEntry — "Compare the N selected relationships": with two or more
 * relationships selected on the canvas (as the Edge Explorer selects them), the Property Manager
 * opens them in the relationship drawer, read side by side and changed together
 * (`MultiRelationshipView`). A selected line the canvas holds no relationship for is not counted.
 */
import { ChevronRight, Columns3 } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { edgeIndexOf } from '@/lib/storeIndex'
import { memberFromEdge, targetFromMembers } from '@/lib/drawerEdgeTarget'

type CanvasState = ReturnType<typeof useCanvasStore.getState>

/** The selected relationships, as the canvas holds them. */
const selectedEdges = (s: CanvasState) => {
  const index = edgeIndexOf(s.edges)
  return s.selectedEdgeIds.flatMap((id) => index.get(id) ?? [])
}

export function SelectedRelationshipsEntry() {
  const count = useCanvasStore((s) => selectedEdges(s).length)
  if (count < 2) return null
  const compare = () => {
    const s = useCanvasStore.getState()
    s.openEdgeDrawer(targetFromMembers(selectedEdges(s).map(memberFromEdge)))
  }
  return (
    <button
      type="button"
      onClick={compare}
      className="mb-3 flex w-full items-center gap-3 rounded-2xl border border-accent-lineage/30 bg-accent-lineage/[0.06] px-3.5 py-2.5 text-left hover:bg-accent-lineage/[0.1] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
    >
      <Columns3 className="w-4 h-4 text-accent-lineage shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] font-semibold text-ink">Compare the {count.toLocaleString()} selected relationships</span>
        <span className="block text-[11px] text-ink-muted">Read their properties side by side — and change them together</span>
      </span>
      <ChevronRight className="w-3.5 h-3.5 text-accent-lineage shrink-0" aria-hidden />
    </button>
  )
}
