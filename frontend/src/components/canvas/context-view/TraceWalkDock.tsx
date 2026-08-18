/**
 * TraceWalkDock — the NATIVE canvas trace's bottom dock.
 *
 * The walk fetches and merges by itself (useCanvasTraceWalk); this dock
 * SAYS where it stands and COUNTS the flow's shape:
 *
 *  - upstream / downstream counts in the exact colors the wires are
 *    painted with (cyan feeds in, amber flows out) — and each count is a
 *    TOGGLE that shows/hides that direction on the canvas;
 *  - a per-entity-type census (the closure walk is level-free, so "what
 *    levels did it cross" is answered honestly as "what it found:
 *    3 platforms · 14 datasets · 96 columns");
 *  - the honesty count for participants layer assignment keeps off the
 *    canvas, and the walk states: walking, full flow, budget ("Keep
 *    walking"), stalled ("Try again"), failed ("Retry");
 *  - an expandable panel listing every participant per direction, each
 *    row jumping the canvas to that node;
 *  - a "Flow view" escalation that opens the Lineage Lens on the traced
 *    node — the end-to-end narrative surface — without leaving the
 *    canvas experience behind.
 *
 * Chrome: bottom-docked strip in the canvas-elevated idiom, amber only
 * where attention is needed.
 */
import { useEffect, useRef, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FullWalkStatus, LensWalkStatus } from '@/hooks/useLensWalk'

export interface TraceWalkDockProps {
  tracedName: string
  nodeCount: number
  flowCount: number
  upstreamCount: number
  downstreamCount: number
  /** Flow participants the layer-assignment rule keeps off the canvas. */
  hiddenCount: number
  /** Nodes per entity type, largest first. */
  typeCensus: Array<{ type: string; count: number }>
  /** Participants per direction, for the expandable panel. */
  upstream: Array<{ urn: string; label: string }>
  downstream: Array<{ urn: string; label: string }>
  showUpstream: boolean
  showDownstream: boolean
  onToggleUpstream: () => void
  onToggleDownstream: () => void
  onJumpToUrn: (urn: string) => void
  /** Open the Lineage Lens on the traced node — the flow narrative. */
  onOpenFlowView: () => void
  walkStatus: LensWalkStatus
  walkError: string | null
  status: FullWalkStatus | null
  onKeepWalking: () => void
  onRetry: () => void
  onExit: () => void
}

