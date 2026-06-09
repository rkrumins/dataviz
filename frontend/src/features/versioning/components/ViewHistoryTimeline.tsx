/**
 * ViewHistoryTimeline — a view's change history. Defaults to commits attributed to this
 * view (across branches); a toggle widens to the whole graph's `main` log. Each commit shows
 * its message, author, when, and a create/modify/remove stat breakdown — and is **expandable**:
 * clicking it lazily loads that commit's hierarchical diff (the same containment tree the
 * Changes/PR tabs use), so you can review exactly what changed. In graph-wide mode, commits from
 * other views are labelled so you can see where a change originated.
 */
import { useCallback, useMemo, useState } from 'react'
import { Loader2, User, Eye, Layers, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { getCommitDiffChildren } from '@/services/versioningApiService'
import { useViewCommitLog, useCommitDiffSummary } from '../hooks/useVersioning'
import { NodeDiffBadge } from './NodeDiffBadge'
import { ChangeTreePanel } from './ChangeTreePanel'

const who = (a?: unknown) => (typeof a === 'string' && a ? a.split('@')[0] : 'system')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function StatChips({ stats }: { stats: Record<string, unknown> }) {
  const added = num(stats.create)
  const modified = num(stats.update)
  const removed = num(stats.delete)
  if (added + modified + removed === 0) return null
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {added > 0 && <NodeDiffBadge status="added" count={added} />}
      {modified > 0 && <NodeDiffBadge status="modified" count={modified} />}
      {removed > 0 && <NodeDiffBadge status="removed" count={removed} />}
    </span>
  )
}

function CommitRow({
  commit,
  wsId,
  graphId,
  originatingViewLabel,
  expanded,
  onToggle,
}: {
  commit: Record<string, unknown>
  wsId: string
  graphId: string
  originatingViewLabel: string | null
  expanded: boolean
  onToggle: (commitId: string) => void
}) {
  const commitId = commit.commit_id as string
  const stats = (commit.stats ?? {}) as Record<string, unknown>
  // Only fetch the diff once the row is opened (immutable commit → long staleTime).
  const summaryQ = useCommitDiffSummary(wsId, graphId, expanded ? commitId : null)
  const fetchChildren = useCallback(
    (key: string, offset: number) => getCommitDiffChildren(wsId, graphId, commitId, key, { offset, limit: 50 }),
    [wsId, graphId, commitId],
  )

  return (
    <li className="relative">
      <span className="absolute -left-[1.36rem] top-1 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
      <button onClick={() => onToggle(commitId)} className="w-full text-left group">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-ink leading-tight flex items-center gap-1.5 min-w-0">
            <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 shrink-0 transition-transform', expanded && 'rotate-90')} />
            <span className="truncate group-hover:text-ink">
              {(commit.message as string) || `${commit.kind ?? 'commit'} #${commit.commit_seq ?? ''}`}
            </span>
          </p>
          <StatChips stats={stats} />
        </div>
        <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-1.5 flex-wrap pl-5">
          <User className="w-3 h-3" /> {who(commit.actor)}
          <span>·</span>
          <span>{timeAgo(commit.created_at as string)}</span>
          {originatingViewLabel && (
            <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted" title="Originating view">
              view {originatingViewLabel}
            </span>
          )}
        </p>
      </button>
      {expanded && (
        <div className="mt-2 pl-5">
          <ChangeTreePanel
            summary={summaryQ.data}
            isLoading={summaryQ.isLoading}
            fetchChildren={fetchChildren}
            origin={{ source: 'commit', commitId }}
            emptyHint="No changes in this commit."
          />
        </div>
      )}
    </li>
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
