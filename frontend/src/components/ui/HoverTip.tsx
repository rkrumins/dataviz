/**
 * HoverTip — the app's ONE tooltip. There is deliberately no second one.
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
 * ── What this component owns, now that every control in the header uses it ──
 *
 * TYPOGRAPHY IS SET HERE, NOT INHERITED. The panel used to declare no size,
 * weight or colour at all, so a tip rendered in whatever the document body
 * happened to give it and a rich caller's own classes did the rest. Two
 * neighbouring tips could therefore disagree about how big their words were;
 * that is a large part of what "the text is all over the place" means. One
 * size, one line-height, one colour for the LEAD, one quieter pair for the
 * DETAIL. Figures are tabular so a column of numbers in a tip lines up.
 *
 * TWO WIDTHS, NEVER MORE. A control tip is a sentence about a button and gets
 * the narrow box; a data tip carries a figure, a caption and a footnote and
 * gets the wide one. Chosen automatically — a plain string is a control tip, a
 * node is a data tip — and overridable with `width` for the rare caller that
 * knows better. Neighbouring tips that wrap to wildly different shapes are the
 * other half of the same complaint.
 *
 * A REAL EDGE. The border was `glass-border`, which in light mode is
 * rgba(255,255,255,.4) — white, on a white panel. In practice the bubble had
 * no outline at all in the light theme and leant entirely on its shadow. It
 * now carries a real neutral, and a two-layer shadow (a tight contact shadow
 * under a soft ambient one) so it reads as the same material as the app's
 * other popovers in both themes.
 *
 * MOTION: a ~120ms rise-and-fade FROM THE DIRECTION IT POINTS — it grows out
 * of its trigger rather than appearing on top of it. Entrance only: a portaled
 * node with an exit animation is how this app strands invisible click-blockers
 * (see `radixPointerEventsGuard`), and a tooltip is never worth that risk.
 * Reduced motion needs no code here: `globals.css` disables `.animate-in`
 * under both `prefers-reduced-motion` and the app's own `.reduce-motion` class,
 * so honouring the preference is a consequence of using the shared utility.
 *
 * `label` is a NODE, not a string. A tooltip on a bare glyph is often the only
 * place a number gets explained, and one line of grey prose wastes that: the
 * chrome here is the app's popover language — layered panel, real shadow, a
 * caret that points at what it describes — so a caller can put a figure, a
 * caption and a footnote in it and have it read as part of the product rather
 * than as a browser artefact.
 *
 * ── The copy rule, stated where the next caller will meet it ──
 *
 * Say what the control DOES, in active voice, one sentence, sentence case, no
 * trailing full stop on a fragment. Add what only the tooltip can add — who it
 * reaches, what happens next, why it is disabled. A tip that restates its own
 * visible label is worse than no tip: it teaches people that hovering is not
 * worth doing, and that is what makes the rest of them feel unreliable.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

const SHOW_DELAY_MS = 120
const GAP = 8
const EDGE = 8
/** Keeps the caret inside the panel's rounded corners. */
const CARET_INSET = 16

/** Two widths, one system. `control` is a sentence about a button; `data` is a
 *  figure with its caption and footnote. Nothing else is offered on purpose. */
const WIDTH = { control: 248, data: 320 } as const
export type HoverTipWidth = keyof typeof WIDTH

