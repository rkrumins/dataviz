/**
 * Card — the surface a group of related things sits on, and its header.
 *
 * One edge (a real divider in both themes), one radius, one shadow, generous padding. `accent` is
 * for the one card on a page that holds the reader's own change; nothing else is tinted.
 */
import type { ComponentType, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Icon = ComponentType<{ className?: string }>

const PADDING = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6 sm:p-7' } as const

export interface CardProps extends HTMLAttributes<HTMLElement> {
    as?: 'section' | 'div' | 'article' | 'li'
    padding?: keyof typeof PADDING
    tone?: 'default' | 'accent' | 'muted'
}

export function Card({ as: Tag = 'section', padding = 'md', tone = 'default', className, ...rest }: CardProps) {
    return (
        <Tag
            className={cn(
                'rounded-2xl border shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none',
                tone === 'accent' ? 'border-accent-lineage/30 bg-accent-lineage/[0.03]'
                    : tone === 'muted' ? 'border-glass-border/50 bg-black/[0.02] dark:bg-white/[0.02]'
                        : 'border-glass-border/50 bg-canvas-elevated',
                PADDING[padding],
                className,
            )}
            {...rest}
        />
    )
}

export function CardHeader({ icon: Glyph, eyebrow, title, description, actions, titleAs: Title = 'h3', titleId, className }: {
    icon?: Icon
    /** A short uppercase line above the title: the category, the scope. */
    eyebrow?: ReactNode
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    titleAs?: 'h2' | 'h3' | 'h4'
    titleId?: string
    className?: string
}) {
    return (
        <div className={cn('flex flex-wrap items-start gap-x-4 gap-y-3', className)}>
            {Glyph && (
                <span className="grid place-items-center w-10 h-10 rounded-xl bg-accent-lineage/10 text-accent-lineage shrink-0">
                    <Glyph className="w-5 h-5" aria-hidden />
                </span>
            )}
            <div className="min-w-0 flex-1">
                {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{eyebrow}</p>}
                <Title id={titleId} className={cn('text-[15px] font-semibold tracking-tight text-ink', eyebrow && 'mt-0.5')}>{title}</Title>
                {description && <p className="mt-1 text-xs leading-relaxed text-ink-muted max-w-prose">{description}</p>}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    )
}
