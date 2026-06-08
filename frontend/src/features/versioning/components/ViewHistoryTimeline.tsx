/**
 * ViewHistoryTimeline — a view's change history. Defaults to commits attributed to this
 * view (across branches); a toggle widens to the whole graph's `main` log. Mirrors the
 * PR drawer's activity-timeline styling; each commit shows its message, author, when, and
 * a create/modify/remove stat breakdown. In graph-wide mode, commits from other views are
 * labelled so you can see where a change originated.
 */
import { useMemo, useState } from 'react'
import { Loader2, GitCommitHorizontal, User, Eye, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useViewCommitLog } from '../hooks/useVersioning'
import { NodeDiffBadge } from './NodeDiffBadge'

const who = (a?: unknown) => (typeof a === 'string' && a ? a.split('@')[0] : 'system')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function StatChips({ stats }: { stats: Record<string, unknown> }) {
  const added = num(stats.create)
  const modified = num(stats.update)
  const removed = num(stats.delete)
  if (added + modified + removed === 0) return null
  return (
    <span className="inline-flex items-center gap-1">
      {added > 0 && <NodeDiffBadge status="added" count={added} />}
      {modified > 0 && <NodeDiffBadge status="modified" count={modified} />}
      {removed > 0 && <NodeDiffBadge status="removed" count={removed} />}
    </span>
  )
}

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
  const q = useViewCommitLog(wsId, graphId, { viewId, graphWide, limit })
  const commits = useMemo(
    () => (q.data?.commits ?? []) as Array<Record<string, unknown>>,
    [q.data],
  )
  const canScope = !!viewId

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
              const stats = (c.stats ?? {}) as Record<string, unknown>
              const fromOtherView = graphWide && !!c.originating_view_id && c.originating_view_id !== viewId
              return (
                <li key={(c.commit_id as string) ?? i} className="relative">
                  <span className="absolute -left-[1.36rem] top-0.5 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-ink leading-tight flex items-center gap-1.5 min-w-0">
                      <GitCommitHorizontal className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                      <span className="truncate">
                        {(c.message as string) || `${c.kind ?? 'commit'} #${c.commit_seq ?? ''}`}
                      </span>
                    </p>
                    <StatChips stats={stats} />
                  </div>
                  <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-1.5 flex-wrap pl-5">
                    <User className="w-3 h-3" /> {who(c.actor)}
                    <span>·</span>
                    <span>{timeAgo(c.created_at as string)}</span>
                    {fromOtherView && (
                      <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted" title="Originating view">
                        view {(c.originating_view_id as string).slice(-6)}
                      </span>
                    )}
                  </p>
                </li>
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
