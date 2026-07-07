/**
 * BranchBehindBanner — the "notified right away" half of the collaborative model.
 *
 * Self-contained: resolves the active view's graph + draft internally (via the SAME shared queries
 * CanvasVersioningBar uses — identical keys/options, so no conflicting observer), then polls the
 * O(1) freshness endpoint (`useBranchFreshness`: dedicated key + constant interval → structurally
 * cannot cause a render loop). Renders a DECLARATIVE banner only when the active draft is behind main
 * (a teammate published under it); nothing otherwise. The Pull action reuses `PullLatestButton`
 * (pull → ConflictResolver → resolve), so resolving is one click away — no imperative toast.
 */
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEffectiveBranchId } from '@/store/branchStore'
import { useBranchFreshness, useResolveGraph } from '../hooks/useVersioning'
import { PullLatestButton } from './PullLatestButton'

export function BranchBehindBanner({ wsId, dataSourceId, viewId, className }: {
  wsId: string
  dataSourceId: string | null
  viewId?: string | null
  className?: string
}) {
  const resolve = useResolveGraph(wsId, dataSourceId, viewId)
  const graphId = resolve.data?.graphId ?? null
  const branchId = useEffectiveBranchId(wsId, dataSourceId, viewId)
  const fresh = useBranchFreshness(wsId, graphId, branchId)

  if (!graphId || !branchId || fresh.data?.behind !== true) return null
  const n = fresh.data.behindBy
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-[12px] rounded-lg border animate-in fade-in slide-in-from-top-1',
        'border-amber-500/30 bg-amber-500/10',
        className,
      )}
    >
      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
      <span className="text-ink-muted">
        <span className="font-medium text-amber-600 dark:text-amber-400">
          Main was updated by someone else{n ? ` — ${n} new change${n === 1 ? '' : 's'}` : ''}.
        </span>{' '}
        Pull the latest to review and resolve any conflicts before publishing.
      </span>
      <PullLatestButton wsId={wsId} graphId={graphId} branchId={branchId} behind className="ml-auto shrink-0" />
    </div>
  )
}
