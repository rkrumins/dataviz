/**
 * TraceWalkIndicator — the capsule that narrates a canvas trace while it
 * computes (designed 2026-08-19; re-read off the walk driver's own phases
 * 2026-08-21, D4 of the trace/lens uplift).
 *
 * THE COMPLAINT: "trace chrome on, browse picture underneath, nothing
 * happening." A trace opens its session the instant the reader clicks, but
 * the overlay only draws once the model holds the focus — and the
 * hands-free walk then runs for as long as the flow is wide. This capsule
 * owns that window: from the click until the overlay lands, and for as long
 * as the walk runs behind it.
 *
 * WHAT IT SAYS, phase by phase (`WalkProgress.phase`):
 *  • `loading`     the focus has not been found yet — nothing on the board
 *                  is the trace's answer, the sounding line is barely out.
 *  • `seeding`     the immediate lineage is loading; counts tick.
 *  • `walking`     the full flow is being mapped; counts tick.
 *  • `checkpoint`  the one-time memory checkpoint — the ONE decision the
 *                  capsule asks: Continue.
 *  • `error`       a step failed at the data source — Try again.
 *  • `done`        one beat of "Complete", then it leaves; the dock owns the
 *                  permanent numbers.
 *
 * NO SPINNER AND NO PERCENT. The walk's total is unknowable until it ends —
 * a bar that fills would be a lie about a graph nobody has counted. The
 * signature is the SOUNDING LINE: from an indigo origin, a cyan filament
 * reaches upstream and an amber one downstream, in the colours the wires
 * themselves land in; it is short while the focus is still being found and
 * reaches out the moment the walk starts. Reduced motion freezes the travel
 * in CSS (globals.css); the filaments never disappear.
 *
 * IT MUST NEVER BE THE THING THAT BLOCKS. No store writes, no state but the
 * completion beat, `pointer-events` only on its own buttons, and no exit
 * animation to strand (this codebase's portalled-AnimatePresence freeze
 * class) — it unmounts with the trace.
 *
 * ON THE LENS BOARD TOO (2026-08-22). "The loading state can be missed and
 * the user might confuse that for nothing happening": the Lens's own
 * surfaces were ten pixels of muted header text and a toast at the foot
 * of a full-screen board. It now mounts this capsule from the moment
 * Focus opens, so both boards say "calculating" in one voice. The Lens
 * passes a `subject` (the focus is known before anything is fetched, so
 * "Finding the focus…" would be wrong there) and no `onCancel` (the
 * Lens's way out is its own close). A capsule mounted already `done`
 * says nothing — a focus walked earlier opens quiet — and a later wave
 * (a ⊕) brings it back, since that is a new computation.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { WalkProgress } from '@/hooks/useLensWalk'

/** How long the finished beat holds before the capsule leaves. */
export const COMPLETE_DISMISS_MS = 600

export interface TraceWalkIndicatorProps {
    phase: WalkProgress['phase']
    nodes: number
    flows: number
    requests: number
    /** Steps still owed (or, in `error`, the steps that failed). */
    pending: number
    error: string | null
    /** What the VIEW counts on each side. */
    upCount: number
    downCount: number
    /** What is being walked, when it is known before the first page lands
     *  (the Lens): the `loading` headline names it instead of "the focus". */
    subject?: string
    /** Leave the trace. Absent = no Cancel (the Lens closes by itself). */
    onCancel?: () => void
    /** Lift the memory checkpoint for this focus. */
    onContinue: () => void
    /** Give the failed steps one more attempt. */
    onRetry: () => void
}

const fmt = (n: number): string => n.toLocaleString('en-US')
const plural = (n: number, one: string, many: string): string => `${fmt(n)} ${n === 1 ? one : many}`
const counts = (p: TraceWalkIndicatorProps): string =>
    `${plural(p.nodes, 'node', 'nodes')} · ${plural(p.flows, 'flow', 'flows')} · ${plural(p.requests, 'request', 'requests')}`

/** The two lines: what is happening, and the numbers behind it. */
function narrate(p: TraceWalkIndicatorProps): { headline: string; meta: string } {
    switch (p.phase) {
        case 'loading':
            return p.subject
                ? { headline: `Mapping the lineage of ${p.subject}`, meta: 'Asking the data source what feeds it and what it feeds' }
                : { headline: 'Finding the focus…', meta: 'Reading the lineage around it' }
        case 'seeding':
            return { headline: 'Loading the immediate lineage', meta: counts(p) }
        case 'walking':
            return { headline: 'Mapping the flow', meta: counts(p) }
        case 'checkpoint':
            return {
                headline: `This flow is larger than ${fmt(p.nodes)} nodes`,
                meta: 'Loading the rest may slow this browser',
            }
        case 'error':
            return {
                headline: 'Part of the lineage could not be loaded',
                meta: `${plural(p.pending, 'step', 'steps')} failed at the data source · ${plural(p.nodes, 'node', 'nodes')} on the board`,
            }
        case 'done':
            return { headline: `Complete — ${plural(p.nodes, 'node', 'nodes')} · ${plural(p.flows, 'flow', 'flows')}`, meta: plural(p.requests, 'request', 'requests') }
    }
}

