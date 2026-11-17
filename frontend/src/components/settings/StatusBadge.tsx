/**
 * StatusBadge — whether the value chosen is the value in force, and if not, why in one word:
 * Adjusted, Inactive, Not used, Locked, Exception, Deployment value ignored. Icon and words, never
 * colour alone; a tap, a click or Enter opens what the status means (`MetricInfo`), so it reads on a
 * phone and by keyboard as well as under a mouse.
 */
import { MetricInfo } from '@/components/analytics/MetricInfo'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
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
        <MetricInfo definition={{ title: meta.label, what: meta.hint }} className={className}>
            <Badge tone={meta.tone} size="md">
                <Icon className="w-3 h-3" aria-hidden />
                <span>{meta.label}</span>
            </Badge>
        </MetricInfo>
    )
}
