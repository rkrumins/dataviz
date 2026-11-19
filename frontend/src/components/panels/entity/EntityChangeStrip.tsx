/**
 * EntityChangeStrip — the entity drawer's footer while it holds an edit: where the edit stands,
 * and the way on. There is no "Stage" step: every committed edit is staged as it is made.
 *
 * - Typing in a field: Enter (or leaving it) stages it, Esc puts it back.
 * - Changes staged on this entity: how many fields, Revert (the whole entity back as it was read —
 *   undoable), and Review & Save, which saves every staged change to the draft and can publish.
 */
import { useMemo } from 'react'
import { CheckCircle2, PencilLine, Undo2 } from 'lucide-react'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { stagedIndexOf } from '@/store/stagedIndex'
import { nodeUpdatePatch } from '@/features/versioning/model/stagedChangesToOps'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { Kbd } from '@/components/ui/Kbd'
import { cn } from '@/lib/utils'

/** How many fields a staged node edit changes, as the save will send them. */
export function changedFieldCount(change: StagedChange | undefined): number {
  if (!change) return 0
  const { payload, unset } = nodeUpdatePatch(change.before, change.after)
  const props = (payload.properties as Record<string, unknown> | undefined) ?? {}
  return Object.keys(payload).filter((k) => k !== 'properties').length + Object.keys(props).length + unset.length
}

export function useStagedNodeEdit(nodeId: string): StagedChange | undefined {
  return useStagedChangesStore((s) => stagedIndexOf(s.changes).nodeEdit.get(nodeId))
}

export function EntityChangeStrip({ nodeId, dirty, justStaged, onCancel }: {
  nodeId: string
  /** A field holds typing not staged yet. */
  dirty: boolean
  /** An edit was staged a moment ago — say so. */
  justStaged: boolean
  /** Put back what is being typed. */
  onCancel: () => void
}) {
  const staged = useStagedNodeEdit(nodeId)
  const total = useStagedChangesStore((s) => s.changes.length)
  const saving = useStagedChangesStore((s) => s.applyStatus === 'applying')
  const fields = useMemo(() => changedFieldCount(staged), [staged])

  if (dirty) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span role="status" className="min-w-0 flex items-center gap-2 text-xs text-ink-secondary">
          <PencilLine className="w-3.5 h-3.5 shrink-0 text-amber-500" aria-hidden />
          <span className="truncate">Editing — <Kbd shortcut="enter" /> stages it, <Kbd shortcut="esc" /> puts it back</span>
        </span>
        <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>Cancel</Button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span role="status" className="min-w-0 flex items-center gap-2 text-xs">
        <span className={cn(
          'relative flex items-center justify-center w-6 h-6 rounded-full shrink-0',
          staged ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
        )}>
          {justStaged && <span className="absolute inset-0 rounded-full bg-emerald-500/25 animate-ping" aria-hidden />}
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block font-semibold text-ink truncate">
            {staged
              ? `${fields || 1} change${fields === 1 ? '' : 's'} staged`
              : 'Click any value to edit it'}
          </span>
          <span className="block text-[11px] text-ink-muted truncate">
            {staged ? 'Not saved yet' : 'Each change is staged as you make it'}
          </span>
        </span>
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {staged && (
          <HoverTip label="Revert this entity" detail="Puts every field back as it was read. Undo brings your edits back." className="inline-flex">
            <Button variant="ghost" size="sm" leftIcon={Undo2} disabled={saving}
              onClick={() => useStagedChangesStore.getState().discard(staged.id)}>
              Revert
            </Button>
          </HoverTip>
        )}
        {total > 0 && (
          <HoverTip label={`Review and save ${total} staged change${total === 1 ? '' : 's'}`}
            detail="Save to your draft — then publish, or keep editing" className="inline-flex">
            <Button variant="primary" size="sm" onClick={() => useStagedChangesStore.getState().openReviewPanel()}>
              Review &amp; Save
              <span aria-hidden className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-md bg-white/25 text-[10px] font-bold tabular-nums flex items-center justify-center">
                {total}
              </span>
            </Button>
          </HoverTip>
        )}
      </div>
    </div>
  )
}
