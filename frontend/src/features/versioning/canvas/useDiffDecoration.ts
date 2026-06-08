/**
 * useDiffDecoration — the canvas side of the unified diff. Returns the diff status
 * for any entity from the active `ChangeSet` in the branch store, so a canvas's node
 * renderer can tint added/modified/removed using the SAME vocabulary as the staged-
 * change highlighting it already does. This is how the existing "Review & Save"
 * highlight is extended to also show a draft-vs-main (or per-commit) diff, rather
 * than building a parallel overlay.
 */
import { useBranchStore } from '@/store/branchStore'
import type { ChangeStatus } from '../model/changeModel'

export interface DiffDecoration {
  /** True when a diff overlay is active (Review changes toggled, with a change set). */
  isActive: boolean
  /** The diff status for an entity (node urn / edge id), or undefined. */
  statusForEntity: (entityId?: string | null) => ChangeStatus | undefined
}

export function useDiffDecoration(): DiffDecoration {
  const showDiff = useBranchStore((s) => s.showDiff)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const isActive = showDiff && !!changeSet && changeSet.changes.length > 0
  return {
    isActive,
    statusForEntity: (entityId) => {
      if (!isActive || !entityId || !changeSet) return undefined
      return changeSet.byEntityId.get(entityId)?.status
    },
  }
}
