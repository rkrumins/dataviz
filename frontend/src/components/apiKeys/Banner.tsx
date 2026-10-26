/**
 * Something that holds for every key on a page of keys — yours, or a service
 * account's: the deployment has keys switched off, this sign-in cannot
 * confirm a new one, the keys could not be loaded.
 */
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

const BANNER_TONE = {
    danger: { box: 'border-rose-500/25 bg-rose-500/[0.06]', icon: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', title: 'text-rose-700 dark:text-rose-300' },
    warn: { box: 'border-amber-500/30 bg-amber-500/[0.07]', icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', title: 'text-amber-800 dark:text-amber-200' },
}

/** Something about the deployment, or this page, that holds for every key —
 *  with what to do about it, when there is something (`action`). */
export function Banner({ tone, icon: Icon, title, children, action }: {
    tone: keyof typeof BANNER_TONE
    icon: LucideIcon
    title: string
    children: React.ReactNode
    action?: React.ReactNode
}) {
    const t = BANNER_TONE[tone]
    return (
        <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-3 p-4 rounded-2xl border', t.box)}>
            <span className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', t.icon)}>
                <Icon className="w-[18px] h-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', t.title)}>{title}</p>
                <p className="mt-0.5 text-xs text-ink-secondary leading-relaxed">{children}</p>
            </div>
            {action && <div className="shrink-0 self-center">{action}</div>}
        </div>
    )
}
