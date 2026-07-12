/**
 * StatusChip — universal pill rendering an insights envelope `meta` block.
 *
 * Used everywhere the platform shows cached data that may be fresh, stale,
 * computing, or unavailable. A single component keeps the visual language
 * consistent across RegistryAssets rows, view-wizard schema banners, and
 * provider list health indicators.
 */
import { CheckCircle2, Loader2, AlertTriangle, Clock, WifiOff, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InsightsMeta } from '@/types/insights'
import { useInsightsConfig } from '@/hooks/useInsightsConfig'

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
    const { ui_stale_threshold_secs } = useInsightsConfig()

    // Provider health overrides envelope status when the upstream is
    // unreachable — users care more about "the provider is down" than
    // "the cache is stale" in that situation.
    const showProviderDown = provider_health === 'down'

    // The backend's ``stale`` classification triggers read-path
    // enqueues (see _classify_freshness in insights.py); it fires as
    // early as STATS_CACHE_FRESH_SECS (5 min default). With a 30-min
    // discovery scheduler, that's a constant amber alarm on data the
    // user perceives as current. Suppress the warning visual until
    // ``staleness_secs`` exceeds the env-driven UI threshold (default
    // 24h). The data and refresh path are unchanged — only the chip
    // colour + label differ.
    const isStaleButRecent =
        status === 'stale'
        && staleness_secs != null
        && staleness_secs < ui_stale_threshold_secs
    const effectiveStatus = isStaleButRecent ? 'fresh' : status

    let Icon: typeof CheckCircle2 = CheckCircle2
    let label = 'Fresh'
    let title: string | undefined = undefined
    let tone =
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
    let spin = false

    // Do we have real cached data to show for this row? A row rendering
    // node/edge counts is `fresh` or `stale` — the cache has content.
    const hasCachedData = effectiveStatus === 'fresh' || effectiveStatus === 'stale'

    if (showProviderDown && hasCachedData) {
        // The live provider is offline, but we DID cache this data — so the
        // numbers on the row are real, just not guaranteed current. Say
        // "cached" (calm) instead of a scary red "DOWN" on a row that's
        // clearly showing data. This is the honest state: served from cache.
        Icon = Database
        const ago = formatStaleness(staleness_secs)
        label = compact ? 'Cached' : `Cached${ago ? ` · updated ${ago}` : ''}`
        title = `The provider is offline right now — these figures are served from the last cached copy${ago ? ` (updated ${ago})` : ''}. They refresh automatically once the provider is reachable again.`
        tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
    } else if (showProviderDown) {
        // Provider offline AND no cached data to fall back on — genuinely nothing to show.
        Icon = WifiOff
        label = compact ? 'Offline' : 'Provider offline'
        title = last_error ?? 'The provider is offline and there is no cached data to show yet.'
        tone = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
    } else if (effectiveStatus === 'computing') {
        Icon = Loader2
        label = compact ? 'Computing…' : 'Computing…'
        tone = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
        spin = true
    } else if (effectiveStatus === 'unavailable') {
        Icon = AlertTriangle
        label = compact ? 'Paused' : 'Background refresh paused'
        title = 'Refresh queue is unreachable; showing whatever cache survived'
        tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
    } else if (effectiveStatus === 'stale') {
        Icon = Clock
        const ago = formatStaleness(staleness_secs)
        label = compact ? `Stale${ago ? ` ${ago}` : ''}` : `Stale${ago ? ` (${ago})` : ''}`
        title = 'Cached data older than the configured UI threshold; a refresh job is in flight'
        tone = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
    } else if (effectiveStatus === 'partial') {
        Icon = AlertTriangle
        label = compact ? 'Partial' : 'Partial (synthetic)'
        title = 'Showing fallback data while a full refresh runs'
        tone = 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20'
    } else {
        // effectiveStatus === 'fresh' (covers true-fresh and stale-but-recent)
        Icon = CheckCircle2
        const ago = formatStaleness(staleness_secs)
        label = ago ? `Refreshed ${ago}` : 'Fresh'
        if (isStaleButRecent) {
            title = 'Cached data; a background refresh is in flight but the row is still recent'
        }
        if (provider_health === 'degraded') {
            // Cache is fresh but the provider is showing intermittent failures —
            // surface that subtlety rather than a clean green.
            label = compact
                ? `${ago ? `Refreshed ${ago}` : 'Fresh'} ⚠`
                : `${ago ? `Refreshed ${ago}` : 'Fresh'} (provider degraded)`
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
