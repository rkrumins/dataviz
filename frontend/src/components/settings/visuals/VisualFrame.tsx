/**
 * VisualFrame — the figure every explainer sits in: a title that names it, the picture, and a
 * caption in words that says what the picture shows (its text alternative, always visible, so the
 * picture never gates a value). Legends sit beside the title, and so does a badge that says what
 * kind of picture it is ("Example"), outside its name.
 */
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function VisualFrame({ eyebrow = 'See how it works', title, badge, legend, caption, children, className }: {
    eyebrow?: string
    title: string
    badge?: ReactNode
    legend?: ReactNode
    /** What the picture shows, in a sentence or two. */
    caption: ReactNode
    children: ReactNode
    className?: string
}) {
    const id = useId()
    return (
        <figure
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-caption`}
            className={cn('rounded-2xl border border-glass-border/50 bg-black/[0.015] p-4 sm:p-5 dark:bg-white/[0.02]', className)}
        >
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{eyebrow}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p id={`${id}-title`} className="text-[13px] font-semibold text-ink">{title}</p>
                        {badge}
                    </div>
                </div>
                {legend && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-secondary">{legend}</div>}
            </div>
            <div className="mt-4">{children}</div>
            <figcaption id={`${id}-caption`} aria-live="polite" className="mt-4 text-xs leading-relaxed text-ink-secondary">
                {caption}
            </figcaption>
        </figure>
    )
}

/** A legend entry: a line key (for lines and outlines) or a swatch (for fills). */
export function LegendKey({ kind = 'swatch', className, children }: { kind?: 'swatch' | 'line' | 'dashed'; className: string; children: ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {kind === 'swatch'
                ? <span aria-hidden className={cn('h-2.5 w-2.5 rounded-[3px]', className)} />
                : <span aria-hidden className={cn('w-4 border-t-2', kind === 'dashed' && 'border-dashed', className)} />}
            {children}
        </span>
    )
}
