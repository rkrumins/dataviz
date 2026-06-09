/**
 * RefreshingBadge — a small "Refreshing…" pill shown while the FalkorDB read cache of `main`
 * lags the committed head (e.g. just after a bulk ingest, or while a cold/evicted cache rebuilds).
 * Reads stay CORRECT from Postgres meanwhile (the watermark-gated fallback); this only tells the
 * user the fast cache is catching up. Polls only while behind, then stops.
 */
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useProjectionWatermark } from '../hooks/useVersioning'

export function RefreshingBadge({ workspaceId, graphId, className }: {
  workspaceId: string
  graphId: string | null
  className?: string
}) {
  const wm = useProjectionWatermark(workspaceId, graphId)
  if (!graphId || wm.data?.fresh !== false) return null
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium',
        'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
        className,
      )}
      title="The fast read cache is catching up to the latest committed changes"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      Refreshing…
    </span>
  )
}