export function HoverTip({ label, detail, shortcut, width, children, className }: {
    /** The lead. Written to stand alone: nothing else is on screen to complete
     *  it. A plain string is fine; richer callers pass a node. */
    label: React.ReactNode
    /** A quieter second line — the consequence, the caveat, or the reason a
     *  control is disabled. Keep the lead to the action and put the rest here
     *  rather than growing one sentence into a paragraph. */
    detail?: React.ReactNode
    /** The control's keyboard shortcut, shown as a chip. Glyphs, not words —
     *  `⌘Z`, not "Cmd+Z". */
    shortcut?: string
    /** Overrides the automatic choice (string → control, node → data). */
    width?: HoverTipWidth
    children: React.ReactNode
    className?: string
}) {
    const variant: HoverTipWidth = width ?? (typeof label === 'string' ? 'control' : 'data')
    const maxWidth = WIDTH[variant]

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
                Math.max(anchorX, EDGE + maxWidth / 2),
                window.innerWidth - EDGE - maxWidth / 2,
            ),
            anchorX,
            y: above ? r.top - GAP : r.bottom + GAP,
            above,
        })
    }, [maxWidth])

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

    const lead = (
        <span className="block min-w-0 flex-1 text-[12px] font-medium leading-[1.45] text-ink">
            {label}
        </span>
    )

    return (
        <>
            <span
                ref={anchorRef}
                className={cn(
                    // A DISABLED CONTROL DISPATCHES NO MOUSE EVENTS, and they
                    // do not reach this wrapper either — so the tips that
                    // matter most (why is this greyed out?) would be the only
                    // ones that never appeared. Letting the pointer fall
                    // through to the wrapper is the standard fix; `:has` keeps
                    // the not-allowed cursor the control was drawing itself.
                    '[&_:disabled]:pointer-events-none [&:has(:disabled)]:cursor-not-allowed',
                    className,
                )}
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
                    data-tip-width={variant}
                    style={{
                        position: 'fixed',
                        left: at.x,
                        top: at.y,
                        maxWidth,
                        transform: at.above
                            ? 'translate(-50%, -100%)'
                            : 'translate(-50%, 0)',
                    }}
                    className={cn(
                        'z-[60] block pointer-events-none rounded-xl tabular-nums',
                        // A REAL neutral edge. `glass-border` is
                        // rgba(255,255,255,.4) in light mode — a white outline
                        // on a white panel, i.e. no outline at all.
                        'border border-black/[0.08] dark:border-white/[0.10]',
                        'bg-canvas-elevated px-3 py-2',
                        // Contact shadow + ambient shadow. One `shadow-xl` on
                        // its own floats; the tight pair sits.
                        'shadow-[0_1px_2px_rgba(15,23,42,0.10),0_10px_30px_-10px_rgba(15,23,42,0.35)]',
                        'dark:shadow-[0_1px_2px_rgba(0,0,0,0.60),0_14px_36px_-12px_rgba(0,0,0,0.85)]',
                        'animate-in fade-in-0 zoom-in-95 duration-[120ms] ease-out',
                        at.above ? 'slide-in-from-bottom-1' : 'slide-in-from-top-1',
                    )}
                >
                    {shortcut ? (
                        <span className="flex items-start gap-2.5">
                            {lead}
                            <kbd className="mt-px shrink-0 rounded-md border border-black/10 bg-black/[0.04] px-1.5 py-px font-sans text-[10px] font-semibold leading-[1.4] text-ink-secondary dark:border-white/[0.14] dark:bg-white/[0.06]">
                                {shortcut}
                            </kbd>
                        </span>
                    ) : lead}

                    {detail && (
                        <span className="mt-1 block text-[11px] leading-snug text-ink-muted">
                            {detail}
                        </span>
                    )}

                    {/* The caret tracks the TRIGGER, not the panel, so a tip
                        pushed sideways by a screen edge still points at the
                        thing it belongs to. */}
                    <span
                        aria-hidden
                        style={{
                            left: `calc(50% + ${Math.max(
                                -(maxWidth / 2 - CARET_INSET),
                                Math.min(maxWidth / 2 - CARET_INSET, at.anchorX - at.x),
                            )}px)`,
                            [at.above ? 'bottom' : 'top']: -4,
                        }}
                        className={cn(
                            'absolute h-2 w-2 -translate-x-1/2 rotate-45',
                            'border-black/[0.08] bg-canvas-elevated dark:border-white/[0.10]',
                            at.above ? 'border-b border-r' : 'border-l border-t',
                        )}
                    />
                </span>,
                document.body,
            )}
        </>
    )
}
