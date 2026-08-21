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
 *   * **Rendered in place, not portaled.** The popover is small and its anchor
 *     never scrolls independently, so a portal would buy nothing and cost the
 *     class of bug this codebase has already been bitten by three times — an
 *     interrupted exit animation stranding an invisible click-blocker over the
 *     app (see the note in `SidebarNav`).
 *   * **Escape and outside-click both close it**, because a thing that opens
 *     must be dismissable by the two gestures everyone already tries.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'

import { cn } from '@/lib/utils'
import { METRICS, type MetricDefinition } from './metricDefinitions'

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
    const wrapRef = useRef<HTMLSpanElement>(null)
    const panelId = useId()
    const def = definition ?? (metric ? METRICS[metric] : undefined)

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
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

            {open && (
                <span
                    id={panelId}
                    role="tooltip"
                    // Stops a click inside the definition from triggering the
                    // KPI tile it sits on, which would navigate away mid-read.
                    onClick={(e) => e.stopPropagation()}
                    className="absolute left-1/2 top-full z-40 mt-2 w-72 -translate-x-1/2 cursor-default rounded-xl border border-glass-border bg-canvas-elevated p-3.5 text-left shadow-xl animate-in fade-in zoom-in-95 duration-150"
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
            )}
        </span>
    )
}
