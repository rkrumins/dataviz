import { useEffect, useRef, useState } from 'react'
import { motion, LayoutGroup } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Clock,
  Share2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import { DEFAULT_TRACE_DEPTH } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from '@/types/hierarchy'
import { useCountUp } from './useCountUp'
import { TraceRecentPopover } from './TraceRecentPopover'
import { TraceModeIndicator, deriveTraceMode } from './TraceModeIndicator'
import { TraceSharePopover, type TraceShareSummary } from './TraceSharePopover'
import { TraceSeedsPopover, type TraceSeed } from './TraceSeedsPopover'

export interface TraceDockTitleBarProps {
  trace: UseUnifiedTraceResult
  displayMap: Map<string, HierarchyNode>
  expanded: boolean
  onToggleExpanded: () => void
  onExit: () => void
  /** Browser-style trace history — rendered only when wired. */
  onHistoryBack?: () => void
  onHistoryForward?: () => void
  canHistoryBack?: boolean
  canHistoryForward?: boolean
  /** Driven by the NATIVE trace engine: direction is a VIEW toggle on a flow
   *  already walked to exhaustion, never a new request. */
  nativeMode?: boolean
  /** Everything the Share control needs, or absent for a host that cannot
   *  build a link (the legacy dock). No summary, no button. */
  share?: TraceShareSummary
  /** The traced entity's name, resolved by the host. The canvas can only
   *  name what it has LOADED, and a trace opened from a shared link is
   *  routinely on something the recipient has never expanded — which used to
   *  put a raw urn in the dock's focus chip. */
  focusLabel?: string
  /** Every seed of a COMBINED trace (a multi-selection), in trace order.
   *  With two or more and `onRemoveSeed`, the focus chip becomes
   *  "Tracing N entities", which lists them and drops one on request. */
  seeds?: readonly TraceSeed[]
  onRemoveSeed?: (urn: string) => void
}

type Direction = 'up' | 'both' | 'down'

function deriveDirection(showUpstream: boolean, showDownstream: boolean): Direction {
  if (showUpstream && !showDownstream) return 'up'
  if (!showUpstream && showDownstream) return 'down'
  return 'both'
}

/**
 * The always-visible 56px title row. Mirrors the ContextViewHeader vocabulary:
 *   - 9x9 gradient identity icon ("section badge")
 *   - Gradient-tinted focus chip with type + level micro-pills
 *   - Counts as gradient pills with semantic accent
 *   - Vertical hairline dividers between major groups (gradient)
 *   - rounded-xl buttons with gradient hover + glow shadow
 *
 * A11y model:
 *  - `role="toolbar"` with roving tabindex
 *  - Direction segmented control is `role="radiogroup"`
 *  - Pulsing badge gated by `prefers-reduced-motion`
 *  - Live region announces trace start
 */
