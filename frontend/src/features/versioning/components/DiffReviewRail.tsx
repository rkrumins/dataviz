/**
 * DiffReviewRail — the right-hand "Changes" rail. Renders whatever `ChangeSet` is
 * active in the branch store (the draft-vs-main diff today; a single commit's delta
 * when wired from history). Pairs with the on-canvas tinting so the structured list
 * and the canvas highlight describe the same change.
 */
import { GitCompare, X } from 'lucide-react'
import { useBranchStore } from '@/store/branchStore'
import { ChangesPanel, ChangeCountChips } from './ChangesPanel'
import { EMPTY_CHANGE_SET } from '../model/changeModel'

export function DiffReviewRail() {
  const showDiff = useBranchStore((s) => s.showDiff)
  const setShowDiff = useBranchStore((s) => s.setShowDiff)
  const changeSet = useBranchStore((s) => s.activeChangeSet) ?? EMPTY_CHANGE_SET

  if (!showDiff) return null

  return (
    <div className="absolute top-0 right-0 bottom-0 w-80 z-40 flex flex-col bg-canvas-elevated/95 backdrop-blur border-l border-glass-border shadow-glass-lg animate-slide-right">
      <div className="px-4 py-3 border-b border-glass-border flex items-center gap-2">
        <GitCompare className="w-4 h-4 text-accent-lineage" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-ink">Changes vs main</h3>
          <div className="mt-0.5">
            <ChangeCountChips changeSet={changeSet} />
          </div>
        </div>
        <button
          onClick={() => setShowDiff(false)}
          className="p-1.5 rounded-lg hover:bg-canvas-overlay transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-ink-muted" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <ChangesPanel changeSet={changeSet} emptyHint="This draft has no committed changes vs main yet." />
      </div>
    </div>
  )
}
