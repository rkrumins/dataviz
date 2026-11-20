/**
 * A section's heading on the workspace Overview: a tinted icon chip, a title, an
 * optional one-line subtitle, and an optional action on the right — one
 * treatment, so the page reads as one composed surface rather than a stack of cards.
 */
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SectionTitle({ id, icon: Icon, tone, title, subtitle, action, className }: {
    id?: string
    icon: ComponentType<{ className?: string }>
    /** The chip's colour, e.g. `text-indigo-500 bg-indigo-500/10`. */
    tone: string
    title: string
    subtitle?: string
    action?: ReactNode
    className?: string
}) {
    return (
        <div className={cn('flex items-center justify-between gap-3', className)}>
            <div className="flex items-center gap-2.5 min-w-0">
                <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', tone)}>
                    <Icon className="w-3.5 h-3.5" aria-hidden />
                </span>
                <div className="min-w-0">
                    <h2 id={id} className="text-sm font-bold text-ink leading-tight">{title}</h2>
                    {subtitle && <p className="text-xs text-ink-muted truncate">{subtitle}</p>}
                </div>
            </div>
            {action}
        </div>
    )
}
