/**
 * Delete layer… — a column taken out of the view, said exactly before anything happens.
 *
 *   • "Remove the column — keep its entities" (the default): a VIEW change. Each entity it shows
 *     then shows where its parent or a type column puts it, or not in the view at all — named, one
 *     line per place; what was placed there by hand loses that place; its groups go with it.
 *   • "Also delete its entities from the data": a DATA change, counted first — the entities, what
 *     is inside them and their relationships, as the delete-impact read says — with who it reaches,
 *     and staged in the draft for Review & Save. An entity new in this draft has its create
 *     discarded instead.
 *
 * A column that IS an entity offers to keep that entity, or to delete it with everything inside it.
 * An empty one is a plain confirm. Kept mounted (a closed Radix dialog never strands a click
 * shield): open while `plan` is set.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  CircleSlash, Columns3, CornerLeftUp, CopyPlus, Hand, Layers, Lock, Sigma, Sparkles, Trash2, Waypoints, type LucideIcon,
} from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { mapWithConcurrency } from '@/lib/concurrency'
import { useBranchStore } from '@/store/branchStore'
import { usePersonaMode } from '@/store/persona'
import { getDeleteImpact, type DeleteImpact } from '@/services/versioningApiService'
import { ChangeKindTag } from './DropHint'
import { reachNote, type DataReach } from './changeKind'
import {
  alsoLine, countLine, deleteDataLabel, deleteTotals, newLine, stagedDeleteNote, type ImpactLine,
} from './columnDelete'

export interface DeleteColumnPlan {
  layerId: string
  /** The column, by the name it shows. */
  name: string
  /** The entity the column is, by name — when it is one. */
  mapped?: string
  /** How many entities it shows at its top level. None, and nothing placed in it: a plain confirm. */
  count: number
  empty: boolean
  /** What removing it does with what it shows, line by line. */
  keep: ImpactLine[]
  /** Deleting them from the data: why it can't be done here, or what it takes. */
  data:
    | { blocked: string }
    | {
      /** Saved entities, whose deletes are staged (their impact read first). */
      saved: string[]
      /** Entities new in this draft, whose creates are discarded instead, and what is loaded inside them. */
      fresh: { count: number; inside: number }
      /** Inside them, but drawn in another column. */
      also: Array<{ name: string; column: string }>
    }
}

/** Every saved entity's delete impact, read when the dialog opens — what the counts say, and what
 *  each staged delete then carries to Review & Save. Uncounted where the draft has no graph to ask,
 *  or a read fails: the delete still takes everything inside them. */
function useDeleteImpacts(urns: readonly string[] | null): { impacts: ReadonlyMap<string, DeleteImpact>; counting: boolean; complete: boolean } {
  const key = urns ? urns.join('\n') : null
  const ws = useBranchStore((s) => s.workspaceId)
  const ds = useBranchStore((s) => s.dataSourceId)
  const branch = useBranchStore((s) => s.currentBranchId)
  const graph = useBranchStore((s) => s.graphId)
  const readable = !!(ws && ds && branch && graph)
  const [read, setRead] = useState<{ key: string; impacts: ReadonlyMap<string, DeleteImpact>; complete: boolean } | null>(null)
  useEffect(() => {
    if (!key || !ws || !ds || !branch || !graph) return
    const list = key.split('\n')
    let live = true
    void mapWithConcurrency(list, DELETE_IMPACT_READS, (urn) => getDeleteImpact(ws, ds, branch, urn)).then((results) => {
      if (!live) return
      const impacts = new Map<string, DeleteImpact>()
      results.forEach((r, i) => { if (r.status === 'fulfilled') impacts.set(list[i], r.value) })
      setRead({ key, impacts, complete: impacts.size === list.length })
    })
    return () => { live = false }
  }, [key, ws, ds, branch, graph])
  if (key === null || (key !== '' && !readable)) return { impacts: NO_IMPACTS, counting: false, complete: false }
  // Nothing saved to read: all of it is new in this draft.
  if (key === '') return { impacts: NO_IMPACTS, counting: false, complete: true }
  if (read?.key !== key) return { impacts: NO_IMPACTS, counting: true, complete: false }
  return { impacts: read.impacts, counting: false, complete: read.complete }
}

/** Delete-impact reads at once — as many as a several-entity delete makes (useCanvasInteractions). */
const DELETE_IMPACT_READS = 6
const NO_IMPACTS: ReadonlyMap<string, DeleteImpact> = new Map()

const ICON: Record<ImpactLine['kind'], LucideIcon> = {
  parent: CornerLeftUp, column: Columns3, gone: CircleSlash, placed: Hand, groups: Layers,
  count: Sigma, new: Sparkles, also: Waypoints, note: CopyPlus, blocked: Lock,
}

