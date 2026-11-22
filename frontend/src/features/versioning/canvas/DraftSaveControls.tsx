/**
 * DraftSaveControls — Undo, Redo and Review & Save, for a canvas without the Context View's header
 * (the Graph and Hierarchy canvases): the way to the save their edits need. The same counts, states
 * and words as the header's (EditorActions), in one compact group. Shown by the canvas in a draft.
 */
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'
import { HoverTip } from '@/components/ui/HoverTip'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

const SEGMENT = 'flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-semibold tracking-tight transition'
const SEGMENT_ON = 'text-ink/85 hover:bg-black/[0.06] hover:text-ink dark:hover:bg-white/[0.06]'
const SEGMENT_OFF = 'text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed'

export function DraftSaveControls({ className }: { className?: string }) {
  const pending = useStagedChangesStore((s) => s.changes.length)
  const pastCount = useStagedChangesStore((s) => s.past.length)
  const redoCount = useStagedChangesStore((s) => s.redoStack.length)
  // Nothing is undone under a save in flight (the ⌘Z shortcut holds the same rule).
  const saving = useStagedChangesStore((s) => s.applyStatus === 'applying')
  // What the draft already holds (saved edits, imports): with nothing staged, Review & Save publishes it.
  const draftChangeCount = useBranchStore((s) => s.activeChangeSet
    ? s.activeChangeSet.counts.added + s.activeChangeSet.counts.modified + s.activeChangeSet.counts.removed : 0)
  const canUndo = !saving && (pending > 0 || pastCount > 0)
  const canRedo = !saving && redoCount > 0
  const store = useStagedChangesStore.getState

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex items-stretch rounded-xl overflow-hidden bg-canvas-elevated border border-glass-border shadow-sm">
        <HoverTip className="flex" label="Undo the last change on the canvas" shortcut={formatShortcut('mod+z')}>
          <button type="button" onClick={() => store().undo()} disabled={!canUndo} aria-label="Undo"
            className={cn(SEGMENT, canUndo ? SEGMENT_ON : SEGMENT_OFF)}>
            <LucideIcons.Undo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
          </button>
        </HoverTip>
        <div className="w-px bg-glass-border" />
        <HoverTip className="flex" label="Put back the change you just undid" shortcut={formatShortcut('mod+shift+z')}>
          <button type="button" onClick={() => store().redo()} disabled={!canRedo} aria-label="Redo"
            className={cn(SEGMENT, canRedo ? SEGMENT_ON : SEGMENT_OFF)}>
            <LucideIcons.Redo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
          </button>
        </HoverTip>
      </div>
      <HoverTip
        className="inline-flex"
        label={pending > 0
          ? `Review and save ${pending} pending change${pending === 1 ? '' : 's'}`
          : draftChangeCount > 0
          ? 'Nothing new to save — publish what’s on this draft'
          : 'No changes yet — edits you make collect here for review'}
        detail={pending > 0
          ? 'Saves to your draft — then publish, or keep editing'
          : draftChangeCount > 0
          ? 'Or send it for review'
          : undefined}
      >
        <button
          type="button"
          onClick={() => store().openReviewPanel()}
          disabled={pending === 0 && draftChangeCount === 0}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold transition duration-300 border shadow-sm',
            pending > 0
              ? 'bg-accent-lineage border-transparent text-white shadow-accent-lineage/30 hover:bg-accent-lineage/90 active:scale-[0.98]'
              : draftChangeCount > 0
              ? 'bg-canvas-elevated border-accent-lineage/30 text-accent-lineage hover:bg-accent-lineage/10 active:scale-[0.98]'
              : 'bg-canvas-elevated border-glass-border text-ink-muted/50 cursor-not-allowed',
          )}
        >
          <LucideIcons.ListChecks className="w-3.5 h-3.5" strokeWidth={2.4} />
          Review &amp; Save
          {pending > 0 && (
            <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-md bg-white/25 text-[10px] font-bold tabular-nums leading-none">
              {pending.toLocaleString()}
            </span>
          )}
        </button>
      </HoverTip>
    </div>
  )
}
