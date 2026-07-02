/**
 * EditorActions — the Context View header's right cluster in Edit mode
 * (i.e. while a draft is open; being on a draft IS edit mode).
 *
 * Layout: [Lineage ●] [Display ▾] [Trace] [Properties] │ [Undo|Redo] [Review & Save · N] [Done]
 *
 * The comprehension tools are the same `ComprehensionTools` component the
 * View mode renders — entering edit adds authoring, it never removes
 * understanding. Review & Save is the single primary action (it replaced
 * both the old amber Pending badge and the multi-state Save button); Done
 * leaves the draft (the pending-edits guard lives in the canvas wiring).
 * Branch lifecycle (switcher / Publish / Discard) stays in the
 * CanvasVersioningBar above — the header never duplicates it.
 */

import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { BRANCH_VOCAB } from '@/features/versioning/model/branchVocab'
import { ComprehensionTools, type ComprehensionToolsProps } from './ViewerActions'

export interface EditorActionsProps extends ComprehensionToolsProps {
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void
  /** Number of staged changes pending review/save — drives the count chip + disabled state. */
  pendingChangeCount?: number
  /** Opens the staged-changes review panel (the only save path). */
  onOpenStagedChanges?: () => void
  onExitEdit: () => void
}

export function EditorActions({
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  pendingChangeCount = 0,
  onOpenStagedChanges,
  onExitEdit,
  ...tools
}: EditorActionsProps) {
  return (
    <>
      <ComprehensionTools {...tools} />

      <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

      {/* Undo / Redo — labelled segmented pair (icon + word, mirrored like
          bookends) so both actions read at a glance, not only on hover. */}
      <div className="flex items-stretch rounded-xl overflow-hidden bg-black/[0.03] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] border border-black/[0.10] dark:border-white/[0.08]">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo last change (⌘Z)"
          aria-label="Undo"
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all",
            canUndo
              ? "text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]"
              : "text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed"
          )}
        >
          <LucideIcons.Undo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
          <span>Undo</span>
        </button>
        <div className="w-px bg-black/[0.10] dark:bg-white/[0.08]" />
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (⌘⇧Z)"
          aria-label="Redo"
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all",
            canRedo
              ? "text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]"
              : "text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed"
          )}
        >
          <span>Redo</span>
          <LucideIcons.Redo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
      </div>

      {/* Review & Save — THE primary action of edit mode: filled accent,
          count chip while edits are pending, muted until there's
          something to review. Opens the staged-changes panel where the
          actual save is confirmed. */}
      <button
        onClick={onOpenStagedChanges}
        disabled={pendingChangeCount === 0}
        title={pendingChangeCount > 0
          ? `Review and save ${pendingChangeCount} pending change${pendingChangeCount === 1 ? '' : 's'}`
          : 'No changes yet — edits you make will collect here for review'}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-300 border",
          pendingChangeCount > 0
            ? "bg-accent-lineage border-transparent text-white shadow-lg shadow-accent-lineage/30 hover:bg-accent-lineage/90 hover:shadow-accent-lineage/40 active:scale-[0.98]"
            : "bg-black/[0.03] border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/50 cursor-not-allowed"
        )}
      >
        <LucideIcons.ListChecks className="w-4 h-4" strokeWidth={2.4} />
        <span>Review &amp; Save</span>
        {pendingChangeCount > 0 && (
          <span className="flex items-center justify-center min-w-[20px] h-5 px-1 rounded-md bg-white/25 text-[11px] font-bold tabular-nums leading-none">
            {pendingChangeCount}
          </span>
        )}
      </button>

      {/* Done — ghost exit back to Published. The "you have pending
          edits" guard lives in the canvas's onExitEdit wiring. */}
      <button
        onClick={onExitEdit}
        title={`Leave the draft and return to ${BRANCH_VOCAB.published}`}
        className="flex items-center px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-all duration-300"
      >
        Done
      </button>
    </>
  )
}
