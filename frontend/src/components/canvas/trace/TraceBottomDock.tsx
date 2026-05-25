import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import type { UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from '@/types/hierarchy'
import { TraceDockTitleBar } from './TraceDockTitleBar'
import { TraceDockTabs, type TraceDockTab } from './TraceDockTabs'
import { TraceDockOverview } from './TraceDockOverview'
import { TraceDockDrilldownList } from './TraceDockDrilldownList'
import { TraceDockBreadcrumb } from './TraceDockBreadcrumb'
import { TraceDockSettings } from './TraceDockSettings'
import { shouldShowTruncationNotice } from './TraceDockNoticeStrip'
import type { GranularityOption } from './TraceDockControls'
import { useTraceEscStack } from './useTraceEscStack'
import { useCanvasStore } from '@/store/canvas'

export interface TraceBottomDockProps {
  trace: UseUnifiedTraceResult
  displayMap: Map<string, HierarchyNode>
  availableEdgeTypes: string[]
  granularityOptions: GranularityOption[]
  resolveEdgeColor: (edgeType: string) => string
  expanded: boolean
  onToggleExpanded: () => void
  onExit: () => void
  onJumpToUrn: (urn: string) => void
  // Pin Lineage controls — optional; rendered only when at least one pin
  // exists. Brings ContextView to feature parity with GraphCanvas /
  // HierarchyCanvas's TraceToolbar pin section.
  pinnedTargets?: Array<{ urn: string; label: string }>
  unreachablePinUrns?: Set<string>
  onUnpinTarget?: (urn: string) => void
  pinDisplayMode?: 'hide' | 'dim'
  onSetPinDisplayMode?: (mode: 'hide' | 'dim') => void
  onClearPins?: () => void
  /** Size of pinPath.pathNodeUrns — for the "Showing path: N nodes" status. */
  pathNodeCount?: number
  /** Size of pinPath.pathEdgeIds — for the "M edges" status. */
  pathEdgeCount?: number
  /** Hop distance from focus per URN (orientation-agnostic). Drives chip tooltips. */
  hopFromFocus?: Map<string, number>
}

const COMPACT_HEIGHT = 64
// Breadcrumb row height (px-4 + py-1.5 + ~16px line-height + 1px border).
// Added to compact height when one or more drills are active so the row
// isn't clipped by the dock's overflow-hidden container.
const BREADCRUMB_ROW_HEIGHT = 30
const MIN_EXPANDED_HEIGHT = 240
const DEFAULT_EXPANDED_HEIGHT = 320
const MAX_VH_FRACTION = 0.6

// Module-level so the user's preferred expanded height persists across
// open/close within the session. Resets on page reload (deliberate; no
// localStorage thrash).
let lastExpandedHeight = DEFAULT_EXPANDED_HEIGHT

/**
 * The bottom Trace Dock — a floating shelf at the bottom of canvas-body.
 *
 * Compact mode (56px): just the title bar with focus + counts + direction
 * + Recent + Expand + Exit controls.
 *
 * Expanded mode (~300px default, drag-resize between 220px and 60vh):
 * title bar, then a 36px tab strip (Overview · Drilldowns · Settings),
 * then the active tab body. Tabs cross-fade with a 180ms ease.
 *
 * The dock sits inside canvas-body's relative-positioned container and
 * spans its full width (`left-3 right-3`). canvas-body itself shrinks
 * when the EntityDrawer (a flex sibling of the canvas column) opens, so
 * the dock follows along for free — no manual offset needed. z-index 30
 * keeps it above EdgeLegend; the parent lifts EdgeLegend via the
 * `--trace-dock-height` CSS variable the dock publishes.
 */
export function TraceBottomDock({
  trace,
  displayMap,
  availableEdgeTypes,
  granularityOptions,
  resolveEdgeColor,
  expanded,
  onToggleExpanded,
  onExit,
  onJumpToUrn,
  pinnedTargets,
  unreachablePinUrns,
  onUnpinTarget,
  pinDisplayMode = 'hide',
  onSetPinDisplayMode,
  onClearPins,
  pathNodeCount,
  pathEdgeCount,
  hopFromFocus,
}: TraceBottomDockProps) {
  const [expandedHeight, setExpandedHeight] = useState(lastExpandedHeight)
  const [tab, setTab] = useState<TraceDockTab>('overview')
  const dockRef = useRef<HTMLDivElement>(null)
  const hasAutoJumpedRef = useRef(false)

  useTraceEscStack(expanded, onToggleExpanded, 50)

  // Persist height across the session.
  useEffect(() => () => { lastExpandedHeight = expandedHeight }, [expandedHeight])

  // Auto-jump tab on first expand. Notice takes priority — surface it on
  // Overview so users see why the trace is constrained. Otherwise, jump
  // to Drilldowns when there are active drilldowns. Otherwise stay on
  // Overview. Reset the flag when the dock collapses so the next expand
  // re-evaluates.
  const drilldownCount = trace.drilldowns.size
  // Mirror the notice-strip's own gating logic so the title-bar/tab amber
  // alert dot is only lit when the strip will actually render. Truncation
  // is filtered through `shouldShowTruncationNotice` to suppress false
  // alarms on tiny results.
  const hasNotice = !!(
    shouldShowTruncationNotice(trace.result) ||
    (trace.result?.isInherited && trace.result?.inheritedFromUrn)
  )

  useEffect(() => {
    if (!expanded) {
      hasAutoJumpedRef.current = false
      return
    }
    if (hasAutoJumpedRef.current) return
    if (hasNotice) {
      setTab('overview')
    } else if (drilldownCount > 0) {
      setTab('drilldowns')
    }
    hasAutoJumpedRef.current = true
  }, [expanded, hasNotice, drilldownCount])

  // Re-clamp height when the viewport shrinks so the dock never crops the
  // canvas down to nothing.
  useLayoutEffect(() => {
    const onResize = () => {
      const max = Math.floor(window.innerHeight * MAX_VH_FRACTION)
      setExpandedHeight(h => Math.min(h, max))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drag-to-resize on the top edge. Dock extends UPWARD when grown, so
  // dragging UP increases height (negative deltaY).
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = expandedHeight
    const maxHeight = Math.floor(window.innerHeight * MAX_VH_FRACTION)
    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY
      const next = Math.min(maxHeight, Math.max(MIN_EXPANDED_HEIGHT, startHeight + delta))
      setExpandedHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const hasBreadcrumb = drilldownCount > 0
  const dockHeight = expanded
    ? expandedHeight
    : COMPACT_HEIGHT + (hasBreadcrumb ? BREADCRUMB_ROW_HEIGHT : 0)

  // Publish dock height as a CSS variable on the parent canvas-body so
  // EdgeLegend (and any other bottom-anchored chrome) can lift above it.
  useEffect(() => {
    const parent = dockRef.current?.closest<HTMLElement>('[data-canvas-body]')
    if (!parent) return
    parent.style.setProperty('--trace-dock-height', `${dockHeight + 12}px`)
    return () => {
      parent.style.removeProperty('--trace-dock-height')
    }
  }, [dockHeight])

  const handleReduceDepth = useCallback(() => {
    trace.setConfig({
      upstreamDepth: Math.max(1, Math.floor(trace.config.upstreamDepth / 2)),
      downstreamDepth: Math.max(1, Math.floor(trace.config.downstreamDepth / 2)),
    })
    trace.retrace()
  }, [trace])

  const focusNode = trace.focusId ? displayMap.get(trace.focusId) ?? null : null

  return (
    <motion.div
      ref={dockRef}
      data-canvas-interactive
      id="trace-bottom-dock"
      role="region"
      aria-label="Trace dock"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0, height: dockHeight }}
      exit={{ opacity: 0, y: 24 }}
      transition={MOTION.modalSpring}
      style={{ height: dockHeight }}
      className={cn(
        'absolute left-3 right-3 bottom-3 z-40',
        'rounded-2xl overflow-hidden',
        // Premium frosted shell: gradient base + heavy blur + accent-tinted border
        'bg-gradient-to-b from-canvas-elevated/96 via-canvas-elevated/95 to-canvas-elevated/96',
        'backdrop-blur-2xl',
        'border border-accent-lineage/25',
        'shadow-glass-lg shadow-accent-lineage/10',
        // Top-edge accent hairline — the "trace mode is live" tell
        'before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-accent-lineage/70 before:to-transparent before:pointer-events-none',
        // Soft ambient glow at the top edge — quiet halo that says "alive"
        'after:absolute after:inset-x-16 after:-top-px after:h-[2px] after:bg-accent-lineage/40 after:blur-md after:pointer-events-none',
      )}
    >
      <div className="relative h-full flex flex-col">
        {/* Drag-resize handle — only meaningful in expanded mode. The
            invisible 8px hit area sits over the top edge with a 4px-on-
            hover band and a centered 3-dot grip indicator. */}
        {expanded && (
          <div
            role="separator"
            aria-label="Resize trace dock"
            aria-orientation="horizontal"
            aria-valuenow={expandedHeight}
            aria-valuemin={MIN_EXPANDED_HEIGHT}
            aria-valuemax={Math.floor(window.innerHeight * MAX_VH_FRACTION)}
            onPointerDown={onResizeStart}
            className="absolute top-0 left-0 right-0 h-2 cursor-row-resize group z-20"
          >
            {/* Hover band — soft gradient glow */}
            <div className="absolute inset-x-0 top-0 h-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-gradient-to-r from-transparent via-accent-lineage/20 to-transparent" />
            {/* Grip pill — subtle at rest, lights up on hover */}
            <div
              className={cn(
                'absolute top-[3px] left-1/2 -translate-x-1/2',
                'inline-flex items-center gap-[3px] px-1.5 h-1.5 rounded-full',
                'bg-white/10 group-hover:bg-accent-lineage/50',
                'opacity-50 group-hover:opacity-100 transition-all duration-200',
              )}
            >
              <span className="block w-0.5 h-0.5 rounded-full bg-current" />
              <span className="block w-0.5 h-0.5 rounded-full bg-current" />
              <span className="block w-0.5 h-0.5 rounded-full bg-current" />
            </div>
          </div>
        )}

        {/* Title bar — sticky at top, always visible */}
        <TraceDockTitleBar
          trace={trace}
          displayMap={displayMap}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
          onExit={onExit}
        />

        {/* Pin Lineage — empty-state hint when a trace is active but no
            pins are set. Surfaces the trigger surfaces so users discover
            the feature; dismissible per-trace. */}
        {trace.isTracing && (!pinnedTargets || pinnedTargets.length === 0) && (
          <PinDockEmptyHint />
        )}

        {/* Pin Lineage strip — only when at least one pin exists. Mirrors the
            chip + mode-toggle + clear surfaces in TraceToolbar so ContextView
            users can manage pins without leaving the canvas. */}
        {pinnedTargets && pinnedTargets.length > 0 && (
          <PinDockStrip
            pinnedTargets={pinnedTargets}
            unreachablePinUrns={unreachablePinUrns}
            onUnpinTarget={onUnpinTarget}
            pinDisplayMode={pinDisplayMode}
            onSetPinDisplayMode={onSetPinDisplayMode}
            onClearPins={onClearPins}
            pathNodeCount={pathNodeCount}
            pathEdgeCount={pathEdgeCount}
            hopFromFocus={hopFromFocus}
          />
        )}

        {/* Drill-back breadcrumb — visible whenever one or more drills are
            active, in both compact and expanded modes. Self-hides when
            drilldowns is empty so the dock stays slim during a fresh
            trace. */}
        <TraceDockBreadcrumb
          focusId={trace.focusId}
          focusName={focusNode?.name ?? trace.focusId ?? 'Focus'}
          drilldowns={trace.drilldowns}
          displayMap={displayMap}
          onCollapse={trace.collapseDrilldown}
        />

        {/* Tabs + body — only in expanded mode */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="dock-body"
              id="trace-bottom-dock-body"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex-1 min-h-0 flex flex-col"
            >
              <TraceDockTabs
                active={tab}
                onChange={setTab}
                drilldownCount={drilldownCount}
                hasNotice={hasNotice}
              />

              <AnimatePresence mode="wait" initial={false}>
                {tab === 'overview' && (
                  <TraceDockOverview
                    key="overview"
                    trace={trace}
                    displayMap={displayMap}
                    focusNode={focusNode}
                    resolveEdgeColor={resolveEdgeColor}
                    onReduceDepth={handleReduceDepth}
                    onJumpToUrn={onJumpToUrn}
                  />
                )}
                {tab === 'drilldowns' && (
                  <motion.div
                    key="drilldowns"
                    id="trace-dock-panel-drilldowns"
                    role="tabpanel"
                    aria-labelledby="trace-dock-tab-drilldowns"
                    initial={{ opacity: 0, scale: 0.99 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.99 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="flex-1 min-h-0 flex flex-col"
                  >
                    <TraceDockDrilldownList
                      drilldowns={trace.drilldowns}
                      displayMap={displayMap}
                      onCollapse={trace.collapseDrilldown}
                    />
                  </motion.div>
                )}
                {tab === 'settings' && (
                  <TraceDockSettings
                    key="settings"
                    trace={trace}
                    granularityOptions={granularityOptions}
                    availableEdgeTypes={availableEdgeTypes}
                    resolveEdgeColor={resolveEdgeColor}
                  />
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

interface PinDockStripProps {
  pinnedTargets: Array<{ urn: string; label: string }>
  unreachablePinUrns?: Set<string>
  onUnpinTarget?: (urn: string) => void
  pinDisplayMode: 'hide' | 'dim'
  onSetPinDisplayMode?: (mode: 'hide' | 'dim') => void
  onClearPins?: () => void
  pathNodeCount?: number
  pathEdgeCount?: number
  hopFromFocus?: Map<string, number>
}

function PinDockStrip({
  pinnedTargets,
  unreachablePinUrns,
  onUnpinTarget,
  pinDisplayMode,
  onSetPinDisplayMode,
  onClearPins,
  pathNodeCount,
  pathEdgeCount,
  hopFromFocus,
}: PinDockStripProps) {
  const unreachableCount = unreachablePinUrns?.size ?? 0
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  return (
    <div className="px-4 py-1.5 border-t border-glass-border bg-canvas-elevated/40">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto custom-scrollbar">
          <LucideIcons.Pin className="w-3 h-3 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          {pinnedTargets.map((p) => {
            const isUnreachable = unreachablePinUrns?.has(p.urn) ?? false
            const hops = hopFromFocus?.get(p.urn)
            const titleParts: string[] = [p.label]
            if (isUnreachable) {
              titleParts.push('unreachable from focus')
            } else if (hops !== undefined && Number.isFinite(hops)) {
              titleParts.push(`${hops} ${hops === 1 ? 'hop' : 'hops'} from focus`)
            }
            return (
              <span
                key={p.urn}
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-2xs font-medium flex-shrink-0',
                  isUnreachable
                    ? 'bg-red-500/10 text-red-600 dark:text-red-400 ring-1 ring-red-500/40'
                    : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                )}
                title={titleParts.join(' · ')}
              >
                <span className="max-w-[120px] truncate">{p.label}</span>
                {!isUnreachable && hops !== undefined && Number.isFinite(hops) && (
                  <span className="text-amber-700/70 dark:text-amber-300/70 tabular-nums">
                    {hops}h
                  </span>
                )}
                {onUnpinTarget && (
                  <button
                    onClick={() => onUnpinTarget(p.urn)}
                    className="hover:bg-black/10 dark:hover:bg-white/10 rounded-sm p-0.5 -mr-0.5"
                    title="Unpin"
                  >
                    <LucideIcons.X className="w-2.5 h-2.5" />
                  </button>
                )}
              </span>
            )
          })}
          {unreachableCount > 0 && (
            <span
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-2xs font-medium bg-red-500/10 text-red-600 dark:text-red-400 flex-shrink-0"
              title="These pins have no lineage path from the focus"
            >
              <LucideIcons.AlertTriangle className="w-3 h-3" />
              {unreachableCount} unreachable
            </span>
          )}
        </div>
        {onSetPinDisplayMode && (
          <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 flex-shrink-0">
            <button
              onClick={() => onSetPinDisplayMode('hide')}
              className={cn(
                'px-2 py-1 rounded-md text-2xs font-medium transition-all',
                pinDisplayMode === 'hide'
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'text-ink-muted hover:bg-black/5 dark:hover:bg-white/10'
              )}
              title="Isolate — hide every node and edge that isn't on the pinned route"
            >
              Isolate
            </button>
            <button
              onClick={() => onSetPinDisplayMode('dim')}
              className={cn(
                'px-2 py-1 rounded-md text-2xs font-medium transition-all',
                pinDisplayMode === 'dim'
                  ? 'bg-amber-500 text-white shadow-sm'
                  : 'text-ink-muted hover:bg-black/5 dark:hover:bg-white/10'
              )}
              title="Dim — keep the full trace visible but grey out off-path elements"
            >
              Dim
            </button>
          </div>
        )}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => { setOptionsOpen(v => !v); setHelpOpen(false) }}
            className={cn(
              'p-1.5 rounded-md transition-all',
              optionsOpen
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted'
            )}
            title="Path highlight options"
            aria-label="Path highlight options"
            aria-expanded={optionsOpen}
          >
            <LucideIcons.SlidersHorizontal className="w-4 h-4" />
          </button>
          {optionsOpen && <PinOptionsPopover onClose={() => setOptionsOpen(false)} />}
        </div>
        <div className="relative flex-shrink-0">
          <button
            onClick={() => { setHelpOpen(v => !v); setOptionsOpen(false) }}
            className={cn(
              'p-1.5 rounded-md transition-all',
              helpOpen
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted'
            )}
            title="What does Pin Lineage do?"
            aria-label="Help"
            aria-expanded={helpOpen}
          >
            <LucideIcons.HelpCircle className="w-4 h-4" />
          </button>
          {helpOpen && <PinHelpPopover onClose={() => setHelpOpen(false)} />}
        </div>
        {onClearPins && (
          <button
            onClick={onClearPins}
            className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted transition-all flex-shrink-0"
            title="Clear all pins"
          >
            <LucideIcons.PinOff className="w-4 h-4" />
          </button>
        )}
      </div>
      {pathNodeCount !== undefined && pathEdgeCount !== undefined && (
        <div className="mt-1 text-2xs text-ink-muted">
          Showing path:{' '}
          <span className="text-amber-700 dark:text-amber-400 font-medium tabular-nums">
            {pathNodeCount}
          </span>{' '}
          {pathNodeCount === 1 ? 'node' : 'nodes'} ·{' '}
          <span className="text-amber-700 dark:text-amber-400 font-medium tabular-nums">
            {pathEdgeCount}
          </span>{' '}
          {pathEdgeCount === 1 ? 'edge' : 'edges'}
        </div>
      )}
    </div>
  )
}

function PinOptionsPopover({ onClose }: { onClose: () => void }) {
  const pinPathStyle = useCanvasStore((s) => s.pinPathStyle)
  const setPinPathStyle = useCanvasStore((s) => s.setPinPathStyle)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [onClose])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Path highlight options"
      className="absolute bottom-full right-0 mb-2 w-60 p-3 rounded-lg border border-glass-border bg-canvas-elevated shadow-xl z-50 text-xs"
    >
      <div className="font-medium text-ink mb-2">Path highlight</div>
      <div className="space-y-2">
        <div>
          <div className="text-2xs text-ink-muted mb-1">Intensity</div>
          <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-md p-0.5">
            {(['subtle', 'bold'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setPinPathStyle({ intensity: opt })}
                className={cn(
                  'flex-1 px-2 py-1 rounded-md text-2xs font-medium capitalize transition-all',
                  pinPathStyle.intensity === opt
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'text-ink-muted hover:bg-black/5 dark:hover:bg-white/10'
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={pinPathStyle.pulse}
            onChange={(e) => setPinPathStyle({ pulse: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-ink">Pulse animation</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={pinPathStyle.flow}
            onChange={(e) => setPinPathStyle({ flow: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-ink">Direction flow</span>
        </label>
      </div>
    </div>
  )
}

function PinHelpPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [onClose])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pin Lineage help"
      className="absolute bottom-full right-0 mb-2 w-80 p-3 rounded-lg border border-glass-border bg-canvas-elevated shadow-xl z-50 text-xs leading-relaxed space-y-2"
    >
      <div className="font-medium text-ink">Pin Lineage</div>
      <p className="text-ink-muted">
        Isolates the lineage path between the trace focus and the nodes you pin.
        The pinned route glows amber on the canvas.
      </p>
      <div>
        <div className="font-medium text-ink mb-0.5">Display modes</div>
        <p className="text-ink-muted">
          <span className="text-amber-700 dark:text-amber-400">Isolate</span> hides everything off the path.
          <span className="text-amber-700 dark:text-amber-400"> Dim</span> keeps the full trace as faded context.
        </p>
      </div>
      <div>
        <div className="font-medium text-ink mb-0.5">Pin a node from</div>
        <ul className="text-ink-muted list-disc list-inside space-y-0.5">
          <li>Right-click → "Pin to Trace Path"</li>
          <li>Hover a tree row → Pin button</li>
          <li>Entity drawer Pin button</li>
          <li>Search result chip → Pin icon</li>
          <li><kbd className="px-1 rounded bg-black/10 dark:bg-white/10">P</kbd> while a node is selected</li>
        </ul>
      </div>
      <p className="text-ink-muted">
        <span className="text-red-600 dark:text-red-400">Unreachable</span> pins
        have no lineage route from the focus — still visible, but contribute
        nothing to the isolated path. Re-pin elsewhere if unexpected.
      </p>
    </div>
  )
}

function PinDockEmptyHint() {
  const dismissed = useCanvasStore((s) => s.pinHintDismissed)
  const setDismissed = useCanvasStore((s) => s.setPinHintDismissed)
  if (dismissed) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-t border-glass-border bg-amber-500/5">
      <LucideIcons.Lightbulb className="w-3 h-3 text-amber-600 dark:text-amber-400 flex-shrink-0" />
      <div className="flex-1 text-2xs text-ink-muted">
        <span className="text-ink">Tip:</span> Pin nodes to isolate a lineage path —{' '}
        right-click a node, hover a tree row, or press{' '}
        <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 text-2xs">P</kbd>{' '}
        with one selected. The pinned route glows amber on the canvas.
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="px-2 py-0.5 rounded-md text-2xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/10 transition-all flex-shrink-0"
      >
        Got it
      </button>
    </div>
  )
}
