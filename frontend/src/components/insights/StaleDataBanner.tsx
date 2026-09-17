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
 *
 * IT SAYS HOW LONG, NOT "SLIGHTLY". The backend's last-known-good mirror
 * lives for a day (``GRAPH_CACHE_LKG_TTL_S``, default 86400), so "may be
 * slightly out of date" covered everything from a two-second blip to a
 * twenty-four-hour outage with the same six words. What is knowable on this
 * side of the wire is how long the provider has been unable to answer
 * freshly, so that is what it reports — and it keeps counting while it is on
 * screen, because a frozen duration is the same lie in a different font.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCacheStalenessStore } from '@/store/cacheStaleness'
import { useProviderHealthStore } from '@/store/providerHealth'

/** How often the elapsed figure is recomputed while the pill is up. */
const TICK_MS = 30_000

/** "12 seconds" / "4 minutes" / "3 hours" — coarse on purpose: the reader is
 *  deciding whether to trust what is on screen, not timing anything. */
function elapsed(sinceMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - sinceMs) / 1000))
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

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
  const staleSince = useCacheStalenessStore((s) =>
    s.staleSince(workspaceId, dataSourceId),
  )
  const providerStatus = useProviderHealthStore((s) =>
    s.getStatus(workspaceId, dataSourceId),
  )

  // Re-render on a slow tick so the figure counts up rather than freezing at
  // whatever it was when the last response happened to land.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (staleSince === null) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [staleSince])

  const providerUnreachable = providerStatus === 'unhealthy'
  if (!isStale && !providerUnreachable) return null

  // Wording priority: provider-unreachable is more actionable than a
  // bare stale-fallback (the underlying provider literally cannot serve
  // a fresh answer right now).
  const age = staleSince === null ? null : elapsed(staleSince, Math.max(now, Date.now()))
  const what = subject ?? 'this data'
  const message = age !== null
    // The duration is of the OUTAGE, not of the answer: the saved copy can be
    // older still. Saying which is which is the whole point.
    ? `Showing the last saved copy of ${what} — no fresh answer for ${age}.`
    : providerUnreachable
      ? `Provider is recovering — ${what} may be out of date.`
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
