/**
 * EntityHistory — an entity's revisions, newest first, a page at a time, in two groups:
 *   • In this draft — the open draft's own revisions, not merged yet (amber, first);
 *   • Published — the canonical `main` line. A revision published after the draft began is marked:
 *     the draft does not have it.
 *
 * The server says what each revision changed, field by field and property by property, against
 * the value it was made from (a draft's first edit, against main at the branch point) — so nothing
 * here downloads or diffs whole payloads, and a long history costs one page at a time.
 */
import { useMemo, type ComponentType } from 'react'
import { Loader2, Plus, Pencil, Trash2, GitBranch, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import type { EntityRevision, RevisionChange } from '@/services/versioningApiService'
import { useEntityHistoryPages } from '../hooks/useVersioning'
import type { FieldDelta, GraphChange } from '../model/changeModel'
import { actorName } from '../model/branchVocab'
import { EntityDiff } from './EntityDiff'

const OP_META: Record<string, { label: string; cls: string; Icon: ComponentType<{ className?: string }> }> = {
  create: { label: 'created', cls: 'text-emerald-500', Icon: Plus },
  update: { label: 'updated', cls: 'text-amber-500', Icon: Pencil },
  delete: { label: 'deleted', cls: 'text-rose-500', Icon: Trash2 },
}

/** A change's row label: a property by its name, a field by its path. */
const labelOf = (c: RevisionChange) => (c.path[0] === 'properties' ? c.path.slice(1).join('.') : c.path.join('.'))

/** A revision in the shape the field diff renders. */
function asChange(entityId: string, v: EntityRevision): GraphChange {
  const fields: FieldDelta[] = (v.changes ?? []).map((c) => ({ field: labelOf(c), before: c.before, after: c.after }))
  const side = (pick: 'before' | 'after') => Object.fromEntries(fields.map((f) => [f.field, f[pick]]))
  const status: GraphChange['status'] = v.op === 'create' ? 'added' : v.op === 'delete' ? 'removed' : 'modified'
  return {
    entityId,
    kind: 'node',
    status,
    label: entityId,
    fields: status === 'modified' ? fields : undefined,
    before: status === 'removed' ? side('before') : undefined,
    after: status === 'added' ? side('after') : undefined,
    origin: { source: 'commit', commitId: v.commit_id },
  }
}

function Timeline({ entityId, rows, dotCls, userNames }: {
  entityId: string
  rows: EntityRevision[]
  dotCls: string
  userNames?: Record<string, string>
}) {
  return (
    <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
      {rows.map((v) => {
        const op = OP_META[v.op] ?? OP_META.update
        return (
          <li key={v.id} className="relative">
            <span className={cn('absolute -left-[1.36rem] top-1 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', dotCls)} />
            <p className="text-[11px] text-ink-muted flex items-center gap-1.5 flex-wrap">
              <op.Icon className={cn('w-3 h-3', op.cls)} />
              <span className={cn('font-medium', op.cls)}>{op.label}</span>
              <span>by {actorName(v.actor ?? undefined, userNames)}</span>
              <span>·</span>
              <HoverTip label={formatUtc(v.created_at)} className="inline-flex">
                <span>{timeAgo(v.created_at)}</span>
              </HoverTip>
              {v.after_branch_point && (
                <span className="px-1.5 py-px rounded text-[10px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300">
                  after your draft began
                </span>
              )}
            </p>
            {v.commit_message && (
              <p className="mt-0.5 text-[11px] text-ink truncate" title={v.commit_message}>{v.commit_message}</p>
            )}
            <div className="mt-1.5">
              {v.changes === null
                ? <p className="text-[11px] text-ink-muted italic">What this revision changed is no longer on record.</p>
                : <EntityDiff change={asChange(entityId, v)} />}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function EntityHistory({
  wsId,
  graphId,
  entityId,
  mainBranchId,
  branchId,
  kind,
}: {
  wsId: string
  graphId: string
  entityId: string
  mainBranchId?: string | null
  /** Active draft branch — its unmerged revisions for this entity are shown above the published ones. */
  branchId?: string | null
  kind?: 'node' | 'edge'
}) {
  const draftId = branchId && branchId !== mainBranchId ? branchId : null
  const q = useEntityHistoryPages(wsId, graphId, entityId, { branchId: draftId, kind })
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.versions) ?? [], [q.data])
  const userNames = useMemo(
    () => Object.assign({}, ...(q.data?.pages.map((p) => p.userNames ?? {}) ?? [])) as Record<string, string>,
    [q.data],
  )
  const draftRows = useMemo(() => all.filter((v) => v.on_draft), [all])
  const publishedRows = useMemo(() => all.filter((v) => !v.on_draft), [all])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-muted py-3 justify-center" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    )
  }
  if (q.isError) {
    return (
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted py-2" role="alert">
        <span>Couldn’t load the history.</span>
        <button type="button" onClick={() => { void q.refetch() }}
          className="inline-flex items-center gap-1 font-semibold text-accent-lineage hover:underline">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    )
  }
  if (all.length === 0) {
    return <p className="text-[11px] text-ink-muted py-3">No history for this entity yet.</p>
  }

  return (
    <div className="space-y-4">
      {draftRows.length > 0 && (
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <GitBranch className="w-3 h-3" />
            In this draft · not merged yet
          </div>
          <Timeline entityId={entityId} rows={draftRows} dotCls="bg-amber-500" userNames={userNames} />
        </div>
      )}
      {publishedRows.length > 0 && (
        <div className="space-y-2">
          {draftRows.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Published</div>
          )}
          <Timeline entityId={entityId} rows={publishedRows} dotCls="bg-accent-lineage" userNames={userNames} />
        </div>
      )}
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => { void q.fetchNextPage() }}
          disabled={q.isFetchingNextPage}
          className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold text-ink-muted border border-glass-border hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 transition-colors"
        >
          {q.isFetchingNextPage ? <><Loader2 className="w-3 h-3 animate-spin" /> Loading…</> : 'Show older revisions'}
        </button>
      )}
    </div>
  )
}
