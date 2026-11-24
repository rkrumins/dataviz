/**
 * ActiveSearchToken — the search shaping the canvas, said inside the header's
 * search box, and how to step through it, change it or put it away.
 *
 * A search keeps its highlights on the canvas after its panel closes — that
 * is the point — and Show only and Hide take rows off the canvas altogether.
 * Something has to say so, and offer the way out. It used to be a chip in the
 * canvas's status stack, which sat over the top of the columns for as long as
 * the search stood. The box is where the search came from and where the next
 * one starts, so it says it here instead, and nothing is drawn over the board:
 *
 *   * `advanced` — the box's words do not describe the search: it was run
 *     from the panel, a recipe or a right-click, or the box has been emptied.
 *     The token stands where the placeholder would, and says what the search
 *     is doing: "Highlighting 42 matches".
 *   * `typed` — the box's own words are the search. They already say what was
 *     asked, so the token only adds the count and the step.
 *
 * Coloured as the mode is — amber, the row highlight itself, for Highlight;
 * violet for Show only; rose for Hide — so the token and the rows it explains
 * read as one thing. It gives up room rather than squeeze the input: its words
 * go first, then the step, then the ×, and whatever it no longer shows is in
 * its card, which also holds the mode, the layers the matches are in, Edit and
 * Clear. While the panel is open the panel steps through the matches itself,
 * so the token does not.
 *
 * The card is anchored the way the box's Look in and Match lists are
 * (`useAnchoredPopover`): portalled, entrance-only motion, focus in on open
 * and back to the token on close. It owns its keys, so Esc in it closes it
 * rather than clearing the search under it.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useMemo } from 'react'

import { HoverTip } from '@/components/ui/HoverTip'
import { Segmented } from '@/components/ui/Segmented'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { cn } from '@/lib/utils'
import { usePersonaMode } from '@/store/persona'
import {
  useCanvasFilterMode,
  useFocusedMatchIndex,
  useMatchUrnSet,
  useSearchStore,
  useStepCount,
  type CanvasFilterMode,
} from '@/store/searchStore'

import { useViewSearchSession } from '../../../search/session/ViewSearchSessionContext'
import { useAnchoredPopover } from './useAnchoredPopover'

type Unit = 'match' | 'path' | 'connection'

const UNIT: Record<Unit, [string, string]> = {
  match: ['match', 'matches'],
  path: ['route', 'routes'],
  connection: ['connection', 'connections'],
}

/** Per mode: what the rows are doing, said both ways, in the mode's colours. */
const MODE: Record<CanvasFilterMode, {
  verb: string
  label: string
  technical: string
  detail: string
  icon: LucideIcon
  /** The icon's disc in the card. */
  mark: string
  /** The token itself: tint, edge and ink. */
  token: string
  /** A control inside the token, hovered; `active`, held open. */
  hover: string
  active: string
  /** The mode's own ink, on a neutral ground. */
  ink: string
}> = {
  highlight: {
    verb: 'Highlighting',
    label: 'Highlight',
    technical: 'Highlight',
    detail: 'Everything else is dimmed, not hidden.',
    icon: LucideIcons.Search,
    mark: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    token: 'bg-amber-500/[0.11] ring-amber-500/35 text-amber-700 dark:bg-amber-400/[0.12] dark:ring-amber-400/30 dark:text-amber-200',
    hover: 'hover:bg-amber-500/15 dark:hover:bg-amber-400/15',
    active: 'bg-amber-500/20 dark:bg-amber-400/20',
    ink: 'text-amber-600 dark:text-amber-300',
  },
  isolate: {
    verb: 'Showing only',
    label: 'Show only',
    technical: 'Isolate',
    detail: 'Rows that don’t match are hidden from the canvas.',
    icon: LucideIcons.Filter,
    mark: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
    token: 'bg-violet-500/[0.10] ring-violet-500/35 text-violet-700 dark:bg-violet-400/[0.12] dark:ring-violet-400/30 dark:text-violet-200',
    hover: 'hover:bg-violet-500/15 dark:hover:bg-violet-400/15',
    active: 'bg-violet-500/20 dark:bg-violet-400/20',
    ink: 'text-violet-600 dark:text-violet-300',
  },
  hide: {
    verb: 'Hiding',
    label: 'Hide',
    technical: 'Hide',
    detail: 'Matching rows are hidden; everything else is shown.',
    icon: LucideIcons.EyeOff,
    mark: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
    token: 'bg-rose-500/[0.09] ring-rose-500/35 text-rose-700 dark:bg-rose-400/[0.12] dark:ring-rose-400/30 dark:text-rose-200',
    hover: 'hover:bg-rose-500/15 dark:hover:bg-rose-400/15',
    active: 'bg-rose-500/20 dark:bg-rose-400/20',
    ink: 'text-rose-600 dark:text-rose-300',
  },
}

