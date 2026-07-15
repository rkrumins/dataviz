/**
 * ViewPrList — the canvas review layer's PR list: pull requests raised from this view,
 * with a one-click switch to every PR on the whole data source. Rows reuse `PrListRow`
 * and open the existing `PrDetailDrawer` (full review: diff, approve/merge/close).
 */
import { useMemo, useState } from 'react'
import { Loader2, GitPullRequestArrow, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PullRequest } from '@/services/versioningApiService'
import { useViewPullRequests, useDataSourcePullRequests } from '../../versioning/hooks/useVersioning'
import { isLivePr } from '../../versioning/model/prStatus'
import { PrListRow } from './PrListRow'
import { PrDetailDrawer } from './PrDetailDrawer'

export function ViewPrList({
  wsId,
  viewId,
  dataSourceId,
}: {
  wsId: string
  viewId: string
  dataSourceId?: string | null
}) {
  const [wide, setWide] = useState(false)
  const [activeOnly, setActiveOnly] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  const viewQ = useViewPullRequests(wsId, viewId)
  const dsQ = useDataSourcePullRequests(wsId, dataSourceId, undefined, wide && !!dataSourceId)
  const q = wide ? dsQ : viewQ

  const rows = useMemo(() => {
    const list: PullRequest[] = q.data ?? []
    return activeOnly ? list.filter(isLivePr) : list
  }, [q.data, activeOnly])
  const hiddenByFilter = (q.data?.length ?? 0) - rows.length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-glass-border overflow-hidden text-xs">
          <button
            onClick={() => setWide(false)}
            className={cn('px-2.5 py-1 font-medium', !wide ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay')}
          >
            <GitPullRequestArrow className="w-3.5 h-3.5 inline mr-1" /> From this view
          </button>
          <button
            onClick={() => setWide(true)}
            disabled={!dataSourceId}
            className={cn('px-2.5 py-1 font-medium border-l border-glass-border disabled:opacity-50', wide ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay')}
            title={dataSourceId ? 'All PRs on this data source' : 'No data source for this view'}
          >
            <Layers className="w-3.5 h-3.5 inline mr-1" /> Whole data source
          </button>
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer ml-auto">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-accent-lineage" />
          Active only
        </label>
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading pull requests…
        </div>
      ) : rows.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-ink-muted">
            {wide ? 'No pull requests on this data source.' : 'No pull requests raised from this view yet.'}
          </p>
          {hiddenByFilter > 0 ? (
            <p className="mt-1.5 text-xs text-ink-muted/70">
              {hiddenByFilter} merged or closed {hiddenByFilter === 1 ? 'request is' : 'requests are'} hidden — untick "Active only" to see {hiddenByFilter === 1 ? 'it' : 'them'}.
            </p>
          ) : !wide ? (
            <p className="mt-1.5 text-xs text-ink-muted/70">
              Requests raised before view tracking was enabled, or from other views, appear under Whole data source.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((pr) => (
            <PrListRow key={pr.prId} wsId={wsId} pr={pr} onOpen={() => setSelected(pr.prId)} />
          ))}
        </div>
      )}

      {selected && <PrDetailDrawer wsId={wsId} prId={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
