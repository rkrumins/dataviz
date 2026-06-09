/**
 * EntityHistory — the revision history of a single entity (node): each published revision's
 * operation, author, when, and field-level what-changed. Powered by the per-entity history
 * endpoint (useEntityHistory). Scoped to the canonical `main` line so it reads as "the published
 * history of this entity"; in-progress draft edits live in the Changes panel.
 *
 * Each revision's "what changed" reuses the same EntityDiff table the diff overlay/timeline use:
 * for an update we diff the payload against the previous main version (deriveFieldDeltas).
 */
import { useMemo, type ComponentType } from 'react'
import { Loader2, Plus, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useEntityHistory } from '../hooks/useVersioning'
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

const OP_META: Record<string, { label: string; cls: string; Icon: ComponentType<{ className?: string }> }> = {
  create: { label: 'created', cls: 'text-emerald-500', Icon: Plus },
  update: { label: 'updated', cls: 'text-amber-500', Icon: Pencil },
  delete: { label: 'deleted', cls: 'text-rose-500', Icon: Trash2 },
}

export function EntityHistory({
  wsId,
  graphId,
  entityId,
  mainBranchId,
}: {
  wsId: string
  graphId: string
  entityId: string
  mainBranchId?: string | null
}) {
  const q = useEntityHistory(wsId, graphId, entityId)

  // Keep the canonical main line, sort ascending to diff each version against its predecessor,
  // then present newest-first.
  const rows = useMemo(() => {
    const all = (q.data?.versions ?? []) as Version[]
    const mainline = mainBranchId ? all.filter((v) => v.branch_id === mainBranchId) : all
    const asc = [...mainline].sort((a, b) => (a.commit_seq ?? 0) - (b.commit_seq ?? 0))
    const built = asc.map((v, i) => {
      const prev = asc[i - 1]?.payload ?? undefined
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
    return built.reverse()
  }, [q.data, mainBranchId, entityId])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-muted py-3 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading history…
      </div>
    )
  }
  if (rows.length === 0) {
    return <p className="text-[11px] text-ink-muted py-3">No published history for this entity yet.</p>
  }

  return (
    <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
      {rows.map(({ v, change }) => {
        const op = OP_META[v.op ?? 'update'] ?? OP_META.update
        return (
          <li key={v.commit_id ?? v.commit_seq} className="relative">
            <span className="absolute -left-[1.36rem] top-1 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
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
