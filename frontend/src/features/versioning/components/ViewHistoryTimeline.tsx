/**
 * ViewHistoryTimeline — a view's change history. Defaults to commits attributed to this
 * view (across branches); a toggle widens to the whole graph's `main` log. Each commit is
 * **expandable** (lazy per-commit diff) via the shared {@link CommitRow}. In graph-wide mode,
 * commits from other views are labelled so you can see where a change originated.
 */
import { useCallback, useMemo, useState } from 'react'
import { Loader2, Eye, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useViewCommitLog } from '../hooks/useVersioning'
import { CommitRow } from './CommitRow'

export function ViewHistoryTimeline({
  wsId,
  graphId,
  viewId,
}: {
  wsId: string
  graphId: string
  viewId?: string | null
}) {
  const [graphWide, setGraphWide] = useState(!viewId)
  const [limit, setLimit] = useState(25)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const q = useViewCommitLog(wsId, graphId, { viewId, graphWide, limit })
  const commits = useMemo(
    () => (q.data?.commits ?? []) as Array<Record<string, unknown>>,
    [q.data],
  )
  const canScope = !!viewId
  const toggle = useCallback((id: string) => setExpandedId((prev) => (prev === id ? null : id)), [])

  return (
    <div className="space-y-3">
      {canScope && (
        <div className="inline-flex rounded-lg border border-glass-border overflow-hidden text-xs">
          <button
            onClick={() => setGraphWide(false)}
            className={cn('px-2.5 py-1 font-medium', !graphWide ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay')}
          >
            <Eye className="w-3.5 h-3.5 inline mr-1" /> This view
          </button>
          <button
            onClick={() => setGraphWide(true)}
            className={cn('px-2.5 py-1 font-medium border-l border-glass-border', graphWide ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay')}
          >
            <Layers className="w-3.5 h-3.5 inline mr-1" /> Whole graph
          </button>
        </div>
      )}

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
        </div>
      ) : commits.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-ink-muted">
            {graphWide ? 'No commits yet.' : 'No changes from this view yet.'}
          </p>
        </div>
      ) : (
        <>
          <ol className="relative ml-1.5 border-l border-glass-border space-y-3.5 pl-4">
            {commits.map((c, i) => {
              const cid = (c.commit_id as string) ?? String(i)
              const originatingViewLabel =
                graphWide && c.originating_view_id && c.originating_view_id !== viewId
                  ? (c.originating_view_id as string).slice(-6)
                  : null
              return (
                <CommitRow
                  key={cid}
                  commit={c}
                  wsId={wsId}
                  graphId={graphId}
                  originatingViewLabel={originatingViewLabel}
                  expanded={expandedId === cid}
                  onToggle={toggle}
                />
              )
            })}
          </ol>
          {commits.length >= limit && (
            <button
              onClick={() => setLimit((l) => l + 25)}
              className="text-[11px] text-accent-lineage hover:underline py-1"
            >
              Load more
            </button>
          )}
        </>
      )}
    </div>
  )
}
