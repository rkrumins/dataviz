/**
 * TraceWalkIndicator — the capsule that narrates a trace while it computes.
 *
 * THE COMPLAINT (user, 2026-08-21): "trace chrome on, browse picture
 * underneath, nothing happening." A trace opens its session the instant the
 * reader clicks, but the overlay only draws once the model holds the focus —
 * and the background walk then runs for as long as the flow is wide. In
 * between, the canvas showed the browse picture under trace furniture, which
 * reads as broken. This capsule owns that window: from the click until the
 * overlay lands, and for as long as the walk runs behind it.
 *
 * WHAT IT SAYS, and why each line is the honest one:
 *  • `coarse`   the focus has not been found yet — nothing on the board is
 *               the trace's answer, and the sounding line has not reached out.
 *  • `walking`  the board IS readable; the walk is widening it. The numbers
 *               are the driver's own (`nodesHeld`, `requests`), and the
 *               per-direction counts read as FLOORS, because a walk that is
 *               still finding partners cannot honestly claim a total.
 *  • `ceiling`  the MODEL is full, not the flow — so the sentence says what
 *               is held and what is left, and "Keep walking" buys another
 *               ceiling's worth. This is the one moment the capsule asks the
 *               reader for a decision, so it carries the only filled button.
 *  • `error`    the failure, verbatim. "Try again" re-arms it.
 *  • `complete` one beat, then gone. The dock owns the permanent stats.
 *
 * NO SPINNER AND NO PERCENT. The walk's total is unknowable until it ends —
 * a bar that fills would be a lie about a graph nobody has counted. The
 * signature is the SOUNDING LINE: from an indigo origin, a cyan filament
 * reaches upstream and an amber one downstream, in the colours the wires
 * themselves land in. It is short and dim while the focus is still being
 * found and REACHES OUT the moment the walk starts, so the motion means the
 * grain rather than merely decorating it. Under reduced motion the travel
 * freezes; the filaments and their colours never disappear (globals.css owns
 * both, which is why this file never asks `matchMedia`).
 *
 * IT MUST NEVER BE THE THING THAT BLOCKS. No store writes, no state but the
 * completion beat, and `pointer-events` only on its own buttons — a reader
 * may open cards on the board underneath while the walk runs. It unmounts
 * synchronously with the trace: no exit animation to strand (this codebase's
 * portalled-AnimatePresence freeze class), so leaving is instant.
 *
 * Colours are explicit palette values, never the `accent-lineage` token:
 * Tailwind's opacity modifiers are inert on that variable family, so
 * `accent-lineage/20` paints solid and a "subtle" wash arrives opaque.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** How long the finished beat holds before the capsule leaves. Long enough
 *  to read "Complete", short enough that it never becomes furniture. */
export const COMPLETE_DISMISS_MS = 600

/** The driver's phases, minus `idle` — the host does not mount at idle. */
export type TraceCapsulePhase = 'coarse' | 'walking' | 'ceiling' | 'complete' | 'error'

export interface TraceWalkIndicatorProps {
    phase: TraceCapsulePhase
    /** Nodes the model holds — `driver.ceiling.nodesHeld`. */
    nodesHeld: number
    /** Requests this session has issued — `driver.requests`. */
    requests: number
    /** What the VIEW counts on each side — `overlay.view.counts`. */
    upCount: number
    downCount: number
    /** Those counts are lower bounds until the flow is exhausted. */
    countsAreFloors: boolean
    /** Boundaries still unfollowed at the ceiling — `driver.ceiling.frontierRemaining`. */
    frontierRemaining: number
    /** The failure, as the driver reported it. */
    error: string | null
    /** Leave the trace (`exitCanvasTrace`). */
    onCancel: () => void
    /** Grant another ceiling's worth and resume (`continueWalk`). */
    onContinue: () => void
    /** Re-kick what failed (`retryWalk`). */
    onRetry: () => void
}

