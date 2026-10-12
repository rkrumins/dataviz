/**
 * ViewPrIndicator — the canvas's at-a-glance review signal: how many active PRs were raised
 * from this view, and how many are open across its whole data source. Click to open the
 * review panel on the Pull Requests tab. Renders nothing when there's nothing to act on.
 */
import { GitPullRequest } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useViewPrCounts } from '../hooks/useVersioning'

export function ViewPrIndicator({
  wsId,
  viewId,
  onOpen,
  className,
}: {
  wsId: string
  viewId?: string | null
  onOpen: () => void
  className?: string
}) {
  const { data } = useViewPrCounts(wsId, viewId)
  const fromView = data?.fromView ?? 0
  const onDs = data?.onDataSource ?? 0
  if (fromView === 0 && onDs === 0) return null

  return (
    <HoverTip
      className={cn('inline-flex', className)}
      label="Open the reviews raised from this view"
      detail="Drafts waiting on somebody before they can be published"
    >
    <button
      onClick={onOpen}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
        'border border-indigo-500/25 bg-indigo-500/[0.07] text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/15',
      )}
    >
      <GitPullRequest className="w-3.5 h-3.5 shrink-0" />
      {fromView > 0 && (
        <span className="tabular-nums">
          {fromView} <span className="font-normal text-ink-muted">from this view</span>
        </span>
      )}
      {onDs > 0 && (
        <span className="tabular-nums text-ink-muted">
          {fromView > 0 ? '· ' : ''}
          {onDs} <span className="font-normal">on data source</span>
        </span>
      )}
    </button>
    </HoverTip>
  )
}
