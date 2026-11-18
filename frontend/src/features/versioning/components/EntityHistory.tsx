/**
 * EntityHistory — an entity's (or a relationship's) revisions, newest first, a page at a time, in two
 * groups, each by day:
 *   • In this draft — the open draft's own revisions, not merged yet (amber, first);
 *   • Published — the canonical `main` line. A revision published after the draft began is marked:
 *     the draft does not have it.
 *
 * Each revision reads first as a line or two — who (a person as the person), when, what kind of
 * change it was (published through a review, a revert, an import…), its message and why, and what it
 * changed ("Edited Owner, Tier and 2 more"). Opened, it says what it changed, and can show the
 * entity **as it was** after it, or **compared with now** — each read when asked for, one revision at
 * a time; a long history costs one page at a time.
 *
 * J / K move between revisions, → / ← open and close, Shift+→ opens every revision shown.
 */
import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { Check, ChevronRight, Copy, Loader2, Plus, Pencil, RotateCcw, Trash2, GitBranch, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonChip } from '@/components/ui/PersonChip'
import { Segmented } from '@/components/ui/Segmented'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import { userProperties } from '@/lib/nodeFields'
import type { EntityRevision, EntityView } from '@/services/versioningApiService'
import { useExpandableRows, type ExpandableRows } from '@/hooks/useExpandableRows'
import { PropertyEditor } from '@/components/panels/PropertyEditor'
import { RichValue } from '@/components/panels/property/RichValue'
import { useEntityHistoryPages, useEntityRevision, useEntitySummary } from '../hooks/useVersioning'
import type { ChangeStatus, GraphChange } from '../model/changeModel'
import { entityFieldChanges, fromRevisionChanges, namedFields, summarizeFields } from '../model/fieldDiff'
import { CHANGE_TONE } from '../model/changeTone'
import { actorName } from '../model/branchVocab'
import { kindMeta } from '../model/commitKind'
import { EntityDiff } from './EntityDiff'
import { ChangeSummary } from './ChangeSummary'

const OP_META: Record<string, { label: string; status: ChangeStatus; Icon: ComponentType<{ className?: string }> }> = {
  create: { label: 'created', status: 'added', Icon: Plus },
  update: { label: 'updated', status: 'modified', Icon: Pencil },
  delete: { label: 'deleted', status: 'removed', Icon: Trash2 },
}

/** Commit kinds worth a word on the row; a plain edit says nothing more. */
const SAYS_KIND = new Set(['squash_publish', 'revert', 'restore', 'import', 'sync', 'pull', 'sync_parent'])
const PERSON_ID = /^(usr|svc)_/

const rowId = (entityId: string, v: EntityRevision) => `rev-${entityId}-${v.id}`

type Kind = 'node' | 'edge'
/** Where a revision is read from: the line the drawer reads. */
interface Line { wsId: string; graphId: string; branchId: string | null; kind: Kind }
type View = 'changes' | 'then' | 'now'
const VIEWS = [
  { value: 'changes' as const, label: 'What changed' },
  { value: 'then' as const, label: 'As it was' },
  { value: 'now' as const, label: 'Compared with now' },
]

/** A day, as a list of days names it: Today, Yesterday, 12 Nov (with its year when not this one). */
function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

function Actor({ actor, userNames }: { actor?: string | null; userNames?: Record<string, string> }) {
  if (actor && PERSON_ID.test(actor)) {
    return (
      <span className="inline-flex items-center gap-1">by
        <PersonChip id={actor} person={userNames?.[actor] ? { name: userNames[actor] } : null} size="xs" link={false} />
      </span>
    )
  }
  return <span>by {actorName(actor ?? undefined, userNames)}</span>
}

/** The entity of a reader's view (a revision's, or now), or null for one deleted. */
const entityOf = (v: EntityView | null | undefined): Record<string, unknown> | null =>
  !v || v.deleted ? null : ((v.kind === 'edge' ? v.edge : v.node) as unknown as Record<string, unknown>)

function Pending({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-muted py-2" role="status">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading {what}…
    </div>
  )
}

function Failed({ what, retry }: { what: string; retry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted py-1.5" role="alert">
      <span>Couldn’t read {what}.</span>
      <button type="button" onClick={retry} className="inline-flex items-center gap-1 font-semibold text-accent-lineage hover:underline">
        <RefreshCw className="w-3 h-3" /> Try again
      </button>
    </div>
  )
}

/** Copy what a deleted entity held, to paste or keep. */
function CopyValues({ entity }: { entity: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(entity, null, 2))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch { /* clipboard unavailable */ }
    }}
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold text-ink-secondary border border-glass-border hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
      {copied ? <Check className="w-3 h-3 text-emerald-500" aria-hidden /> : <Copy className="w-3 h-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy values'}
    </button>
  )
}

/** The entity as this revision left it: its named fields, then its properties, read-only. A deletion
 *  shows what it removed — the entity just before — to copy, or bring back where that is possible. */