export function TraceDockTitleBar({
  trace,
  displayMap,
  expanded,
  onToggleExpanded,
  onExit,
  onHistoryBack,
  onHistoryForward,
  canHistoryBack = false,
  canHistoryForward = false,
  nativeMode = false,
  share,
  focusLabel,
  seeds,
  onRemoveSeed,
}: TraceDockTitleBarProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const recentTriggerRef = useRef<HTMLButtonElement>(null)
  const shareTriggerRef = useRef<HTMLButtonElement>(null)
  const seedsTriggerRef = useRef<HTMLButtonElement>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [seedsOpen, setSeedsOpen] = useState(false)
  const [focusedIdx, setFocusedIdx] = useState(0)

  // A combined trace narrowed to one seed is an ordinary trace again: the
  // list closes with the chip, rather than re-opening on the next one.
  const combined = !!onRemoveSeed && (seeds?.length ?? 0) > 1
  if (seedsOpen && !combined) setSeedsOpen(false)

  const focusNode = trace.focusId ? displayMap.get(trace.focusId) : undefined
  const focusName = focusLabel || focusNode?.name || trace.focusId || 'Unknown'
  const focusType = focusNode?.typeId
  const liveMsg = `Tracing ${focusName}${focusType ? `, ${focusType}` : ''}. ${trace.upstreamCount} upstream, ${trace.downstreamCount} downstream nodes.`

  const upDisplay = useCountUp(trace.upstreamCount)
  const downDisplay = useCountUp(trace.downstreamCount)
  const direction = deriveDirection(trace.showUpstream, trace.showDownstream)
  const recentCount = trace.traceHistory.length

  // Re-fetch the trace with the chosen direction. Matches the Entity
  // Drawer trace actions (onTraceUp / onTraceDown / onTraceBoth) — the
  // arrow isn't just a visibility toggle on already-fetched data; it
  // triggers a fresh /trace/v2 call that asks the server for the new
  // direction.
  //
  // Direction is encoded server-side via depth values: depth=0 disables
  // that side. We preserve the existing depth on kept sides and floor
  // at DEFAULT_TRACE_DEPTH when re-enabling a previously-disabled side,
  // so toggling 'up' → 'both' doesn't return only one downstream hop.
  //
  // NONE OF THAT ON THE NATIVE ENGINE. The flow is already walked, so the
  // arrow is exactly what it looks like — a visibility toggle. Letting the
  // depth encoding through would have an arrow that says nothing about depth
  // silently rewrite the reader's view scope (to 0 on the hidden side, and
  // back up to DEFAULT_TRACE_DEPTH on return), and the retrace would be a
  // request for a flow the session already holds.
  const setDirection = (dir: Direction) => {
    if (nativeMode) {
      trace.setShowUpstream(dir !== 'down')
      trace.setShowDownstream(dir !== 'up')
      return
    }
    const curUp = trace.config.upstreamDepth
    const curDown = trace.config.downstreamDepth
    if (dir === 'up') {
      trace.setConfig({ upstreamDepth: Math.max(curUp, DEFAULT_TRACE_DEPTH), downstreamDepth: 0 })
      trace.setShowUpstream(true)
      trace.setShowDownstream(false)
    } else if (dir === 'down') {
      trace.setConfig({ upstreamDepth: 0, downstreamDepth: Math.max(curDown, DEFAULT_TRACE_DEPTH) })
      trace.setShowUpstream(false)
      trace.setShowDownstream(true)
    } else {
      trace.setConfig({
        upstreamDepth: Math.max(curUp, DEFAULT_TRACE_DEPTH),
        downstreamDepth: Math.max(curDown, DEFAULT_TRACE_DEPTH),
      })
      trace.setShowUpstream(true)
      trace.setShowDownstream(true)
    }
    // Fire-and-forget — error handling is centralised in startTrace.
    void trace.retrace()
  }

  const controlsRef = useRef<HTMLElement[]>([])
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    controlsRef.current = Array.from(root.querySelectorAll<HTMLElement>('[data-trace-control]'))
    controlsRef.current.forEach((el, i) => { el.tabIndex = i === focusedIdx ? 0 : -1 })
  })

  // Narrowing to one seed takes the "Tracing N entities" chip away, and with
  // it whatever held focus (the chip, or the list's X): keep the keyboard in
  // the toolbar rather than dropping it on the page.
  const wasCombined = useRef(combined)
  useEffect(() => {
    const narrowed = wasCombined.current && !combined
    wasCombined.current = combined
    if (!narrowed) return
    const active = document.activeElement
    if (!active || active === document.body) containerRef.current?.focus()
  }, [combined])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = controlsRef.current
    if (items.length === 0) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const next = (focusedIdx + dir + items.length) % items.length
      setFocusedIdx(next); items[next].focus()
    } else if (e.key === 'Home') {
      e.preventDefault(); setFocusedIdx(0); items[0].focus()
    } else if (e.key === 'End') {
      e.preventDefault(); setFocusedIdx(items.length - 1); items[items.length - 1].focus()
    }
  }

  const onContainerFocus = (e: React.FocusEvent) => {
    if (e.target === containerRef.current && controlsRef.current[focusedIdx]) {
      controlsRef.current[focusedIdx].focus()
    }
  }

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={`Trace controls for ${focusName}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onContainerFocus}
      data-canvas-interactive
      className={cn(
        'relative flex items-center gap-3.5 px-5 h-16 shrink-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 focus-visible:ring-inset',
      )}
    >
      <span className="sr-only" aria-live="polite" aria-atomic="true">{liveMsg}</span>

      {/* Section identity — mode-coloured indicator that names the active trace
          (Root Cause / Impact / Full Lineage), mirroring the EntityDrawer's
          trace action vocabulary so the canvas state matches the entry point. */}
      <TraceModeIndicator
        mode={deriveTraceMode(trace.showUpstream, trace.showDownstream)}
        isLoading={trace.isLoading}
      />

      {/* Vertical hairline divider — matches ContextViewHeader idiom */}
      <span
        className="w-px h-8 bg-gradient-to-b from-transparent via-white/15 to-transparent shrink-0"
        aria-hidden
      />

      {/* Focus chip — neutral glass with bright name + accent micro-pills.
          A combined trace has no one name: the chip names how many, and
          opens the list of them. */}
      {combined ? (
        // Shrinks with the dock like the single chip does — the label gives
        // way first, the stack of initials never.
        <div className="relative min-w-[4.5rem] shrink">
          <button
            ref={seedsTriggerRef}
            type="button"
            data-trace-control
            aria-haspopup="dialog"
            aria-expanded={seedsOpen}
            aria-label={`Tracing ${seeds!.length} entities`}
            title="The entities this trace follows"
            onClick={() => setSeedsOpen(v => !v)}
            className={cn(
              'flex items-center gap-2 pl-1.5 pr-2.5 h-9 rounded-xl min-w-0 max-w-full overflow-hidden',
              'transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              seedsOpen
                ? 'bg-accent-lineage/15 border border-accent-lineage/50 shadow-lg shadow-accent-lineage/20'
                : 'bg-white/[0.06] border border-white/[0.12] hover:bg-white/[0.12] hover:border-accent-lineage/40',
            )}
          >
            {/* The first few seeds as a stack of initials — "several things"
                read at a glance, before the number is. */}
            <span className="flex -space-x-1.5 shrink-0" aria-hidden>
              {/* Past three, the last bubble counts the rest ("+2"), so the
                  stack still says how many when a narrow dock has squeezed
                  the label out. */}
              {seeds!.slice(0, seeds!.length > 3 ? 2 : 3).map(seed => (
                <span
                  key={seed.urn}
                  className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded-full',
                    'bg-gradient-to-br from-accent-lineage to-purple-500 text-white',
                    'text-[10px] font-bold uppercase ring-2 ring-canvas-elevated',
                  )}
                >
                  {seed.label.charAt(0)}
                </span>
              ))}
              {seeds!.length > 3 && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-6 h-6 px-1 rounded-full',
                    'bg-accent-lineage/25 text-accent-lineage border border-accent-lineage/40',
                    'text-[10px] font-bold tabular-nums ring-2 ring-canvas-elevated',
                  )}
                >
                  +{seeds!.length - 2}
                </span>
              )}
            </span>
            {/* "Tracing" gives way before the count does: in a clipped,
                wrapping row-reverse line it is the item that drops to the
                hidden second line, so a narrow dock reads "3 entities",
                never "Tra…". The button's aria-label keeps the reading order. */}
            <span
              aria-hidden
              className="flex flex-row-reverse flex-wrap justify-end h-5 overflow-hidden min-w-0 text-sm font-display font-semibold text-ink tracking-tight"
            >
              <span className="min-w-0 truncate">
                <span className="tabular-nums">{seeds!.length}</span> entities
              </span>
              <span className="whitespace-nowrap pr-[0.3em]">Tracing</span>
            </span>
            <ChevronDown
              className={cn('w-3.5 h-3.5 shrink-0 text-ink-muted transition-transform duration-200', seedsOpen && 'rotate-180')}
              strokeWidth={2.4}
              aria-hidden
            />
          </button>
          {seedsOpen && (
            <TraceSeedsPopover
              seeds={seeds!}
              onRemove={onRemoveSeed!}
              onClose={() => { setSeedsOpen(false); seedsTriggerRef.current?.focus() }}
              triggerRef={seedsTriggerRef}
            />
          )}
        </div>
      ) : (
      <div
        className={cn(
          'flex items-center gap-2 px-3 h-9 rounded-xl min-w-0 shrink',
          'bg-white/[0.06] border border-white/[0.12]',
        )}
        title={focusName}
      >
        <span className="text-sm font-display font-semibold text-ink truncate max-w-[180px] tracking-tight">
          {focusName}
        </span>
        {focusType && (
          <span className="hidden xl:inline-flex shrink-0 px-1.5 py-0.5 rounded-md bg-accent-lineage/20 text-accent-lineage text-[10px] font-bold uppercase tracking-wider border border-accent-lineage/30">
            {focusType}
          </span>
        )}
        {typeof trace.result?.effectiveLevel === 'number' && (
          <span className="hidden 2xl:inline-flex shrink-0 px-1.5 py-0.5 rounded-md bg-white/[0.10] text-ink text-[10px] font-bold tabular-nums">
            L{trace.result.effectiveLevel}
          </span>
        )}
      </div>
      )}

      {/* Counts — neutral glass pills with accent icon + bright value */}
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 h-9 rounded-xl',
            'bg-white/[0.06] border border-lineage-in/40',
          )}
          aria-label={`${trace.upstreamCount} upstream nodes`}
        >
          <ArrowUp className="w-4 h-4 text-lineage-in" strokeWidth={2.4} aria-hidden />
          <span className="text-sm font-bold tabular-nums text-ink">{upDisplay.toLocaleString()}</span>
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 h-9 rounded-xl',
            'bg-white/[0.06] border border-lineage-out/40',
          )}
          aria-label={`${trace.downstreamCount} downstream nodes`}
        >
          <ArrowDown className="w-4 h-4 text-lineage-out" strokeWidth={2.4} aria-hidden />
          <span className="text-sm font-bold tabular-nums text-ink">{downDisplay.toLocaleString()}</span>
        </span>
      </div>

      <span
        className="w-px h-8 bg-gradient-to-b from-transparent via-white/15 to-transparent shrink-0"
        aria-hidden
      />

      {/* Direction radiogroup with sliding underline */}
      <LayoutGroup id="trace-dock-direction">
        <div
          role="radiogroup"
          aria-label="Trace direction visibility"
          className={cn(
            'inline-flex items-center rounded-xl p-1 gap-0.5 shrink-0 h-9',
            'bg-white/[0.06] border border-white/[0.12]',
          )}
        >
          <DirRadio
            checked={direction === 'up'}
            onSelect={() => setDirection('up')}
            icon={<ArrowUp className="w-4 h-4" strokeWidth={2.4} />}
            label="Upstream only"
          />
          <DirRadio
            checked={direction === 'both'}
            onSelect={() => setDirection('both')}
            icon={<ArrowUpDown className="w-4 h-4" strokeWidth={2.4} />}
            label="Both directions"
          />
          <DirRadio
            checked={direction === 'down'}
            onSelect={() => setDirection('down')}
            icon={<ArrowDown className="w-4 h-4" strokeWidth={2.4} />}
            label="Downstream only"
          />
        </div>
      </LayoutGroup>

      <div className="flex-1 min-w-2" />

      {/* Trace history ←/→ — browser semantics over this view's traces
          (renders only when the host wires the history). */}
      {(onHistoryBack || onHistoryForward) && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-trace-control
            onClick={onHistoryBack}
            disabled={!canHistoryBack}
            title="Previous trace in this view"
            aria-label="Previous trace"
            className={cn(
              'inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors',
              canHistoryBack
                ? 'text-ink-muted hover:text-ink bg-white/[0.06] border-white/[0.12] hover:bg-white/[0.12]'
                : 'text-ink-muted/30 border-white/[0.06] cursor-default',
            )}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            data-trace-control
            onClick={onHistoryForward}
            disabled={!canHistoryForward}
            title="Next trace in this view"
            aria-label="Next trace"
            className={cn(
              'inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors',
              canHistoryForward
                ? 'text-ink-muted hover:text-ink bg-white/[0.06] border-white/[0.12] hover:bg-white/[0.12]'
                : 'text-ink-muted/30 border-white/[0.06] cursor-default',
            )}
          >
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* SHARE — a trace is a finding, and findings get handed on. Sits with
          the other "what do I do with this trace" controls rather than in
          the header, where it would only ever be live during a trace. */}
      {share && (
        <div className="relative shrink-0">
          <button
            ref={shareTriggerRef}
            type="button"
            data-trace-control
            aria-haspopup="dialog"
            aria-expanded={shareOpen}
            aria-label="Share this trace"
            title="Copy a link that reopens this trace"
            onClick={() => setShareOpen(v => !v)}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 h-9 rounded-xl text-sm font-semibold',
              'transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              shareOpen
                ? 'bg-accent-lineage text-white border border-accent-lineage shadow-lg shadow-accent-lineage/30'
                : 'bg-white/[0.08] border border-white/[0.15] text-ink hover:bg-white/[0.14] hover:border-white/[0.25]',
            )}
          >
            <Share2 className="w-4 h-4" strokeWidth={2.4} />
            <span className="hidden md:inline tracking-tight">Share</span>
          </button>
          {shareOpen && (
            <TraceSharePopover
              {...share}
              onClose={() => { setShareOpen(false); shareTriggerRef.current?.focus() }}
              triggerRef={shareTriggerRef}
            />
          )}
        </div>
      )}

      {/* Recent popover trigger */}
      {recentCount > 0 && (
        <div className="relative shrink-0">
          <button
            ref={recentTriggerRef}
            type="button"
            data-trace-control
            aria-haspopup="menu"
            aria-expanded={recentOpen}
            aria-label={`Recent trace history, ${recentCount} ${recentCount === 1 ? 'entry' : 'entries'}`}
            onClick={() => setRecentOpen(v => !v)}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 h-9 rounded-xl text-sm font-semibold',
              'transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              recentOpen
                ? 'bg-accent-lineage text-white border border-accent-lineage shadow-lg shadow-accent-lineage/30'
                : 'bg-white/[0.08] border border-white/[0.15] text-ink hover:bg-white/[0.14] hover:border-white/[0.25]',
            )}
          >
            <Clock className="w-4 h-4" strokeWidth={2.4} />
            <span className="hidden md:inline tracking-tight">Recent</span>
            <span
              className={cn(
                'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full',
                'text-[10px] font-bold tabular-nums leading-none',
                recentOpen
                  ? 'bg-white/25 text-white'
                  : 'bg-white/[0.15] text-ink',
              )}
            >
              {recentCount}
            </span>
          </button>
          {recentOpen && (
            <TraceRecentPopover
              history={trace.traceHistory}
              displayMap={displayMap}
              activeFocusId={trace.focusId}
              onJump={trace.jumpToHistoryEntry}
              onClear={trace.clearTraceHistory}
              onClose={() => { setRecentOpen(false); recentTriggerRef.current?.focus() }}
              triggerRef={recentTriggerRef}
            />
          )}
        </div>
      )}

      {/* Expand / Compact toggle */}
      <button
        type="button"
        data-trace-control
        aria-expanded={expanded}
        aria-controls="trace-bottom-dock-body"
        aria-keyshortcuts="Control+I Meta+I"
        onClick={onToggleExpanded}
        className={cn(
          'inline-flex items-center gap-2 px-3.5 h-9 rounded-xl text-sm font-semibold shrink-0',
          'transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          expanded
            ? 'bg-accent-lineage text-white border border-accent-lineage shadow-lg shadow-accent-lineage/30'
            : 'bg-white/[0.08] border border-white/[0.15] text-ink hover:bg-white/[0.14] hover:border-white/[0.25]',
        )}
      >
        <span className="hidden md:inline tracking-tight">{expanded ? 'Compact' : 'Expand'}</span>
        {expanded
          ? <ChevronDown className="w-4 h-4" strokeWidth={2.4} />
          : <ChevronUp className="w-4 h-4" strokeWidth={2.4} />}
      </button>

      {/* Exit */}
      <button
        type="button"
        data-trace-control
        title="Exit trace (ESC)"
        aria-label="Exit trace"
        onClick={onExit}
        className={cn(
          'inline-flex items-center justify-center w-9 h-9 rounded-xl shrink-0',
          'bg-white/[0.08] border border-white/[0.15] text-ink',
          'hover:bg-rose-500 hover:text-white hover:border-rose-500 hover:shadow-lg hover:shadow-rose-500/30',
          'transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40',
        )}
      >
        <X className="w-4 h-4" strokeWidth={2.4} />
      </button>
    </div>
  )
}

interface DirRadioProps {
  checked: boolean
  onSelect: () => void
  icon: React.ReactNode
  label: string
}

function DirRadio({ checked, onSelect, icon, label }: DirRadioProps) {
  return (
    <button
      type="button"
      data-trace-control
      role="radio"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        'relative inline-flex items-center justify-center w-10 h-full rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        checked
          ? 'text-white'
          : 'text-ink-muted hover:text-ink',
      )}
    >
      {checked && (
        <motion.span
          layoutId="trace-dock-direction-active"
          transition={{ type: 'spring', stiffness: 500, damping: 38 }}
          className="absolute inset-0 rounded-lg bg-accent-lineage shadow-sm shadow-accent-lineage/40"
        />
      )}
      <span className="relative">{icon}</span>
    </button>
  )
}
