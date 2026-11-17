/**
 * EntityHistory — an entity's revisions, newest first, a page at a time, in two groups:
 *   • In this draft — the open draft's own revisions, not merged yet (amber, first);
 *   • Published — the canonical `main` line. A revision published after the draft began is marked:
 *     the draft does not have it.
 *
 * The server says what each revision changed, field by field and property by property, against
 * the value it was made from (a draft's first edit, against main at the branch point) — so nothing
 * here downloads or diffs whole payloads, and a long history costs one page at a time.
 *
 * Each revision reads first as one line — who, when, and what it changed ("Edited Owner, Tier and 2
 * more") — and opens to its key differences, then to all of them. J / K move between revisions,
 * → / ← open and close, Shift+→ opens every revision shown.
 */
import { useCallback, useMemo, type ComponentType } from 'react'
import { ChevronRight, Loader2, Plus, Pencil, Trash2, GitBranch, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import type { EntityRevision } from '@/services/versioningApiService'
import { useExpandableRows, type ExpandableRows } from '@/hooks/useExpandableRows'
import { useEntityHistoryPages } from '../hooks/useVersioning'
import type { ChangeStatus, GraphChange } from '../model/changeModel'
import { fromRevisionChanges, summarizeFields } from '../model/fieldDiff'
import { CHANGE_TONE } from '../model/changeTone'
import { actorName } from '../model/branchVocab'
import { EntityDiff } from './EntityDiff'
import { ChangeSummary } from './ChangeSummary'

const OP_META: Record<string, { label: string; status: ChangeStatus; Icon: ComponentType<{ className?: string }> }> = {
  create: { label: 'created', status: 'added', Icon: Plus },
  update: { label: 'updated', status: 'modified', Icon: Pencil },
  delete: { label: 'deleted', status: 'removed', Icon: Trash2 },
}

const rowId = (entityId: string, v: EntityRevision) => `rev-${entityId}-${v.id}`

function Revision({ entityId, v, dotCls, userNames, rows }: {
  entityId: string
  v: EntityRevision
  dotCls: string
  userNames?: Record<string, string>
  rows: ExpandableRows<string>
}) {
  const op = OP_META[v.op] ?? OP_META.update
  const tone = CHANGE_TONE[op.status]
  const fields = useMemo(() => fromRevisionChanges(v.changes ?? []), [v.changes])
  const summary = useMemo(() => summarizeFields(fields), [fields])
  const level = rows.levelOf(v.id)
  const open = level > 0
  const change: GraphChange = {
    entityId, kind: 'node', status: op.status, label: entityId, origin: { source: 'commit', commitId: v.commit_id },
  }
  return (
    <li className="relative">
      <span className={cn('absolute -left-[1.36rem] top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', dotCls)} />
      <button id={rowId(entityId, v)} type="button" tabIndex={rows.current === v.id ? 0 : -1}
        aria-expanded={open} onClick={() => rows.toggle(v.id)} onFocus={() => rows.setCurrent(v.id)}
        className="w-full text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-black/[0.025] dark:hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
        <span className="text-[11px] text-ink-muted flex items-center gap-1.5 flex-wrap">
          <ChevronRight className={cn('w-3 h-3 text-ink-muted/60 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
          <op.Icon className={cn('w-3 h-3', tone.text)} />
          <span className={cn('font-semibold', tone.text)}>{op.label}</span>
          <span>by {actorName(v.actor ?? undefined, userNames)}</span>
          <span aria-hidden>·</span>
          <HoverTip label={formatUtc(v.created_at)} className="inline-flex">
            <span>{timeAgo(v.created_at)}</span>
          </HoverTip>
          {v.after_branch_point && (
            <span className="px-1.5 py-px rounded text-[10px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300">
              after your draft began
            </span>
          )}
        </span>
        {v.commit_message && <span className="block mt-0.5 pl-[18px] text-[11.5px] text-ink truncate">{v.commit_message}</span>}
        {v.changes !== null && (
          <span className="block mt-0.5 pl-[18px]">
            <ChangeSummary summary={summary} status={op.status} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 pl-[18px]">
          {v.changes === null
            ? <p className="text-[11px] text-ink-muted italic">What this revision changed is no longer on record.</p>
            : <EntityDiff change={change} fields={fields} depth={level === 1 ? 'key' : 'all'}
                onShowAll={() => rows.setLevel(v.id, 2)} />}
        </div>
      )}
    </li>
  )
}

function Timeline({ entityId, rows, dotCls, userNames, expand }: {
  entityId: string
  rows: EntityRevision[]
  dotCls: string
  userNames?: Record<string, string>
  expand: ExpandableRows<string>
}) {
  return (
    <ol className="relative ml-1.5 border-l border-glass-border space-y-2.5 pl-4">
      {rows.map((v) => (
        <Revision key={v.id} entityId={entityId} v={v} dotCls={dotCls} userNames={userNames} rows={expand} />
      ))}
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
  const order = useMemo(() => [...draftRows, ...publishedRows].map((v) => v.id), [draftRows, publishedRows])
  const byId = useMemo(() => new Map(all.map((v) => [v.id, v])), [all])
  const onNavigate = useCallback((id: string) => {
    const v = byId.get(id)
    if (v) document.getElementById(rowId(entityId, v))?.focus()
  }, [byId, entityId])
  // One revision: open, there is nothing else to browse.
  const expand = useExpandableRows(order, { onNavigate, initialLevel: all.length === 1 ? 1 : 0 })

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
    <div className="space-y-4" onKeyDown={expand.onKeyDown}>
      {all.length > 1 && (
        <div className="flex justify-end -mb-2">
          <button type="button" onClick={expand.allOpen ? expand.collapseAll : expand.expandAll}
            className="text-[11px] font-semibold text-ink-muted hover:text-ink">
            {expand.allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}
      {draftRows.length > 0 && (
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <GitBranch className="w-3 h-3" />
            In this draft · not merged yet
          </div>
          <Timeline entityId={entityId} rows={draftRows} dotCls="bg-amber-500" userNames={userNames} expand={expand} />
        </div>
      )}
      {publishedRows.length > 0 && (
        <div className="space-y-2">
          {draftRows.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Published</div>
          )}
          <Timeline entityId={entityId} rows={publishedRows} dotCls="bg-accent-lineage" userNames={userNames} expand={expand} />
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
