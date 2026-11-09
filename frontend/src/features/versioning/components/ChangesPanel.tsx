/**
 * ChangesPanel — the one structured view of "what changed", driven by a `ChangeSet`.
 *
 * Whatever the source — your uncommitted staged edits, a draft's diff vs main, or a
 * single commit — this renders the same grouped, expandable list (Entities /
 * Relationships × Added / Modified / Removed). It elevates the visual grammar of the
 * old GraphChangesReviewDialog but is fully source-agnostic. When the changes are
 * staged (discardable), each row gets a Discard affordance.
 */
import { useCallback, useMemo, useState } from 'react'
import { ChevronRight, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { ChangeKind, ChangeSet, ChangeStatus, GraphChange } from '../model/changeModel'
import { STATUS_META, NodeDiffBadge } from './NodeDiffBadge'
import { EntityDiff } from './EntityDiff'
import { edgeEnds } from '../canvas/deletionGhosts'

/** An entity by name where the change set has it, else the end of its id. */
type NameOf = (id: string) => string
const idTail = (id: string) => (id.length > 24 ? `…${id.slice(-22)}` : id)

const STATUS_ORDER: ChangeStatus[] = ['added', 'modified', 'removed']
const KIND_TITLE: Record<ChangeKind, string> = { node: 'Entities', edge: 'Relationships' }
/** Rows a status group draws before "Show more": a 20,000-change set draws a page, not 200,000
 *  elements. A set past the tree's cap is a change list (ChangeList) instead. */
const ROWS_SHOWN = 200

type Grouped = Record<ChangeKind, Record<ChangeStatus, GraphChange[]>>

/** Every change into its kind and status, in one pass. */
function group(changes: GraphChange[]): Grouped {
  const out: Grouped = {
    node: { added: [], modified: [], removed: [] },
    edge: { added: [], modified: [], removed: [] },
  }
  for (const c of changes) out[c.kind][c.status].push(c)
  return out
}

function ChangeRow({
  change,
  onDiscard,
  nameOf,
}: {
  change: GraphChange
  onDiscard?: (stagedChangeId: string) => void
  nameOf: NameOf
}) {
  const [open, setOpen] = useState(false)
  const meta = STATUS_META[change.status]
  // A deleted link says which two entities it joined, not only its type.
  const ends = change.kind === 'edge' && change.status === 'removed' ? edgeEnds(change) : {}
  const label = ends.source && ends.target
    ? `${change.label} · ${nameOf(ends.source)} → ${nameOf(ends.target)}`
    : change.label
  const canDiscard = onDiscard && change.origin.source === 'staged'
  return (
    <div className={cn('rounded-lg border-l-2 bg-canvas-overlay/40', meta.accent)}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left group"
        >
          <ChevronRight
            className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')}
          />
          <meta.Icon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} />
          <span className={cn('text-sm text-ink truncate group-hover:text-ink', meta.strike)} title={label}>
            {label}
          </span>
        </button>
        {canDiscard && (
          <HoverTip
            className="inline-flex shrink-0"
            label="Throw this edit away"
            detail="Only this one — everything else stays staged"
          >
            <button
              onClick={() => onDiscard!((change.origin as { stagedChangeId: string }).stagedChangeId)}
              aria-label="Discard this change"
              className="p-1 rounded-md text-ink-muted/60 hover:text-rose-500 hover:bg-rose-500/10 transition-colors shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
        )}
      </div>
      {open && (
        <div className="px-2.5 pb-2 pl-7">
          <EntityDiff change={change} />
        </div>
      )}
    </div>
  )
}

function StatusRows({
  items,
  onDiscard,
  nameOf,
}: {
  items: GraphChange[]
  onDiscard?: (stagedChangeId: string) => void
  nameOf: NameOf
}) {
  const [shown, setShown] = useState(ROWS_SHOWN)
  const rest = items.length - shown
  return (
    <div className="space-y-1">
      {items.slice(0, shown).map((c) => (
        <ChangeRow key={c.entityId} change={c} onDiscard={onDiscard} nameOf={nameOf} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setShown((n) => n + ROWS_SHOWN)}
          className="w-full text-left px-2.5 py-1 text-[11.5px] font-medium text-accent-lineage hover:underline"
        >
          Show {Math.min(rest, ROWS_SHOWN).toLocaleString()} more of {rest.toLocaleString()}
        </button>
      )}
    </div>
  )
}

function KindGroup({
  kind,
  byStatus,
  onDiscard,
  nameOf,
}: {
  kind: ChangeKind
  byStatus: Record<ChangeStatus, GraphChange[]>
  onDiscard?: (stagedChangeId: string) => void
  nameOf: NameOf
}) {
  if (STATUS_ORDER.every((s) => byStatus[s].length === 0)) return null
  return (
    <div>
      <p className="text-[10px] font-semibold text-ink-muted/80 uppercase tracking-wider mb-1.5">
        {KIND_TITLE[kind]}
      </p>
      <div className="space-y-2.5">
        {STATUS_ORDER.map((status) => {
          const items = byStatus[status]
          if (items.length === 0) return null
          const meta = STATUS_META[status]
          return (
            <div key={status} className={cn('rounded-xl border px-2.5 py-2', meta.bg, meta.border)}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className={cn('text-[11px] font-semibold uppercase tracking-wider', meta.text)}>
                  {meta.label}
                </span>
                <span className="text-[11px] text-ink-muted tabular-nums">{items.length.toLocaleString()}</span>
              </div>
              <StatusRows items={items} onDiscard={onDiscard} nameOf={nameOf} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ChangesPanel({
  changeSet,
  onDiscard,
  className,
  emptyHint = 'No changes yet.',
}: {
  changeSet: ChangeSet
  /** Provided only for staged (discardable) change sets. */
  onDiscard?: (stagedChangeId: string) => void
  className?: string
  emptyHint?: string
}) {
  const grouped = useMemo(() => group(changeSet.changes), [changeSet])
  const nameOf = useCallback<NameOf>((id) => changeSet.byEntityId.get(id)?.label ?? idTail(id), [changeSet])

  if (changeSet.changes.length === 0) {
    return (
      <div className={cn('py-10 text-center', className)}>
        <p className="text-sm text-ink-muted">{emptyHint}</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', className)}>
      <KindGroup kind="node" byStatus={grouped.node} onDiscard={onDiscard} nameOf={nameOf} />
      <KindGroup kind="edge" byStatus={grouped.edge} onDiscard={onDiscard} nameOf={nameOf} />
    </div>
  )
}

/** Compact inline summary of a ChangeSet's counts — for banners / headers. */
export function ChangeCountChips({ changeSet }: { changeSet: ChangeSet }) {
  const { counts } = changeSet
  return (
    <span className="inline-flex items-center gap-1">
      {counts.added > 0 && <NodeDiffBadge status="added" count={counts.added} />}
      {counts.modified > 0 && <NodeDiffBadge status="modified" count={counts.modified} />}
      {counts.removed > 0 && <NodeDiffBadge status="removed" count={counts.removed} />}
    </span>
  )
}
