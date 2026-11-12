/** The deletions under a row that the canvas hasn't drawn: what "N deleted inside" draws. */
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { indexRemovals } from './deletionGhosts'

/** The most deletions one choice draws. */
export const DELETED_INSIDE_DRAWN = 200

/** The deletions directly under `parent` the canvas hasn't drawn, at most `limit`, by urn. */
export function hiddenDeletionsUnder(parent: string, containmentTypes: readonly string[], limit = DELETED_INSIDE_DRAWN): string[] {
  const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
  const removals = indexRemovals(useBranchStore.getState().activeChangeSet?.changes ?? [], (t) => up.has(t.toUpperCase()))
  const drawn = useCanvasStore.getState()._nodeIndex
  return [...new Set(removals.childrenOf.get(parent) ?? [])]
    .filter((u) => removals.nodes.has(u) && !drawn.has(u))
    .slice(0, limit)
}
