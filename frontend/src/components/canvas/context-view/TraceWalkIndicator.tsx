/**
 * TraceWalkIndicator — the floating "your trace is being calculated"
 * capsule, top-center over the canvas board (2026-08-19 ruling: the
 * board must never sit silent between the trace click and the first
 * merge wave).
 *
 * Design: no spinner and no percent bar — the walk's total is unknowable
 * and a percent would lie. Reassurance comes from live counts ticking as
 * waves land, and from the SOUNDING LINE: a center origin dot with a
 * cyan filament running left (upstream) and an amber one running right
 * (downstream) — the trace metaphor itself, in the same wire colors the
 * flow will land in. The glint animation class is UNCONDITIONAL: under
 * prefers-reduced-motion only the travel freezes (globals.css), the
 * filaments never disappear — same rule as the lens's seam class.
 *
 * Presentational only: the canvas derives `phase` from the walk session
 * (useCanvasTraceWalk) and owns the settled-state auto-dismiss.
 */

export type TraceWalkPhase = 'preparing' | 'walking' | 'settled' | 'paused' | 'stalled' | 'error'

export interface TraceWalkIndicatorProps {
    /** Display name of the traced entity. */
    label: string
    phase: TraceWalkPhase
    nodeCount: number
    flowCount: number
    /** Budget grant / stalled re-arm ("Keep walking" / "Try again"). */
    onContinue?: () => void
    /** Re-kick a failed initial fetch. */
    onRetry?: () => void
}

const COMPUTING: ReadonlySet<TraceWalkPhase> = new Set(['preparing', 'walking'])

export function TraceWalkIndicator({
    label,
    phase,
    nodeCount,
    flowCount,
    onContinue,
    onRetry,
}: TraceWalkIndicatorProps) {
    const line =
        phase === 'preparing' ? (
            <>
                <span className="font-semibold text-ink">Tracing {label}</span>
                <span className="text-ink-muted"> — mapping the flow…</span>
            </>
        ) : phase === 'walking' ? (
            <>
                <span className="font-semibold text-ink">Tracing {label}</span>
                <span className="text-ink-muted">{` — ${nodeCount} nodes · ${flowCount} flows so far`}</span>
            </>
        ) : phase === 'settled' ? (
            <span className="text-ink">{`Flow drawn — ${nodeCount} nodes · ${flowCount} flows`}</span>
        ) : phase === 'paused' ? (
            <span className="text-ink">{`Paused at ${nodeCount} nodes — the flow continues`}</span>
        ) : phase === 'stalled' ? (
            <span className="text-ink">Some steps could not be walked</span>
        ) : (
            <span className="text-ink">Couldn&apos;t reach the data source</span>
        )

    return (
        <div
            data-canvas-interactive
            className="pointer-events-auto flex flex-col items-center gap-1 px-4 py-2 rounded-full border border-black/[0.07] dark:border-white/[0.09] bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md shadow-sm text-[11px] leading-none"
            role="status"
            aria-live="polite"
        >
            <div className="flex items-center gap-3">
                <span>{line}</span>
                {phase === 'paused' && onContinue && (
                    <button type="button" onClick={onContinue} className="font-semibold text-ink hover:underline">
                        Keep walking
                    </button>
                )}
                {phase === 'stalled' && onContinue && (
                    <button type="button" onClick={onContinue} className="font-semibold text-ink hover:underline">
                        Try again
                    </button>
                )}
                {phase === 'error' && onRetry && (
                    <button type="button" onClick={onRetry} className="font-semibold text-ink hover:underline">
                        Retry
                    </button>
                )}
            </div>
            {COMPUTING.has(phase) && (
                <div className="nx-trace-sounding" aria-hidden="true">
                    <span className="nx-trace-sounding-up" />
                    <span className="nx-trace-sounding-origin" />
                    <span className="nx-trace-sounding-down" />
                </div>
            )}
        </div>
    )
}
