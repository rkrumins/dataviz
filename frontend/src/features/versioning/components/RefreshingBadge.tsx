/**
 * RefreshingBadge — a small "Refreshing…" pill shown ONLY while the FalkorDB read cache of `main`
 * is actively catching up (projection `status` of projecting/rebuilding). Reads stay CORRECT from
 * Postgres meanwhile (the watermark-gated fallback). A graph that is merely behind-and-idle (e.g. no
 * FalkorDB projection worker is running) is NOT "refreshing" — so we don't nag; the cache simply
 * isn't the active read path. Polls only while actively projecting, then stops.
 */
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useProjectionWatermark } from '../hooks/useVersioning'

// Only these projection states mean the cache is genuinely catching up right now.
const ACTIVE_PROJECTION = new Set(['projecting', 'rebuilding'])

export function RefreshingBadge({ workspaceId, graphId, className }: {
  workspaceId: string
  graphId: string | null
  className?: string
}) {
  const wm = useProjectionWatermark(workspaceId, graphId)
  if (!graphId || wm.data?.fresh !== false || !ACTIVE_PROJECTION.has(wm.data?.status ?? 'idle')) return null
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
