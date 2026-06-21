/**
 * EditActions — the Zone-3 controls revealed once the user enters Edit mode.
 *
 * Everything here mutates (or commits) the graph, so it stays hidden behind the
 * deliberate "Edit" hand-off. A clear "Editing" pill makes the mode unmistakable,
 * and "Done" returns to Explore (the parent applies an unsaved-changes guard).
 */

import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { PropertyManagerButton } from '../property-manager/PropertyManagerButton'

export interface EditActionsProps {
  onExitEdit: () => void
  onAddEntity: () => void

  // Properties / display-rule authoring
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Undo / Redo
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void

  // Pending changes + save
  pendingChangeCount?: number
  onOpenStagedChanges?: () => void
  activeWorkspaceId: string | null
  syncStatus: 'idle' | 'dirty' | 'saving' | 'synced' | 'error'
  onSave: () => void
}

export function EditActions({
  onExitEdit,
  onAddEntity,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  pendingChangeCount = 0,
  onOpenStagedChanges,
  activeWorkspaceId,
  syncStatus,
  onSave,
}: EditActionsProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Editing mode indicator */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-amber-400/20 to-orange-500/15 border border-amber-400/50 text-amber-800 dark:text-amber-200 dark:border-amber-300/40">
        <LucideIcons.Pencil className="w-3.5 h-3.5" strokeWidth={2.4} />
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] leading-none">Editing</span>
      </div>

      <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

      {/* Add Entity */}
      <button
        onClick={onAddEntity}
        title="Add a new entity to the graph"
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-green-500/15 to-emerald-500/[0.08] text-green-700 border border-green-500/40 hover:from-green-500/25 hover:to-emerald-500/15 hover:border-green-500/60 dark:from-green-500/20 dark:to-emerald-500/10 dark:text-green-400 dark:border-green-500/30 dark:hover:shadow-lg dark:hover:shadow-green-500/20 transition-all duration-300"
      >
        <LucideIcons.Plus className="w-4 h-4" />
        <span>Add Entity</span>
      </button>

      {/* Properties / display-rule authoring */}
      {onTogglePropertyManager && (
        <PropertyManagerButton open={propertyManagerOpen} onToggle={onTogglePropertyManager} />
      )}

      <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

      {/* Undo / Redo */}
      {(canUndo || canRedo) && (
        <div className="flex items-stretch rounded-xl overflow-hidden bg-black/[0.03] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] border border-black/[0.10] dark:border-white/[0.08]">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo last change (⌘Z)"
            aria-label="Undo"
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all',
              canUndo
                ? 'text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]'
                : 'text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed',
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
              'flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all',
              canRedo
                ? 'text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]'
                : 'text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed',
            )}
          >
            <span>Redo</span>
            <LucideIcons.Redo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
          </button>
        </div>
      )}

      {/* Pending changes */}
      {pendingChangeCount > 0 && onOpenStagedChanges && (
        <button
          onClick={onOpenStagedChanges}
          title="Review pending changes"
          className="relative flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-xl bg-gradient-to-br from-amber-300/25 via-amber-400/20 to-orange-500/15 border border-amber-400/60 text-amber-800 hover:from-amber-300/35 hover:to-orange-500/25 hover:border-amber-400/80 transition-all shadow-sm shadow-amber-500/15 hover:shadow-md hover:shadow-amber-500/20 dark:text-amber-100 dark:border-amber-300/50 dark:hover:border-amber-200/70 dark:hover:shadow-lg dark:hover:shadow-amber-500/25"
        >
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 dark:bg-amber-300 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500 dark:bg-amber-300 ring-2 ring-canvas-elevated" />
          </span>
          <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-amber-200 border border-amber-300 dark:bg-amber-300/25 dark:border-amber-200/40">
            <LucideIcons.ListChecks className="w-3.5 h-3.5 text-amber-800 dark:text-amber-100" strokeWidth={2.4} />
          </span>
          <span className="text-[12px] font-bold tabular-nums leading-none">{pendingChangeCount}</span>
          <span className="text-[10.5px] uppercase tracking-[0.08em] font-bold leading-none">Pending</span>
        </button>
      )}

      {/* Save Blueprint */}
      <button
        onClick={onSave}
        disabled={(syncStatus !== 'dirty' && syncStatus !== 'error' && pendingChangeCount === 0) || !activeWorkspaceId}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300',
          (syncStatus === 'dirty' || pendingChangeCount > 0)
            ? 'bg-gradient-to-r from-blue-500/15 to-cyan-500/[0.08] text-blue-700 border border-blue-500/40 hover:from-blue-500/25 hover:to-cyan-500/15 hover:border-blue-500/60 dark:from-blue-500/20 dark:to-cyan-500/10 dark:text-blue-400 dark:border-blue-500/30 dark:hover:shadow-lg dark:hover:shadow-blue-500/20'
            : syncStatus === 'error'
              ? 'bg-gradient-to-r from-red-500/15 to-red-500/[0.08] text-red-700 border border-red-500/40 dark:from-red-500/20 dark:to-red-500/10 dark:text-red-400 dark:border-red-500/30'
              : 'bg-black/[0.03] border border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/50 cursor-not-allowed',
        )}
        title={
          !activeWorkspaceId ? 'No workspace selected'
            : pendingChangeCount > 0 ? `Apply ${pendingChangeCount} pending change${pendingChangeCount === 1 ? '' : 's'} and save`
              : syncStatus === 'dirty' ? 'Save changes to backend'
                : syncStatus === 'error' ? 'Save failed — click to retry'
                  : 'All changes saved'
        }
      >
        {syncStatus === 'saving'
          ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
          : syncStatus === 'error'
            ? <LucideIcons.AlertCircle className="w-4 h-4" />
            : syncStatus === 'synced' && pendingChangeCount === 0
              ? <LucideIcons.CheckCircle className="w-4 h-4" />
              : <LucideIcons.Save className="w-4 h-4" />
        }
        <span>
          {syncStatus === 'saving' ? 'Saving...'
            : syncStatus === 'error' ? 'Retry Save'
              : pendingChangeCount > 0 ? `Save ${pendingChangeCount} change${pendingChangeCount === 1 ? '' : 's'}`
                : syncStatus === 'synced' ? 'Saved'
                  : 'Save Blueprint'}
        </span>
        {(syncStatus === 'dirty' || pendingChangeCount > 0) && (
          <div className="w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400 dark:shadow-lg dark:shadow-blue-400/50" />
        )}
      </button>

      <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

      {/* Done — return to Explore (parent guards unsaved changes) */}
      <button
        onClick={onExitEdit}
        title="Finish editing and return to Explore"
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-300',
          'bg-ink/[0.04] text-ink border border-black/[0.12] dark:bg-white/[0.06] dark:border-white/[0.10]',
          'hover:bg-ink/[0.08] hover:border-black/20 dark:hover:bg-white/[0.10] active:scale-[0.98]',
        )}
      >
        <LucideIcons.Check className="w-4 h-4" strokeWidth={2.4} />
        <span>Done</span>
      </button>
    </div>
  )
}
