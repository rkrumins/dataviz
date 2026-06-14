/**
 * EntityHistory — the revision history of a single entity (node), in two groups:
 *   • In this draft — the active draft branch's own commits for this entity that aren't merged yet
 *     (shown first, amber, so you can see exactly what you changed in your branch — req: branch work
 *     must be visible per entity, not only after merge);
 *   • Published — the canonical `main` line ("the published history of this entity").
 *
 * The backend (entity_history) returns versions across ALL branches; we split by branch here and
 * diff each version against its predecessor WITHIN its own branch (the draft's first edit diffs
 * against the main base it branched from), reusing the same EntityDiff table the overlay uses.
 */
import { useMemo, type ComponentType } from 'react'
import { Loader2, Plus, Pencil, Trash2, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useBranches, useEntityHistory } from '../hooks/useVersioning'
import { deriveFieldDeltas, labelForPayload, type GraphChange } from '../model/changeModel'
import { EntityDiff } from './EntityDiff'

const who = (a?: unknown) => (typeof a === 'string' && a ? a.split('@')[0] : 'system')

type Version = {
  commit_id?: string
  commit_seq?: number
  branch_id?: string
  op?: 'create' | 'update' | 'delete'
  actor?: string
  created_at?: string
  payload?: Record<string, unknown> | null
}

type Row = { v: Version; change: GraphChange }

const OP_META: Record<string, { label: string; cls: string; Icon: ComponentType<{ className?: string }> }> = {
  create: { label: 'created', cls: 'text-emerald-500', Icon: Plus },
  update: { label: 'updated', cls: 'text-amber-500', Icon: Pencil },
  delete: { label: 'deleted', cls: 'text-rose-500', Icon: Trash2 },
}

/** Diff each version against its predecessor within one branch (first against `base`), newest-first. */
function buildChain(entityId: string, versions: Version[], base: Record<string, unknown> | undefined): Row[] {
  const asc = [...versions].sort((a, b) => (a.commit_seq ?? 0) - (b.commit_seq ?? 0))
  const rows = asc.map((v, i) => {
    const prev = i === 0 ? base : asc[i - 1].payload ?? undefined
    const cur = v.payload ?? undefined
    const status: GraphChange['status'] = v.op === 'create' ? 'added' : v.op === 'delete' ? 'removed' : 'modified'
    const change: GraphChange = {
      entityId,
      kind: 'node',
      status,
      label: labelForPayload(entityId, cur ?? prev, 'node'),
      fields: status === 'modified' ? deriveFieldDeltas(prev, cur) : undefined,
      before: status === 'removed' ? prev : undefined,
      after: status === 'added' ? cur : undefined,
      origin: { source: 'commit', commitId: v.commit_id ?? '' },
    }
    return { v, change }
  })
  return rows.reverse()
}

function Timeline({ rows, dotCls }: { rows: Row[]; dotCls: string }) {
  return (
    <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
      {rows.map(({ v, change }) => {
        const op = OP_META[v.op ?? 'update'] ?? OP_META.update
        return (
          <li key={v.commit_id ?? v.commit_seq} className="relative">
            <span className={cn('absolute -left-[1.36rem] top-1 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', dotCls)} />
            <p className="text-[11px] text-ink-muted flex items-center gap-1.5 flex-wrap">
              <op.Icon className={cn('w-3 h-3', op.cls)} />
              <span className={cn('font-medium', op.cls)}>{op.label}</span>
              <span>by {who(v.actor)}</span>
              <span>·</span>
              <span>{v.created_at ? timeAgo(v.created_at) : ''}</span>
            </p>
            <div className="mt-1.5">
              <EntityDiff change={change} />
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
}: {
  wsId: string
  graphId: string
  entityId: string
  mainBranchId?: string | null
  /** Active draft branch — its unmerged commits for this entity are shown above the published ones. */
  branchId?: string | null
}) {
  const q = useEntityHistory(wsId, graphId, entityId)
  // The draft branched from main at base_commit_seq — needed so the first draft edit diffs against
  // the value the author actually started from, not main's current head (which may have advanced on
  // this entity after the branch opened). Cached; shared with the switcher/bar.
  const branchesQ = useBranches(wsId, graphId)
  const baseSeq = useMemo(() => {
    if (!branchId || branchId === mainBranchId) return null
    const b = (branchesQ.data ?? []).find((x) => x.branchId === branchId)
    return b?.baseCommitSeq ?? null
  }, [branchesQ.data, branchId, mainBranchId])

  const { draftRows, publishedRows } = useMemo(() => {
    const all = (q.data?.versions ?? []) as Version[]
    const onDraft = !!branchId && branchId !== mainBranchId
    const mainVersions = mainBranchId ? all.filter((v) => v.branch_id === mainBranchId) : all
    const draftVersions = onDraft ? all.filter((v) => v.branch_id === branchId) : []
    // The draft's first edit started from main's value AT the branch point (base_commit_seq) — pick
    // the latest main version at/below it; fall back to main's head when the base seq is unknown.
    const mainAsc = [...mainVersions].sort((a, b) => (a.commit_seq ?? 0) - (b.commit_seq ?? 0))
    const eligible = baseSeq == null ? mainAsc : mainAsc.filter((v) => (v.commit_seq ?? 0) <= baseSeq)
    const draftBase = eligible.length ? eligible[eligible.length - 1].payload ?? undefined : undefined
    return {
      publishedRows: buildChain(entityId, mainVersions, undefined),
      draftRows: buildChain(entityId, draftVersions, draftBase),
    }
  }, [q.data, mainBranchId, branchId, entityId, baseSeq])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-muted py-3 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    )
  }
  if (draftRows.length === 0 && publishedRows.length === 0) {
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
          <Timeline rows={draftRows} dotCls="bg-amber-500" />
        </div>
      )}
      {publishedRows.length > 0 && (
        <div className="space-y-2">
          {draftRows.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">Published</div>
          )}
          <Timeline rows={publishedRows} dotCls="bg-accent-lineage" />
        </div>
      )}
      {publishedRows.length === 0 && draftRows.length > 0 && (
        <p className="text-[11px] text-ink-muted/70">Not yet on main — these changes are only in your draft.</p>
      )}
    </div>
  )
}
