/**
 * ViewHistoryTimeline — change history with up to three scopes:
 *  • This draft  — the active draft's own checkpoints, so you can review your individual commits
 *    before raising a PR (shown only while on a draft).
 *  • This view   — commits attributed to this view across branches (its drafts + merges).
 *  • Whole graph — the graph's full `main` log (every merge / import / genesis).
 * Each commit is expandable (lazy per-commit diff) via the shared {@link CommitRow}.
 */
import { useCallback, useMemo, useState, type ComponentType } from 'react'
import { Loader2, Eye, Layers, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCommitLog, useViewCommitLog } from '../hooks/useVersioning'
import { CommitRow } from './CommitRow'

type Scope = 'draft' | 'view' | 'graph'

export function ViewHistoryTimeline({
  wsId,
  graphId,
  viewId,
  branchId,
}: {
  wsId: string
  graphId: string
  viewId?: string | null
  branchId?: string | null
}) {
  const onDraft = !!branchId
  const [scope, setScope] = useState<Scope>(onDraft ? 'draft' : viewId ? 'view' : 'graph')
  const [limit, setLimit] = useState(25)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Only the active scope fetches — pass graphId=null to disable the inactive hook.
  const draftQ = useCommitLog(wsId, scope === 'draft' ? graphId : null, branchId ?? null)
  const viewQ = useViewCommitLog(wsId, scope === 'draft' ? null : graphId, {
    viewId, graphWide: scope === 'graph', limit,
  })
  const q = scope === 'draft' ? draftQ : viewQ
  const commits = useMemo(() => (q.data?.commits ?? []) as Array<Record<string, unknown>>, [q.data])
  const toggle = useCallback((id: string) => setExpandedId((prev) => (prev === id ? null : id)), [])

  const scopeBtns: Array<{ id: Scope; label: string; Icon: ComponentType<{ className?: string }>; show: boolean }> = [
    { id: 'draft', label: 'This draft', Icon: GitBranch, show: onDraft },
    { id: 'view', label: 'This view', Icon: Eye, show: !!viewId },
    { id: 'graph', label: 'Whole graph', Icon: Layers, show: true },
  ]
  const visible = scopeBtns.filter((b) => b.show)

  const emptyMsg =
    scope === 'draft' ? 'No commits on this draft yet — make a change and save it.'
      : scope === 'graph' ? 'No commits yet.'
        : 'No changes from this view yet.'

  return (
    <div className="space-y-3">
      {visible.length > 1 && (
        <div className="inline-flex rounded-lg border border-glass-border overflow-hidden text-xs">
          {visible.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setScope(b.id)}
              className={cn(
                'px-2.5 py-1 font-medium',
                i > 0 && 'border-l border-glass-border',
                scope === b.id ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
              )}
            >
              <b.Icon className="w-3.5 h-3.5 inline mr-1" /> {b.label}
            </button>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
        </div>
      ) : commits.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-ink-muted">{emptyMsg}</p>
        </div>
      ) : (
        <>
          <ol className="relative ml-1.5 border-l border-glass-border space-y-3.5 pl-4">
            {commits.map((c, i) => {
              const cid = (c.commit_id as string) ?? String(i)
              const originatingViewLabel =
                scope === 'graph' && c.originating_view_id && c.originating_view_id !== viewId
                  ? (c.originating_view_id as string).slice(-6)
                  : null
              return (
                <CommitRow
                  key={cid}
                  commit={c}
                  wsId={wsId}
                  graphId={graphId}
                  originatingViewLabel={originatingViewLabel}
                  userNames={q.data?.userNames}
                  expanded={expandedId === cid}
                  onToggle={toggle}
                />
              )
            })}
          </ol>
          {scope !== 'draft' && commits.length >= limit && (
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