function Lines({ lines, id }: { lines: readonly ImpactLine[]; id?: string }) {
  return (
    <ul id={id} className="mt-2 space-y-1.5">
      {lines.map((line, i) => {
        const Icon = ICON[line.kind]
        return (
          <li key={i} className={cn('flex items-start gap-2 text-[13px] leading-snug',
            line.kind === 'note' || line.kind === 'blocked' ? 'text-ink-muted' : 'text-ink-secondary')}>
            <Icon className={cn('mt-[3px] h-3.5 w-3.5 shrink-0', line.kind === 'gone' || line.kind === 'also' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted')} aria-hidden />
            <span className="min-w-0">{line.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** One of the two answers: a radio card with its kind's tag and what it does. */
function Choice({ kind, title, lines, checked, disabled, reach, onPick, children }: {
  kind: 'view' | 'data'
  title: string
  lines: readonly ImpactLine[]
  checked: boolean
  disabled?: boolean
  reach: DataReach
  onPick: () => void
  children?: ReactNode
}) {
  const id = useId()
  return (
    <label
      data-delete-choice={kind}
      className={cn(
        'block rounded-xl border px-3.5 py-3 transition-colors',
        disabled ? 'cursor-not-allowed border-glass-border/70 bg-black/[0.015] dark:bg-white/[0.02]'
          : checked
            ? kind === 'data'
              ? 'cursor-pointer border-rose-500/50 bg-rose-500/[0.05] ring-1 ring-rose-500/25'
              : 'cursor-pointer border-accent-lineage/50 bg-accent-lineage/[0.06] ring-1 ring-accent-lineage/25'
            : 'cursor-pointer border-glass-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
      )}
    >
      <span className="flex items-start gap-3">
        <input
          type="radio"
          name="delete-column-choice"
          className={cn('mt-[3px] h-4 w-4 shrink-0', kind === 'data' ? 'accent-rose-600' : 'accent-[rgb(var(--nx-accent-lineage-rgb))]')}
          checked={checked}
          disabled={disabled}
          onChange={onPick}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-lines`}
        />
        <span className={cn('min-w-0 flex-1', disabled && 'opacity-75')}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span id={`${id}-title`} className="text-sm font-semibold text-ink">{title}</span>
            <ChangeKindTag kind={kind} reach={reach} />
          </span>
          <Lines lines={lines} id={`${id}-lines`} />
          {children}
        </span>
      </span>
    </label>
  )
}

export function DeleteColumnDialog({ plan, reach, onRemove, onDeleteData, onClose }: {
  plan: DeleteColumnPlan | null
  /** Who a data delete reaches. */
  reach: DataReach
  /** Remove the column, keep its entities — a view change. */
  onRemove: () => void
  /** Remove it and delete its entities from the data, with the impacts read. */
  onDeleteData: (impacts: ReadonlyMap<string, DeleteImpact>) => void
  onClose: () => void
}) {
  const persona = usePersonaMode()
  const open = !!plan
  const data = plan && !('blocked' in plan.data) ? plan.data : null
  // Each opening starts on the default — keep the entities — whatever was picked the last time.
  const [picked, setPicked] = useState<{ layerId: string | null; choice: 'view' | 'data' }>({ layerId: null, choice: 'view' })
  const choice = plan && picked.layerId === plan.layerId ? picked.choice : 'view'
  const setChoice = (next: 'view' | 'data') => setPicked({ layerId: plan?.layerId ?? null, choice: next })
  const close = () => { setPicked({ layerId: null, choice: 'view' }); onClose() }
  const read = useDeleteImpacts(open && data && !plan.empty ? data.saved : null)

  const dataLines = useMemo((): ImpactLine[] => {
    if (!plan) return []
    if ('blocked' in plan.data) return [{ kind: 'blocked', text: plan.data.blocked }]
    const d = plan.data
    const counted = read.complete ? deleteTotals(d.saved, read.impacts, d.fresh) : null
    return [
      read.counting ? { kind: 'count', text: 'Counting what’s inside…' } : countLine(counted, d.saved.length + d.fresh.count, plan.mapped),
      ...newLine(d.fresh.count, plan.mapped),
      ...alsoLine(d.also, d.saved.length + d.fresh.count, !!plan.mapped),
      stagedDeleteNote(reach),
    ]
  }, [plan, read, reach])

  const note = reach.otherViews > 0 ? reachNote(reach, persona) : undefined
  const deleting = choice === 'data' && !!data
  const confirmLabel = !plan ? '' : plan.empty ? 'Delete column'
    : deleting ? deleteDataLabel(data.saved.length + data.fresh.count, plan.mapped) : 'Remove column'
  const description = !plan ? undefined
    : plan.empty ? 'Nothing is in it — only the column goes.'
      : plan.mapped ? `The column is ${plan.mapped}: its rows are what’s inside it. Choose what happens to ${plan.mapped}.`
        : `Choose what happens to the ${plan.count.toLocaleString()} ${plan.count === 1 ? 'entity' : 'entities'} it shows.`

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) close() }}
      title={plan ? `Delete the ${plan.name} column` : 'Delete a column'}
      description={description}
      icon={(
        <span className="grid place-items-center w-9 h-9 rounded-xl bg-rose-500/12 text-rose-600 dark:text-rose-400">
          <Trash2 className="w-4 h-4" aria-hidden />
        </span>
      )}
      footer={plan && (
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant={deleting || plan.empty ? 'danger' : 'primary'}
            disabled={deleting && read.counting}
            onClick={() => {
              const impacts = read.impacts
              close()
              if (deleting) onDeleteData(impacts)
              else onRemove()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {plan && (plan.empty ? (
        <div className="space-y-2">
          <ChangeKindTag kind="view" />
          {plan.keep.length > 0 && <Lines lines={plan.keep} />}
        </div>
      ) : (
        <div role="radiogroup" aria-label={`What happens to what ${plan.name} shows`} className="space-y-2.5">
          <Choice
            kind="view"
            title={plan.mapped ? `Remove the column — keep ${plan.mapped} in the data` : 'Remove the column — keep its entities'}
            lines={plan.keep}
            checked={choice === 'view'}
            reach={reach}
            onPick={() => setChoice('view')}
          />
          <Choice
            kind="data"
            title={plan.mapped ? `Delete ${plan.mapped} and everything inside it` : 'Also delete its entities from the data'}
            lines={dataLines}
            checked={choice === 'data'}
            disabled={!data}
            reach={reach}
            onPick={() => setChoice('data')}
          >
            {data && note && <p className="mt-1.5 pl-[22px] text-xs text-ink-muted">{note}</p>}
          </Choice>
        </div>
      ))}
    </Dialog>
  )
}
