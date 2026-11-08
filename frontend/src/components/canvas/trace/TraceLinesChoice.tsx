import { cn } from '@/lib/utils'
import type { LineageRenderMode } from '@/store/preferences'
import { chooseTraceLineMode, useTraceLineMode } from '@/store/traceLineMode'

const LINE_OPTIONS: Array<{ mode: LineageRenderMode; label: string; description: string }> = [
  { mode: 'stubs', label: 'On hover', description: 'A card’s lines appear when you point at it or pick it' },
  { mode: 'auto', label: 'Adaptive', description: 'The strongest lines stay drawn, the traced entity’s own first' },
  { mode: 'raw', label: 'Every line', description: 'Every line the trace walks, all the time' },
]

/**
 * How many of the trace's lines draw at once: Display's density modes,
 * applied to the trace (store/traceLineMode.ts). A choice here is kept for
 * every trace after it, in the view you're in. Wherever lines are left
 * undrawn, the cards' markers still show where the lineage goes. Trace
 * settings carries it as Lines, Display's How many lines as While tracing.
 */
export function TraceLinesChoice({ label = 'Lines', disabled = false }: { label?: string; disabled?: boolean }) {
  const mode = useTraceLineMode()
  return (
    <div className="pb-2">
      <div className="px-1 pb-1 text-[11px] font-semibold text-ink">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
        {LINE_OPTIONS.map(opt => {
          const active = mode === opt.mode
          return (
            <button
              key={opt.mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => chooseTraceLineMode(opt.mode)}
              className={cn(
                'flex items-start gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors',
                disabled && 'cursor-not-allowed',
                active
                  ? 'bg-accent-lineage/15 border-accent-lineage/40 shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/35'
                  : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                  active ? 'border-accent-lineage' : 'border-ink-muted/40',
                )}
              >
                {active && <div className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn('text-[12px] font-medium leading-tight', active ? 'text-accent-lineage' : 'text-ink')}>
                  {opt.label}
                </div>
                <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">{opt.description}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
