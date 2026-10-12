/**
 * "Raise the per-query limit on <node>" — the way from a per-query memory
 * failure to the one control that fixes it. Rendered only for system
 * administrators, and only once the source's shard is known (the capacity
 * read the drawer and the re-trigger dialog already share); nothing
 * otherwise, so a non-admin reads the guidance without a door they cannot
 * open.
 */
import { ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { compactBytes, graphStoreLimitsPath } from './aggregationKnobs'
import { useSourceCapacity } from './useAggregationCapacity'

export function RaisePerQueryLimitLink({ dataSourceId, className }: { dataSourceId: string; className?: string }) {
    const isSystemAdmin = usePermission('system:admin')
    const q = useSourceCapacity(dataSourceId, isSystemAdmin)
    const shard = q.data?.shard
    if (!isSystemAdmin || !shard?.measurable || shard.endpoint === 'unknown') return null
    return (
        <Link
            to={graphStoreLimitsPath(shard.endpoint)}
            data-testid="raise-per-query-limit"
            className={cn(
                'inline-flex flex-wrap items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline',
                className,
            )}
        >
            <span>Raise the per-query limit on <span className="font-mono">{shard.endpoint}</span></span>
            {shard.queryMemCapacity != null && (
                <span className="font-normal text-ink-muted">(now {compactBytes(shard.queryMemCapacity)})</span>
            )}
            <ArrowUpRight className="w-3 h-3" />
        </Link>
    )
}
