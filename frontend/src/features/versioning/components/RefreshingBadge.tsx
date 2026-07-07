/**
 * RefreshingBadge — surfaces the ASYNC background sync so the user always knows their committed
 * changes are being applied to the fast read layer (FalkorDB), and when that lands.
 *
 * Publishing/merging updates Postgres (source of truth) immediately, but the FalkorDB projection the
 * canvas + Properties panel read from catches up in the background. Without a signal, a user sees a
 * brief window where the panel still shows the old value — confusing. So we show:
 *   • "Syncing changes…"  while the projection is actively catching up (status projecting/rebuilding)
 *   • "Synced"            for a few seconds AFTER it finishes (the confirmation), then nothing
 * Reads stay CORRECT from Postgres meanwhile (the watermark-gated fallback). A graph that is merely
 * behind-and-idle (no worker running) is not "syncing" — we don't nag.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
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
  const syncing = !!graphId && wm.data?.fresh === false && ACTIVE_PROJECTION.has(wm.data?.status ?? 'idle')

  // Show a brief "Synced" confirmation right after a sync completes (syncing → fresh).
  const [justSynced, setJustSynced] = useState(false)
  const wasSyncingRef = useRef(false)
  useEffect(() => {
    if (wasSyncingRef.current && !syncing && wm.data?.fresh === true) {
      setJustSynced(true)
      const t = setTimeout(() => setJustSynced(false), 2500)
      return () => clearTimeout(t)
    }
    wasSyncingRef.current = syncing
  }, [syncing, wm.data?.fresh])

  if (syncing) {
    return (
      <span
        className={cn('flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium',
          'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20', className)}
        title="Your committed changes are being applied to the fast read layer in the background — reads stay correct meanwhile"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        Syncing changes…
      </span>
    )
  }
  if (justSynced) {
    return (
      <span
        className={cn('flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium animate-in fade-in',
          'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20', className)}
        title="Your changes are now live across every view"
      >
        <Check className="w-3 h-3" />
        Synced
      </span>
    )
  }
  return null
}
