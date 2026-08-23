/**
 * The "what does this actually mean?" affordance.
 *
 * Built rather than borrowed: the app has no generic tooltip primitive, and the
 * two candidates were both wrong for this. A `title` attribute cannot hold
 * three paragraphs, is untouchable on a phone, and is invisible to anyone
 * scanning for help. A modal is far too heavy for a definition.
 *
 * Three deliberate choices:
 *
 *   * **Click, not hover.** Hover cards at this density strobe as the pointer
 *     crosses a KPI row, and hover does not exist on touch at all. A definition
 *     is something you go and get, not something that ambushes you.
 *   * **Portaled to the body.** This started life rendered in place, on the
 *     reasoning that the popover is small and its anchor never scrolls
 *     independently, so a portal "would buy nothing". That was wrong, and
 *     visibly so: every anchor is inside a `KpiCard`, which sets
 *     `overflow-hidden` for its rounded corners — so the definition was
 *     clipped to the tile and nobody could read one. In-place positioning
 *     fails exactly when an ancestor clips, which here is always.
 *
 *     The usual objection to portals does not apply: there is no exit
 *     animation and no backdrop, so there is nothing to strand over the app if
 *     an unmount interrupts one (the bug the note in `SidebarNav` describes).
 *   * **Escape and outside-click both close it**, because a thing that opens
 *     must be dismissable by the two gestures everyone already tries.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'
import { METRICS, type MetricDefinition } from './metricDefinitions'

/** Panel width, in px. Shared by the layout and the clamp so they cannot
 *  disagree about how much room to leave. */
const PANEL_WIDTH = 288
const GUTTER = 12

export function MetricInfo({
    metric, definition, className,
}: {
    /** Key into `METRICS`. Ignored when `definition` is passed. */
    metric?: keyof typeof METRICS
    /** An inline definition, for one-off numbers not worth a shared entry. */
    definition?: MetricDefinition
    className?: string
}) {
    const [open, setOpen] = useState(false)
    const [at, setAt] = useState<{ top: number; left: number } | null>(null)
    const wrapRef = useRef<HTMLSpanElement>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLSpanElement>(null)
    const panelId = useId()
    const def = definition ?? (metric ? METRICS[metric] : undefined)

    /** Anchor the portaled panel under the button, clamped to the viewport so a
     *  tile at the right-hand edge does not push it off-screen. */
    const place = useCallback(() => {
        const btn = btnRef.current
        if (!btn) return
        const r = btn.getBoundingClientRect()
        const w = PANEL_WIDTH
        const left = Math.min(
            Math.max(GUTTER, r.left + r.width / 2 - w / 2),
            window.innerWidth - w - GUTTER,
        )
        // Flip above when there is not room below — a definition that opens
        // off the bottom of the window is the same bug in a new direction.
        const below = window.innerHeight - r.bottom
        const height = panelRef.current?.offsetHeight ?? 0
        const top = height && below < height + GUTTER * 2 && r.top > height
            ? r.top - height - 8
            : r.bottom + 8
        setAt({ top, left })
    }, [])

    useLayoutEffect(() => {
        if (!open) { setAt(null); return }
        place()
    }, [open, place])

    useEffect(() => {
        if (!open) return
        // Fixed coordinates go stale the moment anything moves, so follow both.
        // `capture` catches scrolls on inner containers, not just the window.
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        return () => {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
        }
    }, [open, place])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        const onDown = (e: MouseEvent) => {
            const node = e.target as Node
            const inAnchor = wrapRef.current?.contains(node)
            // The panel is portaled, so it is NOT inside the anchor any more —
            // without this, clicking the definition closes it.
            const inPanel = panelRef.current?.contains(node)
            if (!inAnchor && !inPanel) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onDown)
        }
    }, [open])

    // A metric with no definition renders nothing rather than an empty popover.
    // Better a missing affordance than one that opens and says nothing.
    if (!def) return null

    return (
        <span ref={wrapRef} className={cn('relative inline-flex', className)}>
            <button
                ref={btnRef}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-label={`What does "${def.title}" mean?`}
                className={cn(
                    'inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-muted/60 transition-colors outline-none',
                    'hover:text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10',
                    'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    open && 'text-indigo-500 bg-indigo-500/10',
                )}
            >
                <Info className="h-3 w-3" />
            </button>

            {open && createPortal((
                <span
                    ref={panelRef}
                    id={panelId}
                    role="tooltip"
                    // Stops a click inside the definition from triggering the
                    // KPI tile it sits on, which would navigate away mid-read.
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        position: 'fixed',
                        top: at?.top ?? -9999,
                        left: at?.left ?? -9999,
                        width: PANEL_WIDTH,
                        // Measured before it is placed: rendering it off-screen
                        // for one frame lets `place` read a real height and
                        // decide whether to flip above.
                        visibility: at ? 'visible' : 'hidden',
                    }}
                    className="z-50 cursor-default rounded-xl border border-glass-border bg-canvas-elevated p-3.5 text-left shadow-xl animate-in fade-in zoom-in-95 duration-150"
                >
                    <span className="block text-[11px] font-bold text-ink">
                        {def.title}
                    </span>
                    <span className="mt-1.5 block text-[11px] leading-relaxed text-ink-secondary">
                        {def.what}
                    </span>

                    <span className="mt-2.5 block border-t border-glass-border pt-2.5">
                        <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                            How it's calculated
                        </span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">
                            {def.how}
                        </span>
                    </span>

                    {def.why && (
                        <span className="mt-2.5 block border-t border-glass-border pt-2.5">
                            <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                                Why it matters
                            </span>
                            <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">
                                {def.why}
                            </span>
                        </span>
                    )}

                    {def.caveat && (
                        <span className="mt-2.5 block rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
                            {def.caveat}
                        </span>
                    )}
                </span>
            ), document.body)}
        </span>
    )
}
