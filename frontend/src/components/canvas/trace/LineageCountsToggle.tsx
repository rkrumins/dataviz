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
          ? 'bg-indigo-500/10 border-indigo-500/40 dark:bg-indigo-400/15 dark:border-indigo-400/35'
          : 'bg-black/[0.03] border-black/[0.08] hover:bg-black/[0.05] dark:bg-white/[0.03] dark:border-white/[0.08] dark:hover:bg-white/[0.06]',
      )}
    >
      {/* Track + knob in explicit colours: the lineage token is a hex CSS
          variable, so Tailwind opacity modifiers on it render nothing. */}
      <div
        className={cn(
          'flex-shrink-0 w-[34px] h-[20px] rounded-full relative transition-colors duration-200 ring-1 ring-inset',
          show
            ? 'bg-indigo-500 ring-indigo-600/40 dark:bg-indigo-400 dark:ring-indigo-300/40'
            : 'bg-slate-300 ring-slate-400/40 dark:bg-white/20 dark:ring-white/10',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-4 h-4 rounded-full bg-white shadow-md shadow-black/25 transition-all duration-200',
            show ? 'left-[16px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[12px] font-semibold leading-tight flex items-center gap-1.5',
            show ? 'text-indigo-600 dark:text-indigo-300' : 'text-ink',
          )}
        >
          <Hash className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>Lineage counts on cards</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
          Show “N on this lineage” beside each closed card
        </div>
        <div
          className={cn(
            'text-[10.5px] font-semibold leading-snug mt-1',
            show ? 'text-indigo-600 dark:text-indigo-300' : 'text-ink-muted/60',
          )}
        >
          {show ? 'On — counts shown' : 'Off — cards stay bare'}
        </div>
      </div>
    </button>
  )
}