function AsItWas({ entityId, v, line, userNames, onRestore }: {
  entityId: string
  v: EntityRevision
  line: Line
  userNames?: Record<string, string>
  onRestore?: () => void
}) {
  const q = useEntityRevision(line.wsId, line.graphId, entityId, v.id, { branchId: line.branchId, kind: line.kind })
  if (q.isLoading) return <Pending what="this revision" />
  if (q.isError || !q.data) return <Failed what="this revision" retry={() => { void q.refetch() }} />
  const left = entityOf(q.data.value)
  const removed = left ? null : entityOf(q.data.last_value)
  const entity = left ?? removed
  const head = (
    <p className="text-[11px] text-ink-muted mb-2">
      As of <span className="text-ink-secondary font-medium">{formatUtc(v.created_at)}</span>
      {' · '}{actorName(v.actor ?? undefined, { ...userNames, ...q.data.userNames })}
    </p>
  )
  if (!entity) return <>{head}<p className="text-[11px] text-ink-muted italic">Deleted in this revision — what it held is no longer on record.</p></>
  const fields = namedFields(entity, line.kind)
  const props = userProperties(entity.properties)
  return (
    <div>
      {head}
      {removed && (
        <div role="note" className="mb-2.5 flex items-center gap-2 flex-wrap rounded-xl border border-rose-500/25 bg-rose-500/[0.05] px-3 py-2">
          <Trash2 className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden />
          <span className="text-[11.5px] text-ink flex-1 min-w-[10rem]">
            Deleted in this revision. This is what it held just before.
          </span>
          <CopyValues entity={removed} />
          {onRestore && (
            <button type="button" onClick={onRestore}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold text-white bg-accent-lineage hover:bg-accent-lineage/90">
              <RotateCcw className="w-3 h-3" aria-hidden />
              Restore it
            </button>
          )}
        </div>
      )}
      {fields.length > 0 && (
        <dl className="mb-2.5 divide-y divide-black/[0.05] dark:divide-white/[0.06] rounded-xl border border-glass-border bg-black/[0.012] dark:bg-white/[0.02] px-2.5">
          {fields.map((f) => (
            <div key={f.label} className="flex items-start gap-3 py-1.5">
              <dt className="w-[34%] max-w-[160px] shrink-0 text-[11px] text-ink-muted pt-0.5">{f.label}</dt>
              <dd className="min-w-0 flex-1"><RichValue value={f.value} fieldKey={f.label} /></dd>
            </div>
          ))}
        </dl>
      )}
      {Object.keys(props).length > 0
        ? <PropertyEditor value={props} onChange={() => {}} readOnly groupByPath bare />
        : <p className="text-[11px] text-ink-muted">No properties.</p>}
    </div>
  )
}

/** This revision against the entity now (on the line being read): what has changed since. */
function ComparedWithNow({ entityId, v, line }: { entityId: string; v: EntityRevision; line: Line }) {
  const then = useEntityRevision(line.wsId, line.graphId, entityId, v.id, { branchId: line.branchId, kind: line.kind })
  const now = useEntitySummary(line.wsId, line.graphId, entityId, { branchId: line.branchId, kind: line.kind, includeValue: true })
  const fields = useMemo(() => (then.data && now.data
    ? entityFieldChanges(entityOf(then.data.value) ?? undefined, entityOf(now.data.value) ?? undefined, line.kind)
    : []), [then.data, now.data, line.kind])
  if (then.isLoading || now.isLoading) return <Pending what="it then and now" />
  if (then.isError || now.isError || !then.data || !now.data) {
    return <Failed what="it then and now" retry={() => { void then.refetch(); void now.refetch() }} />
  }
  const wasThere = !!entityOf(then.data.value)
  const isThere = !!entityOf(now.data.value)
  if (fields.length === 0) return <p className="text-[11px] text-ink-muted py-1">Identical to now — nothing has changed since.</p>
  const status: ChangeStatus = !wasThere ? 'added' : !isThere ? 'removed' : 'modified'
  const change: GraphChange = {
    entityId, kind: line.kind, status, label: entityId, origin: { source: 'commit', commitId: v.commit_id },
  }
  return (
    <div>
      <p className="text-[11px] text-ink-muted mb-1.5">
        Since this revision · <span className="text-ink-secondary">then → now</span>
      </p>
      <EntityDiff change={change} fields={fields} depth="all" />
    </div>
  )
}

