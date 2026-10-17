/**
 * How a key has been used: 30 days of requests by day, and what they were —
 * how many changed something, how many the key itself was refused, and how
 * many failed for other reasons. Refusals are the number to watch: a script
 * calling with the wrong key, or a key asked to do more than it may.
 */
import { Activity, Ban, PenLine, TriangleAlert } from 'lucide-react'

import { BarSeriesChart } from '@/components/analytics/charts/BarSeriesChart'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import type { UsageDay } from '@/services/apiKeyService'

export function UsagePanel({ days }: { days: UsageDay[] }) {
    const total = (k: keyof Omit<UsageDay, 'day'>) => days.reduce((n, d) => n + d[k], 0)
    const requests = total('requests')
    const writes = total('writes')
    const refused = total('refused')
    const errors = total('errors')

    if (requests === 0) {
        return (
            <EmptyState
                icon={Activity}
                title="No calls in the last 30 days"
                description="Calls made with this key show here by day — what they changed, and what was refused."
            />
        )
    }
    const share = Math.round((writes / requests) * 100)
    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2.5">
                <Stat icon={Activity} label="Requests" value={requests.toLocaleString()} sub="last 30 days" />
                <Stat icon={PenLine} label="Writes" value={`${share}%`} sub={`${writes.toLocaleString()} changed something`} />
                <Stat icon={Ban} label="Refused" value={refused.toLocaleString()} sub="by the key’s limits" tone={refused > 0 ? 'warn' : undefined} />
                <Stat icon={TriangleAlert} label="Errors" value={errors.toLocaleString()} sub="other failures" tone={errors > 0 ? 'warn' : undefined} />
            </div>
            <div className="rounded-xl border border-black/[0.07] dark:border-white/[0.08] p-3 pt-4">
                <p className="text-xs font-semibold text-ink mb-1 px-1">Requests per day</p>
                <BarSeriesChart
                    buckets={days.map((d) => d.day)}
                    values={days.map((d) => d.requests)}
                    label="requests"
                    height={180}
                />
            </div>
            <p className="text-[11px] text-ink-muted leading-relaxed">
                Days are UTC. A streamed answer counts when it starts, and a refused call counts against the key
                that made it.
            </p>
        </div>
    )
}

function Stat({ icon: Icon, label, value, sub, tone }: {
    icon: typeof Activity
    label: string
    value: string
    sub: string
    tone?: 'warn'
}) {
    return (
        <div className={cn(
            'rounded-xl border p-3',
            tone === 'warn' ? 'border-amber-500/25 bg-amber-500/[0.05]' : 'border-black/[0.07] dark:border-white/[0.08]',
        )}>
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                <Icon className="w-3.5 h-3.5" aria-hidden /> {label}
            </p>
            <p className={cn('mt-1 text-xl font-bold tabular-nums', tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink')}>
                {value}
            </p>
            <p className="text-[11px] text-ink-muted truncate">{sub}</p>
        </div>
    )
}
