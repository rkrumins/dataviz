/**
 * SubsetHeaderActions — the Context View header's right cluster while the
 * Subset Studio is open: which mode the canvas is in, how much is picked,
 * and the two ways out. A focused mode — the comprehension tools come back
 * when the studio closes.
 */
import { ScissorsLineDashed } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'

export interface SubsetModeProps {
  count: number
  onCancel: () => void
  onSave?: () => void
}

export function SubsetHeaderActions({ count, onCancel, onSave }: SubsetModeProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-explore/10 text-accent-explore text-[12px] font-semibold">
        <ScissorsLineDashed className="w-3.5 h-3.5" aria-hidden="true" />
        Subset studio
        <span className="font-medium tabular-nums text-ink-secondary">
          · {count.toLocaleString()} picked
        </span>
      </span>
      <HoverTip label="Leave the studio" detail="You will be asked before your picks are discarded">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/40"
        >
          Cancel
        </button>
      </HoverTip>
      {onSave && (
        <HoverTip label={count === 0 ? 'Pick at least one entity first' : 'Name the subset and choose who sees it'}>
          <button
            type="button"
            onClick={onSave}
            disabled={count === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold text-white bg-accent-explore shadow-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-explore/50"
          >
            Save as view…
          </button>
        </HoverTip>
      )}
    </div>
  )
}
