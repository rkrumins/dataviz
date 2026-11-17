/**
 * The "what does this actually mean?" affordance.
 *
 * Built rather than borrowed: the app has no generic tooltip primitive, and the
 * two candidates were both wrong for this. A `title` attribute cannot hold
 * three paragraphs, is untouchable on a phone, and is invisible to anyone
 * scanning for help. A modal is far too heavy for a definition.
 *
 * Without `children` the trigger is the ⓘ beside a label. With them, the
 * children ARE the trigger — a status badge, a defined word — named by their
 * own words, so a badge explains itself on a phone and by keyboard, not only
 * under a mouse.
 *
 * Four deliberate choices:
 *
 *   * **Click, not hover.** Hover cards at this density strobe as the pointer
 *     crosses a KPI row, and hover does not exist on touch at all. A definition
 *     is something you go and get, not something that ambushes you. A tap, a
 *     click, Enter or Space opens it; it is a small dialog that takes focus, so
 *     a screen reader reads it, and Esc or Tab hands focus back to its trigger.
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
 *   * **Inside an open dialog, portaled into the dialog.** A modal drawer makes
 *     everything outside it inert and takes a press there for a press outside:
 *     a definition on the body could be neither read nor clicked, and a click
 *     on it would close the drawer under it. An inert, zero-size frame at the
 *     window's corner places it, because a dialog with a transform (a drawer
 *     sliding in) or a filter moves where `fixed` starts, and the frame lands
 *     wherever that is.
 *   * **Escape and outside-click both close it**, because a thing that opens
 *     must be dismissable by the two gestures everyone already tries. Esc is
 *     heard on the window, before the drawer or dialog around it hears it, so
 *     it closes the definition and nothing else.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'
import { METRICS, type MetricDefinition } from './metricDefinitions'

/** Panel width, in px. Shared by the layout and the clamp so they cannot
 *  disagree about how much room to leave. */
const PANEL_WIDTH = 288
const GUTTER = 12
/** A real edge in both themes: `glass-border` is white glass, invisible on a light panel. */
const EDGE = 'border-black/[0.08] dark:border-white/[0.10]'

function Section({ heading, children }: { heading: string; children: ReactNode }) {
    return (
        <span className={cn('mt-2.5 block border-t pt-2.5', EDGE)}>
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">
                {heading}
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">
                {children}
            </span>
        </span>
    )
}

