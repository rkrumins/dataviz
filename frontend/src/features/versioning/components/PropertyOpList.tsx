/**
 * PropertyOpList — a draft's property operations: the one under way with its progress and Stop,
 * and the finished ones with what they did and Undo. `compact` (the Properties tab) shows the
 * latest few; the versioning panel shows them all.
 */
import { CheckCircle2, CircleSlash, Loader2, Square, Undo2, XCircle } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/lib/utils'
import type { PropertyOpJob, PropertyOpList as OpList } from '@/services/versioningApiService'

import { useCancelPropertyOp, useUndoPropertyOp } from '../hooks/useVersioning'
import { canUndo, isLive, opLabel, opOutcome } from '../model/propertyOps'

const COMPACT_SHOWN = 3

const PHASE: Record<NonNullable<PropertyOpJob['phase']>, string> = {
  queued: 'Queued',
  waiting: 'Waiting for the published graph to catch up',
  finding: 'Finding matches',
  applying: 'Applying',
}

export function PropertyOpList({ wsId, graphId, branchId, list, compact = false }: {
  wsId: string
  graphId: string
  branchId: string
  list?: OpList
  compact?: boolean
}) {
  const cancel = useCancelPropertyOp(wsId, graphId, branchId)
  const undo = useUndoPropertyOp(wsId, graphId, branchId)
  const { notify } = useAppNotifications()
  if (!list || list.ops.length === 0) return null
  const ops = compact ? list.ops.slice(0, COMPACT_SHOWN) : list.ops
  const refused = (e: unknown) => notify('error', (e as Error).message)

  return (
    <ul className="flex flex-col gap-1.5" aria-label="Property operations">
      {ops.map((op) => (
        <OpRow
          key={op.jobId}
          op={op}
          undone={!!op.undoneBy && list.ops.some((o) => o.jobId === op.undoneBy && o.status === 'completed')}
          onStop={isLive(op) && !op.cancelRequested
            ? () => cancel.mutate(op.jobId, { onError: refused }) : undefined}
          onUndo={canUndo(op, list)
            ? () => undo.mutate(op.jobId, { onError: refused }) : undefined}
          busy={cancel.isPending || undo.isPending}
        />
      ))}
      {compact && list.ops.length > ops.length && (
        <li className="px-2 text-[10.5px] text-ink-muted">
          {list.ops.length - ops.length} earlier in this draft's Changes
        </li>
      )}
    </ul>
  )
}

function OpRow({ op, undone, onStop, onUndo, busy }: {
  op: PropertyOpJob
  undone: boolean
  onStop?: () => void
  onUndo?: () => void
  busy: boolean
}) {
  const live = isLive(op)
  const label = op.kind === 'undo' ? `Undo: ${opLabel(op.op)}` : opLabel(op.op)
  const Icon = live ? Loader2 : op.status === 'completed' ? CheckCircle2
    : op.status === 'failed' ? XCircle : CircleSlash
  return (
    <li className="flex flex-col gap-1 px-2.5 py-2 rounded-lg border border-glass-border bg-canvas-elevated">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn(
          'w-3.5 h-3.5 shrink-0',
          live ? 'animate-spin text-accent-lineage'
            : op.status === 'completed' ? 'text-emerald-500'
              : op.status === 'failed' ? 'text-rose-500' : 'text-ink-muted',
        )} />
        <span className="flex-1 min-w-0 truncate text-[11.5px] font-mono text-ink" title={label}>{label}</span>
        {undone && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-glass text-ink-muted">
            undone
          </span>
        )}
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-medium text-ink-secondary border border-glass-border hover:text-rose-500 hover:border-rose-500/40 transition-colors disabled:opacity-50"
          >
            <Square className="w-2.5 h-2.5" /> Stop
          </button>
        )}
        {onUndo && (
          <HoverTip
            className="shrink-0 inline-flex"
            label="Put back what this changed"
            detail="Only where nothing was edited since — an edit made after it is kept"
          >
            <button
              type="button"
              onClick={onUndo}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-medium text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40 transition-colors disabled:opacity-50"
            >
              <Undo2 className="w-2.5 h-2.5" /> Undo
            </button>
          </HoverTip>
        )}
      </div>
      {live ? (
        <div className="flex flex-col gap-1 pl-5">
          <span className="text-[10.5px] text-ink-muted">
            {op.cancelRequested ? 'Stopping after the part being written…'
              : op.phase === 'applying'
                ? `${PHASE.applying} · ${op.processed.toLocaleString()} of ${op.total.toLocaleString()}`
                : PHASE[op.phase ?? 'queued']}
          </span>
          {op.phase === 'applying' && <ProgressBar value={op.percent} label={label} />}
        </div>
      ) : (
        <span className={cn('pl-5 text-[10.5px]', op.status === 'failed' ? 'text-rose-500' : 'text-ink-muted')}>
          {op.status === 'failed' ? op.error
            : op.status === 'cancelled'
              ? `Stopped${op.summary ? ` — ${opOutcome(op)}` : ' before it changed anything'}`
              : opOutcome(op)}
        </span>
      )}
    </li>
  )
}