function Revision({ entityId, v, dotCls, userNames, rows, line, onRestore }: {
  entityId: string
  v: EntityRevision
  dotCls: string
  userNames?: Record<string, string>
  rows: ExpandableRows<string>
  line?: Line
  onRestore?: () => void
}) {
  const op = OP_META[v.op] ?? OP_META.update
  const tone = CHANGE_TONE[op.status]
  const fields = useMemo(() => fromRevisionChanges(v.changes ?? []), [v.changes])
  const summary = useMemo(() => summarizeFields(fields), [fields])
  const [view, setView] = useState<View>('changes')
  const level = rows.levelOf(v.id)
  const open = level > 0
  const kind: Kind = line?.kind ?? 'node'
  const change: GraphChange = {
    entityId, kind, status: op.status, label: entityId, origin: { source: 'commit', commitId: v.commit_id },
  }
  const commitKind = v.commit_kind && SAYS_KIND.has(v.commit_kind) ? kindMeta(v.commit_kind) : null
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
          <Actor actor={v.actor} userNames={userNames} />
          <span aria-hidden>·</span>
          <HoverTip label={formatUtc(v.created_at)} className="inline-flex">
            <span>{timeAgo(v.created_at)}</span>
          </HoverTip>
          {commitKind && (
            <span className={cn('px-1.5 py-px rounded text-[10px] font-semibold', commitKind.cls)}>{commitKind.label}</span>
          )}
          {v.after_branch_point && (
            <span className="px-1.5 py-px rounded text-[10px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300">
              after your draft began
            </span>
          )}
        </span>
        {v.commit_message && (
          <span className={cn('block mt-0.5 pl-[18px] text-[11.5px] text-ink break-words', !open && 'line-clamp-2')}>{v.commit_message}</span>
        )}
        {v.change_reason && (
          <span className={cn('block mt-0.5 pl-[18px] text-[11px] text-ink-muted break-words', !open && 'line-clamp-1')}>
            Why: {v.change_reason}
          </span>
        )}
        {v.changes !== null && (
          <span className="block mt-0.5 pl-[18px]">
            <ChangeSummary summary={summary} status={op.status} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 pl-[18px] space-y-2">
          {line && (
            <Segmented label="Show this revision" options={VIEWS} value={view} onChange={setView} />
          )}
          {view === 'then' && line ? (
            <AsItWas entityId={entityId} v={v} line={line} userNames={userNames} onRestore={v.op === 'delete' ? onRestore : undefined} />
          ) : view === 'now' && line ? (
            <ComparedWithNow entityId={entityId} v={v} line={line} />
          ) : v.changes === null ? (
            <p className="text-[11px] text-ink-muted italic">What this revision changed is no longer on record.</p>
          ) : (
            <EntityDiff change={change} fields={fields} depth={level === 1 ? 'key' : 'all'}
              onShowAll={() => rows.setLevel(v.id, 2)} />
          )}
        </div>
      )}
    </li>
  )
}

function Timeline({ entityId, rows, dotCls, userNames, expand, line, onRestore }: {
  entityId: string
  rows: EntityRevision[]
  dotCls: string
  userNames?: Record<string, string>
  expand: ExpandableRows<string>
  line?: Line
  onRestore?: () => void
}) {
  // A heading wherever the day changes.
  const items: ReactNode[] = []
  let day = ''
  for (const v of rows) {
    const d = dayLabel(v.created_at)
    if (d !== day) {
      day = d
      items.push(
        <li key={`day-${v.id}`} aria-hidden className="-ml-4 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80">{d}</li>,
      )
    }
    // Only the latest deletion is brought back: an earlier one was undone already.
    items.push(<Revision key={v.id} entityId={entityId} v={v} dotCls={dotCls} userNames={userNames} rows={expand} line={line}
      onRestore={v === rows[0] ? onRestore : undefined} />)
  }
  return <ol className="relative ml-1.5 border-l border-glass-border space-y-2.5 pl-4">{items}</ol>
}

export function EntityHistory({
  wsId,
  graphId,
  entityId,
  mainBranchId,
  branchId,
  kind,
  onRestore,
}: {
  wsId: string
  graphId: string
  entityId: string
  mainBranchId?: string | null
  /** Active draft branch — its unmerged revisions for this entity are shown above the published ones. */
  branchId?: string | null
  kind?: Kind
  /** Bring a deleted entity back (in a draft, where the canvas can): offered on its deletion. */
  onRestore?: () => void
}) {
  const draftId = branchId && branchId !== mainBranchId ? branchId : null
  const q = useEntityHistoryPages(wsId, graphId, entityId, { branchId: draftId, kind })
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.versions) ?? [], [q.data])
  const userNames = useMemo(
    () => Object.assign({}, ...(q.data?.pages.map((p) => p.userNames ?? {}) ?? [])) as Record<string, string>,
    [q.data],
  )
  // What the server says the entity is, when it was not told.
  const resolvedKind: Kind = kind ?? (q.data?.pages[0]?.kind === 'edge' ? 'edge' : 'node')
  const line = useMemo<Line>(() => ({ wsId, graphId, branchId: draftId, kind: resolvedKind }), [wsId, graphId, draftId, resolvedKind])
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
    return <p className="text-[11px] text-ink-muted py-3">No history for this {resolvedKind === 'edge' ? 'relationship' : 'entity'} yet.</p>
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
          <Timeline entityId={entityId} rows={draftRows} dotCls="bg-amber-500" userNames={userNames} expand={expand} line={line} onRestore={onRestore} />
        </div>
      )}
      {publishedRows.length > 0 && (
        <div className="space-y-2">
          {draftRows.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Published</div>
          )}
          <Timeline entityId={entityId} rows={publishedRows} dotCls="bg-accent-lineage" userNames={userNames} expand={expand} line={line}
            onRestore={draftRows.length === 0 ? onRestore : undefined} />
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