/** Each mode in its own colour, so the switch is also the key to the rows. */
const MODE_OPTIONS = (['highlight', 'isolate', 'hide'] as const).map((value) => {
  const { label, icon: Glyph, ink } = MODE[value]
  const icon = ({ className }: { className?: string }) => <Glyph className={cn(className, ink)} strokeWidth={2.2} />
  return { value, label, icon }
})

/**
 * Room, in px, the token and the input share before each part of the token
 * is shown. Below each, that part goes — to the card — so the input always
 * keeps a word's width to type into.
 */
const TOKEN_ROOM = {
  /** "Highlighting 42 matches", in place of the placeholder. */
  words: 400,
  /** ‹ › in the token that stands in for the words. */
  advancedStep: 250,
  /** ‹ › beside words typed in the box, which need more of the room. */
  typedStep: 270,
  /** The token's own ×. */
  clear: 170,
} as const

const CARD_WIDTH = 304

/** The card lands on the mode the canvas is in, not the first one offered. */
const FOCUS_FIRST = ['[role="radio"][aria-checked="true"]', 'button'] as const

const ring = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/45'

export function ActiveSearchToken({ variant, room, stale = false, onOpenCard }: {
  variant: 'advanced' | 'typed'
  /** The width the token shares with the input; null before it is measured. */
  room: number | null
  /** What is in the box has moved on since its search ran. */
  stale?: boolean
  /** The card is opening — the box puts its own list away. */
  onOpenCard?: () => void
}) {
  // Destructured: the session carries the input ref (see HeaderSearch).
  const {
    viewId, advanced, resolveLayer, layers, revealHit, refine, clearQuery, panelOpen,
  } = useViewSearchSession()
  const mode = useCanvasFilterMode()
  const focused = useFocusedMatchIndex()
  const steps = useStepCount()
  const matchUrns = useMatchUrnSet()
  const technical = usePersonaMode() === 'technical'
  // Destructured for the same reason: it carries refs.
  const {
    open: cardOpen, toggle, close, anchor, triggerRef, listRef,
  } = useAnchoredPopover(FOCUS_FIRST)
  const meta = MODE[mode]
  const Icon = meta.icon

  const view = advanced.view
  const result = view.kind === 'results' ? view.result : null
  const unit: Unit = result?.paths ? 'path' : result?.edges ? 'connection' : 'match'
  // The box's own count — the one its list shows — and, with no answer in
  // hand (a search published straight to the canvas), what is lit.
  const count = result ? (result.totalCount ?? result.candidateCount) : matchUrns.size
  const plus = result
    ? (result.truncated === true && result.totalCount == null) || result.status === 'running'
    : false
  const counted = `${count.toLocaleString()}${plus ? '+' : ''}`
  const noun = UNIT[unit][count === 1 && !plus ? 0 : 1]
  const sentence = `${meta.verb} ${counted} ${noun}`

  // The layers its matches are in, in board order, as far as the page of
  // hits in hand says.
  const inLayers = useMemo(() => {
    const ids = new Set<string>()
    for (const hit of result?.hits ?? []) {
      const id = resolveLayer(hit)
      if (id) ids.add(id)
    }
    return layers.filter((l) => ids.has(l.id))
  }, [result, resolveLayer, layers])

  // What fits. Unmeasured (a first frame, jsdom) shows everything.
  const fits = (px: number) => room === null || room >= px
  const words = variant === 'advanced' && fits(TOKEN_ROOM.words)
  // Stepping walks matches; a route or a connection is shown from the panel,
  // and while the panel is open its own stepper is right there.
  const canStep = unit === 'match' && steps > 0
  const stepper = canStep && !panelOpen
    && fits(variant === 'advanced' ? TOKEN_ROOM.advancedStep : TOKEN_ROOM.typedStep)
  // A typed search is cleared by the box's own ×.
  const clear = variant === 'advanced' && fits(TOKEN_ROOM.clear)

  const step = (direction: 'prev' | 'next') => {
    useSearchStore.getState().stepFocus(direction)
    // With the panel closed nothing else shows the match the step is on, so
    // the canvas does.
    const { orderedMatchUrns, focusedMatchIndex } = useSearchStore.getState()
    const urn = focusedMatchIndex === null ? undefined : orderedMatchUrns[focusedMatchIndex]
    if (!urn) return
    const hit = result?.hits?.find((h) => h.node.urn === urn)
    // A reveal that threw has already logged.
    void revealHit(urn, hit?.ancestorPath ?? []).catch(() => {})
  }
  const position = focused === null ? null : `${(focused + 1).toLocaleString()}/${steps.toLocaleString()}`

  const toggleCard = () => {
    if (!cardOpen) onOpenCard?.()
    toggle()
  }

  return (
    <div
      role="group"
      aria-label="Search on the canvas"
      data-search-token={variant}
      data-search-mode={mode}
      className={cn(
        'shrink-0 inline-flex items-center h-7 rounded-lg ring-1 ring-inset transition-opacity',
        meta.token,
        stale && 'opacity-55',
      )}
    >
      {/* Said once, when the search starts shaping the canvas and as it changes. */}
      <span role="status" className="sr-only">{sentence}</span>
      <HoverTip
        className="flex h-full"
        label="Change how the matches show, or edit the search"
        detail={words ? 'Highlight, show only or hide them · the layers they’re in' : sentence}
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleCard}
          aria-haspopup="dialog"
          aria-expanded={cardOpen}
          aria-label={sentence}
          className={cn(
            'inline-flex items-center gap-1.5 h-full pl-2 pr-1.5 rounded-lg text-[12px] leading-none whitespace-nowrap transition-colors',
            meta.hover, ring,
            cardOpen && meta.active,
          )}
        >
          <Icon className="w-[13px] h-[13px] shrink-0" strokeWidth={2.4} aria-hidden />
          {words ? (
            <span className="font-medium">
              {meta.verb} <span className="font-semibold tabular-nums">{counted}</span> {noun}
            </span>
          ) : (
            <span className="font-semibold tabular-nums">{counted}</span>
          )}
          <LucideIcons.ChevronDown
            className={cn('w-3 h-3 shrink-0 opacity-60 transition-transform', cardOpen && 'rotate-180')}
            strokeWidth={2.4}
            aria-hidden
          />
        </button>
      </HoverTip>

      {stepper && (
        <>
          <span aria-hidden className="w-px h-3.5 bg-current opacity-20" />
          <span className="flex items-center px-0.5" role="group" aria-label="Step through the matches">
            <HoverTip className="flex" label="Previous match" detail="Shown on the canvas">
              <button type="button" onClick={() => step('prev')} aria-label="Previous match"
                className={cn('grid place-items-center w-5 h-5 rounded-md transition-colors', meta.hover, ring)}>
                <LucideIcons.ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />
              </button>
            </HoverTip>
            {position && (
              <span className="px-0.5 text-[11px] font-medium tabular-nums whitespace-nowrap" aria-live="polite">
                {position}
              </span>
            )}
            <HoverTip className="flex" label="Next match" detail="Shown on the canvas">
              <button type="button" onClick={() => step('next')} aria-label="Next match"
                className={cn('grid place-items-center w-5 h-5 rounded-md transition-colors', meta.hover, ring)}>
                <LucideIcons.ChevronRight className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />
              </button>
            </HoverTip>
          </span>
        </>
      )}

      {clear && (
        <>
          {!stepper && <span aria-hidden className="w-px h-3.5 bg-current opacity-20" />}
          <HoverTip
            className="flex"
            label="Clear the search"
            detail="Takes every highlight off the canvas"
            shortcut={panelOpen ? undefined : 'Esc'}
          >
            <button type="button" onClick={() => clearQuery()} aria-label="Clear search"
              className={cn('grid place-items-center w-5 h-5 mr-1 rounded-md transition-colors', meta.hover, ring)}>
              <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />
            </button>
          </HoverTip>
        </>
      )}

      {typeof document !== 'undefined' && createPortal(
        <>
          {cardOpen && anchor && (
            <motion.div
              ref={listRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
              role="dialog"
              aria-label="Search on the canvas"
              data-view-search-popover="true"
              {...keyboardScopeProps('active-search')}
              style={{
                position: 'fixed',
                top: anchor.top,
                left: Math.max(8, Math.min(anchor.left, window.innerWidth - CARD_WIDTH - 8)),
                width: CARD_WIDTH,
                zIndex: 1000,
                maxHeight: `calc(100vh - ${anchor.top}px - 16px)`,
              }}
              className="overflow-y-auto custom-scrollbar rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40"
            >
              <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
                <span className={cn('flex-none grid place-items-center w-7 h-7 rounded-full', meta.mark)} aria-hidden>
                  <Icon className="w-3.5 h-3.5" strokeWidth={2.4} />
                </span>
                <div className="min-w-0 flex-1 pt-px">
                  <div className="flex items-center gap-1.5 min-w-0 font-display text-[12.5px] leading-tight text-ink">
                    <span className="truncate">
                      {meta.verb} <strong className="font-semibold tabular-nums">{counted}</strong> {noun}
                    </span>
                    {technical && (
                      <span className={cn('flex-none px-1.5 py-px rounded-md text-[9.5px] font-semibold uppercase tracking-wide', meta.mark)}>
                        {meta.technical}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{meta.detail}</p>
                </div>
              </div>

              <Section label="On the canvas">
                <Segmented
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={(next) => useSearchStore.getState().setCanvasFilterMode(next, viewId)}
                  label="How the matches show on the canvas"
                />
              </Section>

              {inLayers.length > 0 && (
                <Section label={`In ${inLayers.length} ${inLayers.length === 1 ? 'layer' : 'layers'}`}>
                  <ul className="flex flex-wrap gap-1">
                    {inLayers.map((layer) => (
                      <li key={layer.id}
                        className="inline-flex items-center gap-1.5 max-w-full h-6 px-2 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[11px] text-ink-secondary">
                        <span aria-hidden className="w-2 h-2 shrink-0 rounded-full bg-ink-muted/50"
                          style={layer.color ? { backgroundColor: layer.color } : undefined} />
                        <span className="truncate">{layer.name}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* The step the token had no room for. */}
              {canStep && !panelOpen && !stepper && (
                <Section label="Step through the matches">
                  <div className="flex items-center gap-1">
                    <HoverTip className="flex" label="Previous match" detail="Shown on the canvas">
                      <button type="button" onClick={() => step('prev')} aria-label="Previous match"
                        className={cn('grid place-items-center w-7 h-7 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors', ring)}>
                        <LucideIcons.ChevronLeft className="w-4 h-4" strokeWidth={2.2} aria-hidden />
                      </button>
                    </HoverTip>
                    <span className="min-w-[64px] text-center text-[11.5px] font-medium tabular-nums text-ink" aria-live="polite">
                      {focused === null ? `– of ${steps.toLocaleString()}` : `${(focused + 1).toLocaleString()} of ${steps.toLocaleString()}`}
                    </span>
                    <HoverTip className="flex" label="Next match" detail="Shown on the canvas">
                      <button type="button" onClick={() => step('next')} aria-label="Next match"
                        className={cn('grid place-items-center w-7 h-7 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors', ring)}>
                        <LucideIcons.ChevronRight className="w-4 h-4" strokeWidth={2.2} aria-hidden />
                      </button>
                    </HoverTip>
                  </div>
                </Section>
              )}

              <div className="flex items-center justify-between gap-2 mt-1 px-2 py-2 border-t border-black/[0.06] dark:border-white/[0.06]">
                <HoverTip className="flex" label="Opens the search in Advanced Search, with its results">
                  <button
                    type="button"
                    onClick={() => { close(); refine() }}
                    className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.07] transition-colors', ring)}
                  >
                    <LucideIcons.PencilLine className="w-3.5 h-3.5" strokeWidth={2.2} aria-hidden />
                    Edit search…
                  </button>
                </HoverTip>
                <HoverTip
                  className="flex"
                  label="Takes every highlight off the canvas"
                  shortcut={panelOpen ? undefined : 'Esc'}
                >
                  <button
                    type="button"
                    onClick={() => { close(); clearQuery() }}
                    className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors', ring)}
                  >
                    <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} aria-hidden />
                    Clear
                  </button>
                </HoverTip>
              </div>
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 pb-2.5">
      <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">{label}</div>
      {children}
    </div>
  )
}
