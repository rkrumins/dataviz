/**
 * SearchActiveChip — a search is still shaping the canvas, and here is how to
 * stop it.
 *
 * An Advanced Search keeps its highlights on the canvas after its panel
 * closes, which is the point: the reader closes the panel to look at the
 * board. But with the panel gone nothing said WHY rows were amber, dimmed,
 * or missing altogether — Isolate and Hide take rows off the canvas — and the
 * only way out was to find the panel again. So while a search is on and its
 * panel is closed, the canvas says so, in the status stack beside the
 * narrowing it is modelled on (NarrowChip): what is being highlighted or
 * hidden, and how many; a step through the matches; the panel back; Clear.
 *
 * Coloured as the mode is, in MatchBar's colours — amber, the row highlight
 * itself, for Highlight; violet for Show only matches; rose for Hide — so the
 * chip and the rows it explains read as one thing.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { usePersonaMode } from '@/store/persona'
import {
  useCanvasFilterMode,
  useFocusedMatchIndex,
  useSearchStore,
  useStepCount,
  type CanvasFilterMode,
} from '@/store/searchStore'

export type SearchChipUnit = 'match' | 'path' | 'connection'

export interface SearchActiveChipProps {
  /** How many the search found: its total, else what it holds. */
  count: number
  /** What it counts. Only matches can be stepped through from here. */
  unit: SearchChipUnit
  /** The layers its matches are in, by name, as far as the page in hand says. */
  layerNames: readonly string[]
  /** The view the search belongs to — a mode change is remembered per view. */
  viewId: string
  /** Show the match the stepper is now on, on the canvas. */
  onReveal: () => void
  /** Open the search panel again. */
  onOpen: () => void
  /** Clear the search, and every highlight it put on the canvas. */
  onClear: () => void
}

const UNIT: Record<SearchChipUnit, [string, string]> = {
  match: ['search match', 'search matches'],
  path: ['route', 'routes'],
  connection: ['connection', 'connections'],
}

/** Per mode: what the rows are doing, said both ways, in the mode's colours. */
const MODE: Record<CanvasFilterMode, {
  verb: string
  technical: string
  detail: string
  mark: string
  ring: string
}> = {
  highlight: {
    verb: 'Highlighting',
    technical: 'Highlight',
    detail: 'Everything else is dimmed, not hidden.',
    mark: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    ring: 'ring-amber-500/35',
  },
  isolate: {
    verb: 'Showing only',
    technical: 'Isolate',
    detail: 'Rows that don’t match are hidden from the canvas.',
    mark: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
    ring: 'ring-violet-500/35',
  },
  hide: {
    verb: 'Hiding',
    technical: 'Hide',
    detail: 'Matching rows are hidden; everything else is shown.',
    mark: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
    ring: 'ring-rose-500/35',
  },
}

const quiet = cn(
  'pointer-events-auto inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] font-semibold whitespace-nowrap',
  'text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
)
const stepButton = cn(
  'grid place-items-center w-6 h-6 rounded-md text-ink-muted hover:text-ink',
  'hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
)

