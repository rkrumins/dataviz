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
 *
 * `label` is a NODE, not a string. A tooltip on a bare glyph is often the only
 * place a number gets explained, and one line of grey prose wastes that: the
 * chrome here is the app's popover language — layered panel, real shadow, a
 * caret that points at what it describes — so a caller can put a figure, a
 * caption and a footnote in it and have it read as part of the product rather
 * than as a browser artefact.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

const SHOW_DELAY_MS = 120
const GAP = 8
const EDGE = 8
const MAX_WIDTH = 280
/** Keeps the caret inside the panel's rounded corners. */
const CARET_INSET = 16

export function HoverTip({ label, children, className }: {
    /** What to show. Written to stand alone: nothing else is on screen to
     *  complete it. A plain string is fine; richer callers pass a node. */
    label: React.ReactNode
    children: React.ReactNode
    className?: string
}) {
    // `x` is where the panel is centred AFTER clamping to the viewport;
    // `anchorX` is where the trigger actually is. They differ near a screen
    // edge, and the caret has to follow the second or it points at nothing.
    const [at, setAt] = useState<
        { x: number; anchorX: number; y: number; above: boolean } | null
    >(null)
    const anchorRef = useRef<HTMLSpanElement>(null)
    const timer = useRef<number | undefined>(undefined)
    const tipId = useId()

    const place = useCallback(() => {
        const el = anchorRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        // Above by default; below when the top of the window is in the way.
        const above = r.top > 120
        const anchorX = r.left + r.width / 2
        setAt({
            x: Math.min(
                Math.max(anchorX, EDGE + MAX_WIDTH / 2),
                window.innerWidth - EDGE - MAX_WIDTH / 2,
            ),
            anchorX,
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
                        'z-[60] block pointer-events-none rounded-xl',
                        // Two borders and a real shadow, matching the app's
                        // other popovers. A single hairline on a flat fill is
                        // what made this read as browser chrome.
                        'border border-glass-border ring-1 ring-black/[0.03] dark:ring-white/[0.04]',
                        'bg-canvas-elevated px-3 py-2.5 shadow-xl',
                        'animate-in fade-in duration-100',
                        at.above ? 'slide-in-from-bottom-1' : 'slide-in-from-top-1',
                    )}
                >
                    {label}
                    {/* The caret tracks the TRIGGER, not the panel, so a tip
                        pushed sideways by a screen edge still points at the
                        thing it belongs to. */}
                    <span
                        aria-hidden
                        style={{
                            left: `calc(50% + ${Math.max(
                                -(MAX_WIDTH / 2 - CARET_INSET),
                                Math.min(MAX_WIDTH / 2 - CARET_INSET, at.anchorX - at.x),
                            )}px)`,
                            [at.above ? 'bottom' : 'top']: -4,
                        }}
                        className={cn(
                            'absolute h-2 w-2 -translate-x-1/2 rotate-45',
                            'border-glass-border bg-canvas-elevated',
                            at.above ? 'border-b border-r' : 'border-l border-t',
                        )}
                    />
                </span>,
                document.body,
            )}
        </>
    )
}