export function MetricInfo({
    metric, definition, caveat, className, children,
}: {
    /** Key into `METRICS`. Ignored when `definition` is passed. */
    metric?: keyof typeof METRICS
    /** An inline definition, for one-off numbers not worth a shared entry. */
    definition?: MetricDefinition
    /** A caveat known only from the data, in place of the definition's. */
    caveat?: string
    className?: string
    /** The trigger in place of the ⓘ: a badge or a word, named by its own text. */
    children?: ReactNode
}) {
    // Where the open definition is portaled: the dialog around its trigger, else the body.
    const [host, setHost] = useState<Element | null>(null)
    const open = host !== null
    const [at, setAt] = useState<{ top: number; left: number } | null>(null)
    const wrapRef = useRef<HTMLSpanElement>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const frameRef = useRef<HTMLSpanElement>(null)
    const panelRef = useRef<HTMLSpanElement>(null)
    const panelId = useId()
    const titleId = useId()
    const def = definition ?? (metric ? METRICS[metric] : undefined)

    const close = useCallback((refocus: boolean) => {
        setHost(null)
        setAt(null)
        if (refocus) btnRef.current?.focus()
    }, [])

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
        // With room on neither side (a long one on a phone), it rises until it
        // fits, over its trigger if it must.
        const below = window.innerHeight - r.bottom
        const height = panelRef.current?.offsetHeight ?? 0
        const top = height && below < height + GUTTER * 2 && r.top > height
            ? r.top - height - 8
            : Math.min(r.bottom + 8, window.innerHeight - height - GUTTER)
        // Window coordinates, counted from wherever `fixed` starts in the host.
        const frame = frameRef.current?.getBoundingClientRect()
        setAt({ top: top - (frame?.top ?? 0), left: left - (frame?.left ?? 0) })
    }, [])

    useLayoutEffect(() => {
        if (open) place()
    }, [open, place])

    // Focus moves in once it is placed: hidden while it is measured, it could
    // not take focus before.
    const placed = at !== null
    useEffect(() => {
        if (placed) panelRef.current?.focus({ preventScroll: true })
    }, [placed])

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
        // The window's capture phase runs before the document's, where a Radix
        // drawer or dialog listens for Esc: stopped here, it never hears it.
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            close(true)
        }
        const onDown = (e: MouseEvent) => {
            const node = e.target as Node
            const inAnchor = wrapRef.current?.contains(node)
            // The panel is portaled, so it is NOT inside the anchor any more —
            // without this, clicking the definition closes it.
            const inPanel = panelRef.current?.contains(node)
            if (!inAnchor && !inPanel) close(false)
        }
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('mousedown', onDown)
        return () => {
            window.removeEventListener('keydown', onKey, true)
            document.removeEventListener('mousedown', onDown)
        }
    }, [open, close])

    // A metric with no definition renders nothing rather than an empty popover.
    // Better a missing affordance than one that opens and says nothing.
    if (!def) return null

    return (
        <span ref={wrapRef} className={cn('relative inline-flex', className)}>
            <button
                ref={btnRef}
                type="button"
                onClick={(e) => {
                    e.stopPropagation()
                    if (open) close(false)
                    else setHost(e.currentTarget.closest('[role="dialog"]') ?? document.body)
                }}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-controls={open ? panelId : undefined}
                aria-label={children ? undefined : `What does "${def.title}" mean?`}
                className={children
                    // Ringed while open, so it is plain which badge or word is being explained.
                    ? 'inline-flex max-w-full cursor-help items-center rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 aria-expanded:ring-2 aria-expanded:ring-indigo-500/40'
                    : cn(
                        'inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-secondary transition-colors outline-none',
                        'hover:text-ink hover:bg-black/5 dark:hover:bg-white/10',
                        'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                        open && 'text-indigo-500 bg-indigo-500/10',
                    )}
            >
                {children ?? <Info className="h-3 w-3" />}
            </button>

            {host && createPortal((
                <span ref={frameRef} className="pointer-events-none fixed left-0 top-0 z-50 block">
                    <span
                        ref={panelRef}
                        id={panelId}
                        role="dialog"
                        aria-labelledby={titleId}
                        tabIndex={-1}
                        // Stops a click inside the definition from triggering the
                        // KPI tile it sits on, which would navigate away mid-read.
                        onClick={(e) => e.stopPropagation()}
                        // Nothing in it takes focus, so Tab hands it back.
                        onKeyDown={(e) => {
                            if (e.key !== 'Tab') return
                            e.preventDefault()
                            close(true)
                        }}
                        style={{
                            top: at?.top ?? -9999,
                            left: at?.left ?? -9999,
                            width: PANEL_WIDTH,
                            // Measured before it is placed: rendering it off-screen
                            // for one frame lets `place` read a real height and
                            // decide whether to flip above.
                            visibility: at ? 'visible' : 'hidden',
                        }}
                        className={cn(
                            'pointer-events-auto absolute block cursor-default rounded-xl border bg-canvas-elevated p-3.5 text-left shadow-xl outline-none',
                            'animate-in fade-in zoom-in-95 duration-150',
                            EDGE,
                        )}
                    >
                        <span id={titleId} className="block text-[11px] font-bold text-ink">
                            {def.title}
                        </span>
                        <span className="mt-1.5 block text-[11px] leading-relaxed text-ink-secondary">
                            {def.what}
                        </span>

                        {def.how && <Section heading="How it's calculated">{def.how}</Section>}
                        {def.why && <Section heading="Why it matters">{def.why}</Section>}
                        {def.technical && <Section heading="Technical">{def.technical}</Section>}

                        {(caveat ?? def.caveat) && (
                            <span className="mt-2.5 block rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
                                {caveat ?? def.caveat}
                            </span>
                        )}
                    </span>
                </span>
            ), host)}
        </span>
    )
}