/** The sounding line shows while there is a flow being walked or held. */
const SOUNDS: ReadonlySet<WalkProgress['phase']> = new Set(['loading', 'seeding', 'walking', 'checkpoint'])
const COMPUTING: ReadonlySet<WalkProgress['phase']> = new Set(['loading', 'seeding', 'walking'])

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
    const { phase, upCount, downCount, onCancel, onContinue, onRetry } = props

    // THE ONLY STATE: the finished beat holds for `COMPLETE_DISMISS_MS` and
    // then the capsule removes itself, rather than fading to an invisible
    // node that keeps a stale sentence inside a live `aria-live` region.
    // Mounted already `done` it is not armed (nothing was seen to start),
    // and any computing phase re-arms it — a new wave is a new
    // computation. The re-arm is the "previous render" pattern, not an
    // effect: a setState in an effect body is a cascading render. The
    // host may also key it on the focus.
    const [armed, setArmed] = useState(phase !== 'done')
    const [beatOver, setBeatOver] = useState(false)
    const [prevPhase, setPrevPhase] = useState(phase)
    if (prevPhase !== phase) {
        setPrevPhase(phase)
        if (COMPUTING.has(phase)) { setArmed(true); setBeatOver(false) }
    }
    useEffect(() => {
        if (phase !== 'done') return
        const timer = window.setTimeout(() => setBeatOver(true), COMPLETE_DISMISS_MS)
        return () => window.clearTimeout(timer)
    }, [phase])
    if (!armed || (phase === 'done' && beatOver)) return null

    const { headline, meta } = narrate(props)
    // Until the flow is exhausted the direction counts are floors.
    const floor = phase === 'done' ? '' : '+'

    return (
        <div
            role="status"
            aria-live="polite"
            data-trace-phase={phase}
            // Flex-centred, never transform-centred: the capsule owns its own
            // transform channel for the entrance glide. z-40 clears the
            // columns' own chrome (z-30), which would otherwise paint over the
            // buttons and make the way out unclickable.
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
                        identity, so the capsule and the focus read as one. */}
                    <span className="relative flex-none w-2.5 h-2.5" aria-hidden="true">
                        <span
                            className={cn(
                                'absolute inset-0 rounded-full bg-indigo-500',
                                phase === 'error' && 'bg-rose-500',
                                COMPUTING.has(phase) && 'nx-trace-origin-pulse',
                            )}
                        />
                    </span>
                    <span className="flex-1 min-w-0">
                        <span className="block font-display text-[12.5px] font-semibold text-ink leading-tight line-clamp-2">
                            {headline}
                        </span>
                        {/* The ticking numbers stay outside the announcement:
                            a polite region that re-reads itself every wave is
                            noise; the phase sentence is the part worth hearing. */}
                        <span aria-hidden="true" className="block mt-0.5 text-[10.5px] text-ink-muted tabular-nums leading-tight">
                            {meta}
                        </span>
                    </span>
                    <span className="flex items-center gap-1.5 flex-none">
                        {phase === 'checkpoint' && (
                            <button type="button" onClick={onContinue} className={primaryAction}>Continue</button>
                        )}
                        {phase === 'error' && (
                            <button type="button" onClick={onRetry} className={quietAction}>Try again</button>
                        )}
                        {phase !== 'done' && onCancel && (
                            <button type="button" onClick={onCancel} className={quietAction}>Cancel</button>
                        )}
                    </span>
                </div>

                {SOUNDS.has(phase) && (
                    <div className="flex items-center gap-2.5" aria-hidden="true">
                        <span className="flex-none w-[4.5rem] text-right text-[10px] font-medium text-cyan-600 dark:text-cyan-400 tabular-nums">
                            {phase === 'loading' ? '' : `↑ ${fmt(upCount)}${floor}`}
                        </span>
                        <span className="nx-trace-sounding">
                            <span className="nx-trace-sounding-up" />
                            <span className="nx-trace-sounding-origin" />
                            <span className="nx-trace-sounding-down" />
                        </span>
                        <span className="flex-none w-[4.5rem] text-[10px] font-medium text-amber-600 dark:text-amber-400 tabular-nums">
                            {phase === 'loading' ? '' : `${fmt(downCount)}${floor} ↓`}
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
}
