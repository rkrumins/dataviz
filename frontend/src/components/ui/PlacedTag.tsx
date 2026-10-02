/**
 * "Placed" — the one mark, on the canvas and in the View Wizard alike, for an entity a view places in
 * a layer or group apart from where it sits in the data. Violet: the colour of arranging a view (it
 * never changes the data source). Always paired with "Part of <path>".
 */
import { LayoutGrid } from 'lucide-react'

export function PlacedTag() {
  return (
    <span className="inline-flex items-center gap-1 flex-shrink-0 px-1.5 py-px rounded-md border border-violet-400/30 bg-violet-500/10 text-violet-600 dark:text-violet-300 text-[9.5px] font-semibold tracking-wide">
      <LayoutGrid className="w-2.5 h-2.5" aria-hidden />
      Placed
    </span>
  )
}