const fmt = (n: number): string => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`

/** The two lines: what is happening, and the numbers behind it. */
function narrate(p: TraceWalkIndicatorProps): { headline: string; meta: string } {
    switch (p.phase) {
        case 'coarse':
            return { headline: 'Finding the focus…', meta: 'Reading the lineage around it' }
        case 'walking':
            return {
                headline: 'Mapping the flow',
                meta: `${plural(p.nodesHeld, 'node', 'nodes')} · ${plural(p.requests, 'request', 'requests')}`,
            }
        case 'ceiling':
            return {
                headline: `Showing the first ${fmt(p.nodesHeld)} of a flow that continues`,
                meta: `${plural(p.frontierRemaining, 'more boundary', 'more boundaries')} to follow`,
            }
        case 'complete':
            return {
                headline: `Complete — ${plural(p.nodesHeld, 'node', 'nodes')}`,
                meta: `${plural(p.requests, 'request', 'requests')} · nothing left to follow`,
            }
        case 'error':
            return {
                headline: p.error?.trim() || 'The trace could not be completed',
                meta: `Stopped after ${plural(p.requests, 'request', 'requests')}`,
            }
    }
}

/** The sounding line shows while there is a flow being walked or held. */
const SOUNDS: ReadonlySet<TraceCapsulePhase> = new Set(['coarse', 'walking', 'ceiling'])

const quietAction =
    'pointer-events-auto px-2.5 py-1 rounded-lg text-[11px] font-medium text-ink-muted '
    + 'hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60'
const primaryAction =
    'pointer-events-auto px-3 py-1 rounded-lg text-[11px] font-semibold text-white '
    + 'bg-gradient-to-r from-indigo-500 to-violet-500 shadow-sm shadow-indigo-500/30 '
    + 'hover:from-indigo-400 hover:to-violet-400 transition-colors '
    + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1'

export function TraceWalkIndicator(props: TraceWalkIndicatorProps) {
    const { phase, upCount, downCount, countsAreFloors, onCancel, onContinue, onRetry } = props

    // THE ONLY STATE, and it is one shot: the finished beat holds for
    // `COMPLETE_DISMISS_MS` and then the capsule removes itself, rather than
    // fading to an invisible node that keeps a stale sentence inside a live
    // `aria-live` region. `complete` is terminal within a session, so the
    // host's `key={tracedUrn}` is what re-arms it for the next trace — no
    // reset path, and nothing to set synchronously during an effect.
    const [dismissed, setDismissed] = useState(false)
    useEffect(() => {
        if (phase !== 'complete') return
        const timer = window.setTimeout(() => setDismissed(true), COMPLETE_DISMISS_MS)
        return () => window.clearTimeout(timer)
    }, [phase])
    if (dismissed) return null

    const { headline, meta } = narrate(props)
    const floor = countsAreFloors ? '+' : ''

    return (
        <div
            role="status"
            aria-live="polite"
            data-trace-phase={phase}
            // Flex-centred, never transform-centred: the capsule owns its own
            // transform channel for the entrance glide.
            // z-40 clears the columns' own chrome (resize handles and
            // periphery rails sit at z-30 in a stacking context this shares),
            // which would otherwise paint over the capsule's buttons and make
            // the way out unclickable. The dock is z-40 too and never
            // overlaps it — it lives at the other end of the board.
            className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-4"
        >
            <div
                className={cn(
                    'nx-trace-capsule pointer-events-none flex flex-col gap-2 w-full min-w-0 max-w-[460px]',
                    'px-4 py-2.5 rounded-2xl backdrop-blur-xl',
                    'bg-white/85 dark:bg-neutral-900/85',
                    'ring-1 ring-black/[0.07] dark:ring-white/[0.09]',
                    'shadow-xl shadow-black/[0.08] dark:shadow-black/50',
                )}
            >
                <div className="flex items-center gap-3">
                    {/* The origin glyph carries the traced node's own pulse
                        identity, so the capsule and the focus on the board
                        read as one thing. */}
                    <span className="relative flex-none w-2.5 h-2.5" aria-hidden="true">
                        <span
                            className={cn(
                                'absolute inset-0 rounded-full bg-indigo-500',
                                phase === 'error' && 'bg-rose-500',
                                (phase === 'coarse' || phase === 'walking') && 'nx-trace-origin-pulse',
                            )}
                        />
                    </span>
                    <span className="flex-1 min-w-0">
                        <span className="block font-display text-[12.5px] font-semibold text-ink leading-tight line-clamp-2">
                            {headline}
                        </span>
                        {/* The ticking numbers are deliberately outside the
                            announcement: a polite region that re-reads itself
                            every wave is noise, and the phase sentence above
                            is the part worth hearing. */}
                        <span
                            aria-hidden="true"
                            className="block mt-0.5 text-[10.5px] text-ink-muted tabular-nums leading-tight"
                        >
                            {meta}
                        </span>
                    </span>
                    <span className="flex items-center gap-1.5 flex-none">
                        {phase === 'ceiling' && (
                            <button type="button" onClick={onContinue} className={primaryAction}>
                                Keep walking
                            </button>
                        )}
                        {phase === 'error' && (
                            <button type="button" onClick={onRetry} className={quietAction}>
                                Try again
                            </button>
                        )}
                        {phase !== 'complete' && (
                            <button type="button" onClick={onCancel} className={quietAction}>
                                Cancel
                            </button>
                        )}
                    </span>
                </div>

                {SOUNDS.has(phase) && (
                    <div className="flex items-center gap-2.5" aria-hidden="true">
                        <span className="flex-none w-[4.5rem] text-right text-[10px] font-medium text-cyan-600 dark:text-cyan-400 tabular-nums">
                            {phase === 'coarse' ? '' : `↑ ${fmt(upCount)}${floor}`}
                        </span>
                        <span className="nx-trace-sounding">
                            <span className="nx-trace-sounding-up" />
                            <span className="nx-trace-sounding-origin" />
                            <span className="nx-trace-sounding-down" />
                        </span>
                        <span className="flex-none w-[4.5rem] text-[10px] font-medium text-amber-600 dark:text-amber-400 tabular-nums">
                            {phase === 'coarse' ? '' : `${fmt(downCount)}${floor} ↓`}
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
}