export function TraceWalkDock({
  tracedName,
  nodeCount,
  flowCount,
  upstreamCount,
  downstreamCount,
  hiddenCount,
  typeCensus,
  upstream,
  downstream,
  showUpstream,
  showDownstream,
  onToggleUpstream,
  onToggleDownstream,
  onJumpToUrn,
  onOpenFlowView,
  walkStatus,
  walkError,
  status,
  onKeepWalking,
  onRetry,
  onExit,
}: TraceWalkDockProps) {
  const [expanded, setExpanded] = useState(false)
  const failed = walkStatus === 'error'

  // Publish the dock's real height as --trace-dock-height on the canvas
  // body (same contract the legacy dock had): EdgeLegend, the status
  // chips, and the scroll padding all lift above it automatically. Runs
  // every render so strips/panel growth is always reflected.
  const dockRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = dockRef.current
    const parent = el?.closest<HTMLElement>('[data-canvas-body]')
    if (!el || !parent) return
    parent.style.setProperty('--trace-dock-height', `${el.offsetHeight + 12}px`)
    return () => {
      parent.style.removeProperty('--trace-dock-height')
    }
  })

  return (
    <div
      ref={dockRef}
      data-canvas-interactive
      className="absolute bottom-0 left-0 right-0 z-30 border-t border-black/10 dark:border-white/10 bg-canvas-elevated/95 backdrop-blur-sm shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
    >
      {/* ── Stats row ── */}
      <div className="flex items-center gap-3 px-4 py-2 text-xs">
        <LucideIcons.Route className="w-4 h-4 flex-shrink-0 text-accent-lineage" />
        <div className="min-w-0 flex items-baseline gap-2">
          <span className="font-semibold text-ink truncate">
            {status?.walking ? `Tracing ${tracedName}` : `Full flow of ${tracedName}`}
          </span>
          {status?.walking && (
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-accent-lineage/80" aria-label="Walking the flow" />
          )}
          <span className="text-ink-muted flex-shrink-0">{`${nodeCount} nodes · ${flowCount} flows`}</span>
        </div>

        {/* Direction toggles — the same colors the wires wear. */}
        <button
          type="button"
          onClick={onToggleUpstream}
          aria-pressed={showUpstream}
          title="Show or hide everything that feeds this entity"
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold text-cyan-600 dark:text-cyan-400 border transition-colors',
            showUpstream
              ? 'border-cyan-500/30 bg-cyan-500/10'
              : 'border-transparent opacity-40 hover:opacity-70',
          )}
        >
          <LucideIcons.ArrowDownLeft className="w-3 h-3" />
          {`${upstreamCount} upstream`}
        </button>
        <button
          type="button"
          onClick={onToggleDownstream}
          aria-pressed={showDownstream}
          title="Show or hide everything this entity feeds"
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-md font-semibold text-amber-600 dark:text-amber-400 border transition-colors',
            showDownstream
              ? 'border-amber-500/30 bg-amber-500/10'
              : 'border-transparent opacity-40 hover:opacity-70',
          )}
        >
          <LucideIcons.ArrowUpRight className="w-3 h-3" />
          {`${downstreamCount} downstream`}
        </button>

        {/* Census — what the walk found, by kind. */}
        <span className="hidden md:inline text-ink-muted/80 truncate">
          {typeCensus.map(t => `${t.count} ${t.type}`).join(' · ')}
        </span>

        {hiddenCount > 0 && (
          <span className="text-amber-600 dark:text-amber-400 flex-shrink-0">
            {`${hiddenCount} not shown (no layer assignment)`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onOpenFlowView}
            title="Open the flow narrative — the lineage end to end, hop by hop"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-accent-lineage border border-black/10 dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            <LucideIcons.GitBranch className="w-3 h-3" />
            Flow view
          </button>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-ink-muted border border-black/10 dark:border-white/10 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            <LucideIcons.List className="w-3 h-3" />
            {expanded ? 'Hide participants' : 'Show participants'}
          </button>
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-ink border border-black/10 dark:border-white/10 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            <LucideIcons.X className="w-3 h-3" />
            Exit trace
          </button>
        </div>
      </div>

      {/* ── Attention strips ── */}
      {failed && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-amber-500/25 bg-amber-500/[0.06] text-[11px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>
            Couldn&apos;t trace {tracedName}
            {walkError ? ` — ${walkError}` : '.'}
          </span>
          <button type="button" onClick={onRetry} className="ml-auto flex-shrink-0 font-semibold hover:underline">
            Retry
          </button>
        </div>
      )}
      {status?.budgetHit && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-amber-500/25 bg-amber-500/[0.06] text-[11px] text-amber-700 dark:text-amber-400">
          <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
          <span>{`The flow continues past ${nodeCount} nodes — the walk paused at its safety budget.`}</span>
          <button type="button" onClick={onKeepWalking} className="ml-auto flex-shrink-0 font-semibold hover:underline">
            Keep walking
          </button>
        </div>
      )}
      {status?.stalled && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-amber-500/25 bg-amber-500/[0.06] text-[11px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>Part of the flow could not be walked — some steps failed at the data source.</span>
          <button type="button" onClick={onKeepWalking} className="ml-auto flex-shrink-0 font-semibold hover:underline">
            Try again
          </button>
        </div>
      )}

      {/* ── Participants panel ── */}
      {expanded && (
        <div className="grid grid-cols-2 gap-0 border-t border-black/[0.06] dark:border-white/[0.06] max-h-48 overflow-y-auto">
          {([
            { heading: 'Upstream', items: upstream, tone: 'text-cyan-600 dark:text-cyan-400' },
            { heading: 'Downstream', items: downstream, tone: 'text-amber-600 dark:text-amber-400' },
          ] as const).map(({ heading, items, tone }) => (
            <div key={heading} className="min-w-0 px-4 py-2">
              <p className={cn('text-[10px] font-semibold uppercase tracking-wide mb-1', tone)}>
                {`${heading} · ${items.length}`}
              </p>
              <ul aria-label={heading} className="space-y-0.5">
                {items.map(p => (
                  <li key={p.urn}>
                    <button
                      type="button"
                      onClick={() => onJumpToUrn(p.urn)}
                      title="Jump to this entity on the canvas"
                      className="max-w-full truncate text-[11px] text-ink-muted hover:text-ink hover:underline"
                    >
                      {p.label}
                    </button>
                  </li>
                ))}
                {items.length === 0 && (
                  <li className="text-[11px] text-ink-muted/60">none in this flow</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
