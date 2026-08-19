/**
 * TraceWalkIndicator — the floating "your trace is being calculated"
 * capsule, top-center over the canvas board (2026-08-19 ruling: the
 * board must never sit silent between the trace click and the first
 * merge wave; uplifted the same day with escape hatches and a fuller
 * anatomy).
 *
 * Anatomy: a pulsing indigo ORIGIN GLYPH (the same glow identity the
 * traced node carries, so capsule and node visibly belong together), a
 * semibold name line over a muted phase line whose counts tick in
 * tabular-nums (no width wobble), the phase's actions on the right —
 * and, while computing, the SOUNDING LINE: a cyan filament reaching
 * left (upstream) and an amber one right (downstream) from a center
 * origin, glinting outward, with honest per-direction counts at its
 * ends. No spinner and no percent bar — the walk's total is unknowable
 * and a percent would lie; ticking counts are the reassurance. The
 * glint's animation class is UNCONDITIONAL: under prefers-reduced-motion
 * only the travel freezes (globals.css), the filaments never disappear.
 *
 * Escape hatches: Cancel while computing ABORTS the trace session;
 * paused/stalled offer their verb plus a dismiss that keeps the partial
 * flow on the board; error offers Retry and Cancel (nothing is drawn —
 * the way out is leaving the trace).
 *
 * Presentational only: the canvas derives `phase` from the walk session
 * (useCanvasTraceWalk) and owns the settled-state auto-dismiss.
 */
import * as LucideIcons from 'lucide-react'

export type TraceWalkPhase = 'preparing' | 'walking' | 'settled' | 'paused' | 'stalled' | 'error'

export interface TraceWalkIndicatorProps {
    /** Display name of the traced entity. */
    label: string
    phase: TraceWalkPhase
    nodeCount: number
    flowCount: number
    /** Participants per direction (model.upstreamUrns / downstreamUrns). */
    upCount: number
    downCount: number
    /** Abort the trace session entirely (computing and error phases). */
    onCancel?: () => void
    /** Budget grant / stalled re-arm ("Keep walking" / "Try again"). */
    onContinue?: () => void
    /** Re-kick a failed initial fetch. */
    onRetry?: () => void
    /** Hide the capsule but KEEP the partial flow (paused/stalled). */
    onDismiss?: () => void
}

const COMPUTING: ReadonlySet<TraceWalkPhase> = new Set(['preparing', 'walking'])

const actionClass =
    'px-2.5 py-1 rounded-lg text-[10.5px] font-semibold text-ink bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.09] dark:hover:bg-white/[0.13] transition-colors'
const quietActionClass =
    'px-2 py-1 rounded-lg text-[10.5px] font-medium text-ink-muted hover:text-ink transition-colors'

export function TraceWalkIndicator({
    label,
    phase,
    nodeCount,
    flowCount,
    upCount,
    downCount,
    onCancel,
    onContinue,
    onRetry,
    onDismiss,
}: TraceWalkIndicatorProps) {
    const computing = COMPUTING.has(phase)

    const detail =
        phase === 'preparing' ? 'Mapping the flow from the source…'
        : phase === 'walking' ? `${nodeCount} nodes · ${flowCount} flows and counting`
        : phase === 'settled' ? `Flow drawn — ${nodeCount} nodes · ${flowCount} flows`
        : phase === 'paused' ? `Paused at ${nodeCount} nodes — the flow continues`
        : phase === 'stalled' ? 'Some steps could not be walked'
        : "Couldn't reach the data source"

    return (
        <div
            data-canvas-interactive
            className="pointer-events-auto flex flex-col gap-2 min-w-[300px] max-w-[420px] px-4 py-2.5 rounded-2xl border border-black/[0.07] dark:border-white/[0.09] bg-white/85 dark:bg-neutral-900/85 backdrop-blur-xl shadow-lg shadow-black/[0.07] dark:shadow-black/40 text-[11px]"
            role="status"
            aria-live="polite"
        >
            <div className="flex items-center gap-3">
                {/* Origin glyph — the traced node's own pulse identity. */}
                <span className="relative flex-none w-2.5 h-2.5" aria-hidden="true">
                    <span className={`absolute inset-0 rounded-full bg-indigo-500 ${computing ? 'nx-trace-origin-pulse' : ''}`} />
                </span>
                <span className="flex-1 min-w-0">
                    <span className="block text-[12px] font-semibold text-ink truncate leading-tight">{label}</span>
                    <span className="block text-ink-muted tabular-nums leading-tight mt-0.5">{detail}</span>
                </span>
                <span className="flex items-center gap-1.5 flex-none">
                    {phase === 'paused' && onContinue && (
                        <button type="button" onClick={onContinue} className={actionClass}>Keep walking</button>
                    )}
                    {phase === 'stalled' && onContinue && (
                        <button type="button" onClick={onContinue} className={actionClass}>Try again</button>
                    )}
                    {phase === 'error' && onRetry && (
                        <button type="button" onClick={onRetry} className={actionClass}>Retry</button>
                    )}
                    {(computing || phase === 'error') && onCancel && (
                        <button type="button" onClick={onCancel} className={quietActionClass}>Cancel</button>
                    )}
                    {(phase === 'paused' || phase === 'stalled') && onDismiss && (
                        <button
                            type="button"
                            onClick={onDismiss}
                            aria-label="Dismiss"
                            className="p-1 rounded-lg text-ink-muted hover:text-ink transition-colors"
                        >
                            <LucideIcons.X className="w-3 h-3" />
                        </button>
                    )}
                </span>
            </div>
            {computing && (
                <div className="flex items-center gap-2.5">
                    <span className="flex-none text-[9.5px] text-cyan-600 dark:text-cyan-400 tabular-nums">
                        {`↑ ${upCount} upstream`}
                    </span>
                    <span className="nx-trace-sounding flex-1" aria-hidden="true">
                        <span className="nx-trace-sounding-up" />
                        <span className="nx-trace-sounding-origin" />
                        <span className="nx-trace-sounding-down" />
                    </span>
                    <span className="flex-none text-[9.5px] text-amber-600 dark:text-amber-400 tabular-nums">
                        {`${downCount} downstream ↓`}
                    </span>
                </div>
            )}
        </div>
    )
}
