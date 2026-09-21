/**
 * SelectionBar — what the canvas is holding, and what will happen to it.
 *
 * A selection only exists here to be acted on, so the bar answers both
 * questions at once: WHICH entities are held (named, and removable one by
 * one — a count alone cannot be corrected), and WHAT each action will do
 * with them. Where the Focus Lens cannot take a multi-selection it says so
 * in words rather than presenting a dead button, because "why is this
 * greyed out" is the question a disabled control always leaves behind.
 *
 * It appears only for a selection of SEVERAL. One entity is already fully
 * served: its row is highlighted, the drawer opens on it, and the header's
 * Trace and Focus Lens act on it — a bar repeating that would be chrome
 * with nothing new to say, and a second control named "Trace lineage"
 * beside the header's own.
 *
 * Docked bottom-centre over the columns, above the trace dock, and it
 * reserves its own band (`--selection-bar-height`) so a column's last row
 * can still scroll clear of it — see useBandReservation.
 */
import { useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { useBandReservation } from './useBandReservation'

/** Entities named in full before the rest are summarised. Four fits the bar
 *  at a narrow canvas width without wrapping; beyond that the count carries
 *  the meaning and the names stop earning their room. */
const NAMED_LIMIT = 4

export interface SelectionBarProps {
  /** The held entities, in selection order. */
  nodeIds: readonly string[]
  /** Display name for an entity — falls back to the id when unresolved. */
  labelFor: (id: string) => string
  onRemove: (id: string) => void
  onClear: () => void
  /** Trace every held entity (the union of their lineage). */
  onTrace: () => void
  /** Open the Focus Lens on the selection as a whole. */
  onOpenLens: () => void
}

export function SelectionBar({
  nodeIds,
  labelFor,
  onRemove,
  onClear,
  onTrace,
  onOpenLens,
}: SelectionBarProps) {
  const ref = useRef<HTMLDivElement>(null)
  useBandReservation(ref, '--selection-bar-height')

  const count = nodeIds.length
  const named = nodeIds.slice(0, NAMED_LIMIT)
  const rest = count - named.length

  return (
    <AnimatePresence>
      {count > 1 && (
        <motion.div
          ref={ref}
          role="region"
          aria-label="Selected entities"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={MOTION.modalSpring}
          // Positioned as a LANE, not a centred pill. Three pieces of chrome
          // already own the bottom of the canvas and this has to clear all of
          // them: it stacks ABOVE the layer strip (which sits in the same band
          // as the trace dock), and stops short of the right-hand Data
          // loads / Flows column (w-80 at right-4) instead of sliding under it
          // — which is what put the Trace button out of reach.
          className="absolute z-50 left-4 pointer-events-none flex justify-center"
          style={{
            right: 'calc(20rem + 1.75rem)',
            bottom: 'calc(0.75rem + var(--trace-dock-height, 0px) + var(--layer-strip-height, 0px))',
          }}
        >
        <div
          className={cn(
            'pointer-events-auto max-w-full',
            'flex items-center gap-4',
            'pl-4 pr-3 py-2.5 rounded-2xl',
            'bg-canvas-elevated backdrop-blur-xl',
            'border border-accent-lineage/35',
            'shadow-xl shadow-black/10 dark:shadow-black/40',
          )}
        >
          {/* What is held. The number is the one thing read at a glance. */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex items-baseline gap-1.5 shrink-0">
              <span className="text-lg font-semibold text-accent-lineage tabular-nums leading-none">
                {count}
              </span>
              <span className="text-xs text-ink-muted">entities</span>
            </span>

            <span className="h-4 w-px bg-glass-border shrink-0" aria-hidden />

            <ul className="flex items-center gap-1.5 min-w-0 overflow-hidden">
              {named.map((id) => (
                <li key={id} className="min-w-0">
                  <span
                    className={cn(
                      'group inline-flex items-center gap-1 max-w-[11rem]',
                      'pl-2 pr-1 py-1 rounded-lg',
                      'bg-accent-lineage/10 border border-accent-lineage/25',
                    )}
                  >
                    <span className="truncate text-[11.5px] text-ink" title={labelFor(id)}>
                      {labelFor(id)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemove(id)}
                      aria-label={`Remove ${labelFor(id)} from the selection`}
                      className={cn(
                        'shrink-0 p-0.5 rounded-md text-ink-muted',
                        'hover:bg-black/10 hover:text-ink dark:hover:bg-white/15',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                        'transition-colors duration-150',
                      )}
                    >
                      <LucideIcons.X className="w-3 h-3" strokeWidth={2.4} />
                    </button>
                  </span>
                </li>
              ))}
              {rest > 0 && (
                <li className="shrink-0 text-[11.5px] text-ink-muted whitespace-nowrap">
                  and {rest} more
                </li>
              )}
            </ul>
          </div>

          {/* What will happen. */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <button
              type="button"
              onClick={onOpenLens}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12.5px] font-medium',
                'text-teal-700 dark:text-teal-300',
                'bg-teal-500/10 border border-teal-500/35',
                'hover:bg-teal-500/20 hover:border-teal-400/55',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/40',
                'transition-colors duration-150',
              )}
            >
              <LucideIcons.Focus className="w-3.5 h-3.5" strokeWidth={2.2} />
              Focus all {count}
            </button>
            <button
              type="button"
              onClick={onTrace}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-[12.5px] font-medium',
                'text-accent-lineage bg-accent-lineage/15 border border-accent-lineage/45',
                'hover:bg-accent-lineage/25 hover:border-accent-lineage/65',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50',
                'transition-colors duration-150',
              )}
            >
              <LucideIcons.Workflow className="w-3.5 h-3.5" strokeWidth={2.2} />
              Trace all {count}
            </button>
            <button
              type="button"
              onClick={onClear}
              className={cn(
                'px-2.5 py-1.5 rounded-xl text-[12.5px] text-ink-muted',
                'hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.08]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                'transition-colors duration-150',
              )}
            >
              Clear
            </button>
          </div>
        </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
