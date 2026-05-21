/**
 * StaleDataBanner — inline indicator that the current scope's data is
 * being served from the backend GraphCache's stale-fallback path
 * (provider unavailable / timed out, backend returned last-known-good).
 *
 * Subscribes to two stores:
 *   - ``useProviderHealthStore`` — for the per-(ws, ds) health verdict
 *     surfaced by ``X-Provider-Health`` headers and the 30s
 *     /health/providers poll.
 *   - ``useCacheStalenessStore`` — for the ephemeral stale-fallback
 *     flag set by ``X-Cache-Status: stale-fallback`` headers.
 *
 * Renders nothing when both signals are clean. Otherwise renders a small
 * amber pill consistent with the existing StatusChip palette. Designed
 * to sit inline near affected widgets (entity drawer, dashboard tiles)
 * rather than as a full-page banner — the resilience promise is that
 * the rest of the UI keeps working, so an unobtrusive hint is enough.
 */
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCacheStalenessStore } from '@/store/cacheStaleness'
import { useProviderHealthStore } from '@/store/providerHealth'

export interface StaleDataBannerProps {
  workspaceId?: string
  dataSourceId?: string
  /** Optional extra context, e.g. "lineage" so the message reads
   *  "lineage data may be stale" instead of just "data may be stale". */
  subject?: string
  className?: string
}

export function StaleDataBanner({
  workspaceId,
  dataSourceId,
  subject,
  className,
}: StaleDataBannerProps) {
  // Re-render whenever either store mutates. Selectors keep this cheap
  // even though we're subscribed to two stores.
  const isStale = useCacheStalenessStore((s) =>
    s.isStale(workspaceId, dataSourceId),
  )
  const providerStatus = useProviderHealthStore((s) =>
    s.getStatus(workspaceId, dataSourceId),
  )

  const providerUnreachable = providerStatus === 'unhealthy'
  if (!isStale && !providerUnreachable) return null

  // Wording priority: provider-unreachable is more actionable than a
  // bare stale-fallback (the underlying provider literally cannot serve
  // a fresh answer right now).
  const message = providerUnreachable
    ? `Provider is recovering — ${subject ?? 'this data'} may be slightly out of date.`
    : `${subject ?? 'This data'} is being served from cache — provider response was slow.`

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
        'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="leading-snug">{message}</span>
    </div>
  )
}
