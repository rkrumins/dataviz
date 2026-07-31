/**
 * The card every block on the SSO page renders into.
 *
 * The Admin section has one card and four pages use it —
 * `border border-glass-border bg-canvas-elevated rounded-xl p-5`. The
 * previous pass here invented its own (`border-2` with no background),
 * which is why those tabs read as hollow outlines dropped onto the canvas
 * rather than as surfaces sitting on it. One missing background class
 * accounts for most of the flatness.
 *
 * This mirrors `AccountCard` (`components/account/AccountShell.tsx`)
 * rather than importing it. That one is exported from the *account* shell
 * for account pages; an admin surface reaching into it for chrome would
 * couple two areas that should share a look and nothing else. The
 * duplication is four class names — the coupling would be a module.
 *
 * `Chip` is imported from there, because it is already generic and
 * re-deriving it would be the same mistake pointing the other way.
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CardTone = 'neutral' | 'info' | 'warn' | 'danger'

const TONES: Record<CardTone, { wrap: string; tile: string; icon: string }> = {
    neutral: {
        wrap: 'border-glass-border bg-canvas-elevated',
        tile: 'bg-indigo-500/10',
        icon: 'text-indigo-500',
    },
    info: {
        wrap: 'border-indigo-500/20 bg-indigo-500/[0.04]',
        tile: 'bg-indigo-500/10',
        icon: 'text-indigo-500',
    },
    warn: {
        wrap: 'border-amber-500/25 bg-amber-500/[0.05]',
        tile: 'bg-amber-500/10',
        icon: 'text-amber-500',
    },
    danger: {
        wrap: 'border-red-500/25 bg-red-500/[0.04]',
        tile: 'bg-red-500/10',
        icon: 'text-red-500',
    },
}

export function SsoCard({
    icon: Icon, title, blurb, tone = 'neutral', actions, className, children,
}: {
    icon?: LucideIcon
    title?: string
    blurb?: ReactNode
    tone?: CardTone
    /** Card-level action, right of the title. */
    actions?: ReactNode
    className?: string
    children?: ReactNode
}) {
    const t = TONES[tone]
    const hasHeader = Boolean(Icon || title || blurb || actions)

    return (
        <section className={cn('rounded-xl border p-5', t.wrap, className)}>
            {hasHeader && (
                <div className={cn('flex items-start gap-3', children && 'mb-4')}>
                    {Icon && (
                        <div className={cn(
                            'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                            t.tile,
                        )}>
                            <Icon className={cn('w-4 h-4', t.icon)} />
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        {title && (
                            <h2 className="text-sm font-bold text-ink">{title}</h2>
                        )}
                        {blurb && (
                            <div className="text-xs text-ink-muted mt-0.5 leading-relaxed">
                                {blurb}
                            </div>
                        )}
                    </div>
                    {actions && <div className="shrink-0">{actions}</div>}
                </div>
            )}
            {children}
        </section>
    )
}

/**
 * Centred, quiet, one line.
 *
 * Lifted verbatim from `EmptyState`'s own rule — "an empty state is not a
 * place for a paragraph" — which the previous pass broke with a three-line
 * explanation of what would happen if you did nothing.
 */
export function SsoEmpty({
    icon: Icon, children, action,
}: {
    icon: LucideIcon
    children: ReactNode
    action?: ReactNode
}) {
    return (
        <div className="flex flex-col items-center text-center py-10 px-4">
            <div className="w-10 h-10 rounded-full bg-black/[0.04] dark:bg-white/[0.05] flex items-center justify-center mb-3">
                <Icon className="w-4 h-4 text-ink-muted" />
            </div>
            <p className="text-[13px] text-ink-muted max-w-sm">{children}</p>
            {action && <div className="mt-4">{action}</div>}
        </div>
    )
}

/** Section label above a group of cards in the main column. */
export function SsoSectionLabel({
    icon: Icon, children, hint,
}: {
    icon?: LucideIcon
    children: ReactNode
    hint?: ReactNode
}) {
    return (
        <div className="flex items-baseline gap-2 mb-3">
            {Icon && <Icon className="w-4 h-4 text-ink-muted self-center" />}
            <h3 className="text-sm font-bold text-ink">{children}</h3>
            {hint && <span className="text-[11px] text-ink-muted">{hint}</span>}
        </div>
    )
}