export function SearchActiveChip({ count, unit, layerNames, viewId, onReveal, onOpen, onClear }: SearchActiveChipProps) {
  const mode = useCanvasFilterMode()
  const focused = useFocusedMatchIndex()
  const steps = useStepCount()
  const technical = usePersonaMode() === 'technical'
  const meta = MODE[mode]
  const [one, many] = UNIT[unit]
  const where = layerNames.length > 1
    ? ` across ${layerNames.length.toLocaleString()} layers`
    : layerNames.length === 1 ? ` in ${layerNames[0]}` : ''
  const filtering = mode !== 'highlight'
  // Stepping walks matches; a path or a connection is shown from the panel.
  const stepper = unit === 'match' && steps > 0
  const step = (direction: 'prev' | 'next') => {
    useSearchStore.getState().stepFocus(direction)
    onReveal()
  }

  return (
    <div className="pointer-events-none flex w-full justify-center">
      <motion.div
        role="status"
        aria-label="A search is shaping the canvas"
        data-search-mode={mode}
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={MOTION.modalSpring}
        className={cn(
          'pointer-events-auto flex items-center gap-3 w-full min-w-0 max-w-[760px]',
          'pl-3 pr-2 py-2 rounded-2xl backdrop-blur-xl',
          'bg-white/85 dark:bg-neutral-900/85',
          'ring-1', meta.ring,
          'shadow-xl shadow-black/[0.08] dark:shadow-black/50',
        )}
      >
        <span className={cn('flex-none grid place-items-center w-7 h-7 rounded-full', meta.mark)} aria-hidden="true">
          {mode === 'highlight' ? <LucideIcons.Search className="w-3.5 h-3.5" strokeWidth={2.4} />
            : mode === 'isolate' ? <LucideIcons.Filter className="w-3.5 h-3.5" strokeWidth={2.4} />
              : <LucideIcons.EyeOff className="w-3.5 h-3.5" strokeWidth={2.4} />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 font-display text-[12.5px] text-ink leading-tight min-w-0">
            <span className="truncate">
              {meta.verb} <strong className="font-semibold tabular-nums">{count.toLocaleString()}</strong>{' '}
              {count === 1 ? one : many}{where}
            </span>
            {technical && (
              <span className={cn('flex-none px-1.5 py-px rounded-md text-[9.5px] font-semibold uppercase tracking-wide', meta.mark)}>
                {meta.technical}
              </span>
            )}
          </span>
          <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-tight truncate">{meta.detail}</span>
        </span>

        {stepper && (
          <span className="flex-none flex items-center gap-0.5" role="group" aria-label="Step through the matches">
            <HoverTip className="flex" label="Previous match" detail="Shown on the canvas">
              <button type="button" onClick={() => step('prev')} className={stepButton} aria-label="Previous match">
                <LucideIcons.ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.4} />
              </button>
            </HoverTip>
            <span className="px-0.5 text-center text-[10.5px] text-ink-muted tabular-nums whitespace-nowrap" aria-live="polite">
              {focused === null ? `${steps.toLocaleString()} to step` : `${(focused + 1).toLocaleString()} of ${steps.toLocaleString()}`}
            </span>
            <HoverTip className="flex" label="Next match" detail="Shown on the canvas">
              <button type="button" onClick={() => step('next')} className={stepButton} aria-label="Next match">
                <LucideIcons.ChevronRight className="w-3.5 h-3.5" strokeWidth={2.4} />
              </button>
            </HoverTip>
          </span>
        )}

        <span className="flex items-center gap-0.5 flex-none">
          {/* The way back to every row, one click, where the search is hiding some. */}
          {filtering && (
            <HoverTip className="flex" label="Show every row again" detail="The matches stay highlighted">
              <button
                type="button"
                onClick={() => useSearchStore.getState().setCanvasFilterMode('highlight', viewId)}
                className={quiet}
              >
                <LucideIcons.Eye className="w-3 h-3" aria-hidden="true" />
                Show all rows
              </button>
            </HoverTip>
          )}
          <HoverTip className="flex" label="Open the search" detail="Its results, and how it filters the canvas" shortcut="⌘⇧F">
            <button type="button" onClick={onOpen} className={quiet}>
              <LucideIcons.PanelLeftOpen className="w-3 h-3" aria-hidden="true" />
              Open search
            </button>
          </HoverTip>
          <HoverTip className="flex" label="Clear the search" detail="Takes every highlight off the canvas" shortcut="Esc">
            <button
              type="button"
              onClick={onClear}
              className={cn(quiet, 'text-accent-lineage hover:text-accent-lineage hover:bg-accent-lineage/10')}
            >
              <LucideIcons.X className="w-3 h-3" aria-hidden="true" />
              Clear
            </button>
          </HoverTip>
        </span>
      </motion.div>
    </div>
  )
}
