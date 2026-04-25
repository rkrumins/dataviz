/**
 * StatusChip — universal pill rendering an insights envelope `meta` block.
 *
 * Used everywhere the platform shows cached data that may be fresh, stale,
 * computing, or unavailable. A single component keeps the visual language
 * consistent across RegistryAssets rows, view-wizard schema banners, and
 * provider list health indicators.
 */
import { CheckCircle2, Loader2, AlertTriangle, Clock, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InsightsMeta } from '@/types/insights'

interface Props {
    meta: InsightsMeta
    /** Compact mode hides the descriptive label; useful inside dense rows. */
    compact?: boolean
    className?: string
}

function formatStaleness(secs: number | null): string | null {
    if (secs == null) return null
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
}

export function StatusChip({ meta, compact, className }: Props) {
    const { status, staleness_secs, provider_health, last_error } = meta

    // Provider health overrides envelope status when the upstream is
    // unreachable — users care more about "the provider is down" than
    // "the cache is stale" in that situation.
    const showProviderDown = provider_health === 'down'

    let Icon: typeof CheckCircle2 = CheckCircle2
    let label = 'Fresh'
    let title: string | undefined = undefined
    let tone =
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
    let spin = false

    if (showProviderDown) {
        Icon = WifiOff
        label = compact ? 'Down' : 'Provider unreachable'
        title = last_error ?? 'Upstream provider not responding'
        tone = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
    } else if (status === 'computing') {
        Icon = Loader2
        label = compact ? 'Computing…' : 'Computing…'
        tone = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
        spin = true
    } else if (status === 'unavailable') {
        Icon = AlertTriangle
        label = compact ? 'Paused' : 'Background refresh paused'
        title = 'Refresh queue is unreachable; showing whatever cache survived'
        tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
    } else if (status === 'stale') {
        Icon = Clock
        const ago = formatStaleness(staleness_secs)
        label = compact ? `Stale${ago ? ` ${ago}` : ''}` : `Stale${ago ? ` (${ago})` : ''}`
        title = 'Cached data; a refresh job is in flight'
        tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
    } else if (status === 'partial') {
        Icon = AlertTriangle
        label = compact ? 'Partial' : 'Partial (synthetic)'
        title = 'Showing fallback data while a full refresh runs'
        tone = 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20'
    } else {
        // status === 'fresh'
        Icon = CheckCircle2
        label = compact ? 'Fresh' : 'Fresh'
        if (provider_health === 'degraded') {
            // Cache is fresh but the provider is showing intermittent failures —
            // surface that subtlety rather than a clean green.
            label = compact ? 'Fresh ⚠' : 'Fresh (provider degraded)'
            tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
        }
    }

    return (
        <span
            title={title}
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide',
                tone,
                className,
            )}
        >
            <Icon className={cn('w-3 h-3', spin && 'animate-spin')} />
            {label}
        </span>
    )
}
