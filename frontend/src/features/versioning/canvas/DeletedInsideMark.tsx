/**
 * DeletedInsideMark — "N deleted inside", on a Context View row: deletions directly under it that
 * the canvas hasn't drawn (it draws 500 at most, parent first). Choosing it draws them, up to 200 at
 * a time, and opens the row. Nothing at all where none are hidden.
 */
import { Trash2 } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { DELETED_INSIDE_DRAWN, hiddenDeletionsUnder } from './deletedInside'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export function DeletedInsideMark({ urn, onOpen }: { urn: string; onOpen: () => void }) {
  const hidden = useCanvasStore((s) => s.deletedHidden.get(urn) ?? 0)
  const containmentTypes = useContainmentEdgeTypes()
  if (hidden === 0) return null
  const drawing = Math.min(hidden, DELETED_INSIDE_DRAWN)
  return (
    <HoverTip className="inline-flex" label={`${hidden.toLocaleString()} deleted inside, not drawn`}
      detail={hidden > drawing ? `Draws ${drawing} of them here; choose it again for more.` : 'Draws them here.'}>
      <button
        type="button"
        aria-label={`Draw ${drawing.toLocaleString()} of ${hidden.toLocaleString()} deleted inside`}
        onClick={(e) => {
          e.stopPropagation()
          useCanvasStore.getState().pinGhosts(hiddenDeletionsUnder(urn, containmentTypes))
          onOpen()
        }}
        className="inline-flex items-center gap-0.5 shrink-0 rounded-md border border-rose-500/25 bg-rose-500/[0.06] px-1 py-px text-[10px] font-semibold tabular-nums text-rose-600 dark:text-rose-400 hover:bg-rose-500/[0.12] transition-colors"
      >
        <Trash2 className="w-2.5 h-2.5" aria-hidden /> {compact.format(hidden)}
      </button>
    </HoverTip>
  )
}
