/**
 * StatusBadge — whether the value chosen is the value in force, and if not, why in one word:
 * Adjusted, Inactive, Not used, Locked, Exception, Deployment value ignored. Icon and words, never
 * colour alone; the hint says what the status means, on hover and read with the badge (it is not a
 * tab stop: there is nothing to do on it).
 */
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import { STATUS_META } from './meta'
import type { Status } from './types'

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
    const meta = STATUS_META[status]
    const Icon = meta.icon
    if (status === 'in_effect') {
        // The quiet default: a dot and the words, no fill.
        return (
            <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary', className)}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {meta.label}
            </span>
        )
    }
    return (
        <HoverTip label={meta.hint} className="inline-flex">
            <Badge tone={meta.tone} size="md" className={className}>
                <Icon className="w-3 h-3" aria-hidden />
                <span>{meta.label}</span>
                <span className="sr-only">: {meta.hint}</span>
            </Badge>
        </HoverTip>
    )
}
