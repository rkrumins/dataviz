import { Hash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferencesStore } from '@/store/preferences'

/** "N on this lineage" pills on the trace's cards — how much of what is
 *  inside a closed card the lineage runs through. On by default; persisted
 *  with the other canvas preferences. */
export function LineageCountsToggle() {
  const show = usePreferencesStore((s) => s.showLineageCounts) ?? true
  const toggle = usePreferencesStore((s) => s.toggleLineageCounts)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={show}
      aria-label="Lineage counts on cards"
      onClick={toggle}
      className={cn(
        'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        show
          ? 'bg-accent-lineage/12 border-accent-lineage/35 shadow-sm shadow-accent-lineage/10'
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          show ? 'bg-accent-lineage/85' : 'bg-ink-muted/25 dark:bg-white/15',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
            show ? 'left-[15px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[12px] font-medium leading-tight flex items-center gap-1.5',
            show ? 'text-accent-lineage' : 'text-ink',
          )}
        >
          <Hash className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>Lineage counts on cards</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
          Show “N on this lineage” beside each closed card
        </div>
      </div>
    </button>
  )
}
