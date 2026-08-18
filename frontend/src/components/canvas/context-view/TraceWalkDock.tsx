/**
 * TraceWalkBar — narration strip for the NATIVE canvas trace.
 *
 * The walk fetches and merges by itself (useCanvasTraceWalk); this bar's
 * whole job is to SAY where that stands and hold the three controls:
 * Keep walking (budget grant / stalled re-arm), Retry (failed initial
 * fetch), Exit trace. Counts come off the same walk model the canvas
 * draws, plus the honesty count for participants the curated view's
 * layer-assignment rule hides.
 *
 * Chrome follows the canvas banner + Lens narration-strip idiom (amber
 * for states needing attention, quiet ink otherwise).
 */
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FullWalkStatus, LensWalkStatus } from '@/hooks/useLensWalk'

export interface TraceWalkBarProps {
  tracedName: string
  nodeCount: number
  flowCount: number
  /** Flow participants the layer-assignment rule keeps off the canvas. */
  hiddenCount: number
  walkStatus: LensWalkStatus
  walkError: string | null
  status: FullWalkStatus | null
  onKeepWalking: () => void
  onRetry: () => void
  onExit: () => void
}

export function TraceWalkBar({
  tracedName,
  nodeCount,
  flowCount,
  hiddenCount,
  walkStatus,
  walkError,
  status,
  onKeepWalking,
  onRetry,
  onExit,
}: TraceWalkBarProps) {
  const failed = walkStatus === 'error'
  const attention = failed || status?.budgetHit || status?.stalled

  return (
    <div
      data-canvas-interactive
      role="status"
      className={cn(
        'flex items-center gap-2 px-4 py-1.5 border-b text-[11px]',
        attention
          ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400'
          : 'border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] text-ink-muted',
      )}
    >
      {status?.walking && (
        <LucideIcons.Loader2 className="w-3 h-3 flex-shrink-0 animate-spin text-accent-lineage/80" />
      )}
      {failed ? (
        <>
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span>
            Couldn&apos;t trace {tracedName}
            {walkError ? ` — ${walkError}` : '.'}
          </span>
          <button type="button" onClick={onRetry} className="flex-shrink-0 font-semibold hover:underline">
            Retry
          </button>
        </>
      ) : (
        <span>
          {status?.walking
            ? `Tracing ${tracedName} · ${nodeCount} nodes · ${flowCount} flows`
            : `Full flow · ${nodeCount} nodes · ${flowCount} flows`}
          {hiddenCount > 0 ? ` · ${hiddenCount} not shown (no layer assignment)` : ''}
        </span>
      )}
      {status?.budgetHit && (
        <>
          <span className="flex-shrink-0">{`The flow continues past ${nodeCount} nodes.`}</span>
          <button type="button" onClick={onKeepWalking} className="flex-shrink-0 font-semibold hover:underline">
            Keep walking
          </button>
        </>
      )}
      {status?.stalled && (
        <>
          <span className="flex-shrink-0">Part of the flow could not be walked.</span>
          <button type="button" onClick={onKeepWalking} className="flex-shrink-0 font-semibold hover:underline">
            Try again
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onExit}
        className="ml-auto flex-shrink-0 flex items-center gap-1 font-semibold text-ink-muted hover:text-ink hover:underline"
      >
        <LucideIcons.X className="w-3 h-3" />
        Exit trace
      </button>
    </div>
  )
}
