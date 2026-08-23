/**
 * HoverTip — a real tooltip for a small target.
 *
 * The `title` attribute was doing this job and doing it badly: the browser
 * waits about a second before showing anything, renders it in OS chrome that
 * matches nothing else on the page, and places it wherever it likes. On a row
 * of three tiny glyphs that reads as "hovering does nothing" — which is what
 * it was reported as.
 *
 * PORTALED TO THE BODY, positioned with `fixed` and runtime coordinates. The
 * same reason `PermissionTooltip` does it: the cards these sit in are
 * `overflow-hidden` with their own stacking contexts, so an absolutely
 * positioned bubble is clipped by its own card. A portal sidesteps the whole
 * containment problem rather than fighting it per-container.
 *
 * A SHORT DELAY ON HOVER, none on focus. Sweeping a mouse across a footer of
 * icons should not flash three bubbles; a keyboard user who has deliberately
 * tabbed to something wants it immediately.
 *
 * The bubble is `pointer-events-none` so it can never sit between the cursor
 * and the thing it describes — a tooltip that swallows the click on its own
 * trigger is worse than no tooltip.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

const SHOW_DELAY_MS = 120
const GAP = 8
const EDGE = 8
const MAX_WIDTH = 260

export function HoverTip({ label, children, className }: {
    /** The sentence. Written to stand alone: nothing else is on screen to
     *  complete it. */
    label: string
    children: React.ReactNode
    className?: string
}) {
    const [at, setAt] = useState<{ x: number; y: number; above: boolean } | null>(null)
    const anchorRef = useRef<HTMLSpanElement>(null)
    const timer = useRef<number | undefined>(undefined)
    const tipId = useId()

    const place = useCallback(() => {
        const el = anchorRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        // Above by default; below when the top of the window is in the way.
        const above = r.top > 56
        setAt({
            x: Math.min(
                Math.max(r.left + r.width / 2, EDGE + MAX_WIDTH / 2),
                window.innerWidth - EDGE - MAX_WIDTH / 2,
            ),
            y: above ? r.top - GAP : r.bottom + GAP,
            above,
        })
    }, [])

    const open = useCallback((delay: number) => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(place, delay)
    }, [place])

    const close = useCallback(() => {
        window.clearTimeout(timer.current)
        setAt(null)
    }, [])

    // Scrolling or resizing while open would leave the bubble behind, pointing
    // at nothing. Capture, because the scroll may happen in any ancestor.
    useEffect(() => {
        if (!at) return
        window.addEventListener('scroll', close, true)
        window.addEventListener('resize', close)
        return () => {
            window.removeEventListener('scroll', close, true)
            window.removeEventListener('resize', close)
        }
    }, [at, close])

    useEffect(() => () => window.clearTimeout(timer.current), [])

    return (
        <>
            <span
                ref={anchorRef}
                className={className}
                aria-describedby={at ? tipId : undefined}
                onMouseEnter={() => open(SHOW_DELAY_MS)}
                onMouseLeave={close}
                onFocus={() => open(0)}
                onBlur={close}
            >
                {children}
            </span>

            {at && createPortal(
                <span
                    id={tipId}
                    role="tooltip"
                    style={{
                        position: 'fixed',
                        left: at.x,
                        top: at.y,
                        maxWidth: MAX_WIDTH,
                        transform: at.above
                            ? 'translate(-50%, -100%)'
                            : 'translate(-50%, 0)',
                    }}
                    className={cn(
                        'z-[60] pointer-events-none rounded-lg border border-glass-border',
                        'bg-canvas-elevated px-2.5 py-1.5 text-[11px] font-medium leading-snug',
                        'text-ink shadow-lg animate-in fade-in duration-100',
                    )}
                >
                    {label}
                </span>,
                document.body,
            )}
        </>
    )
}
