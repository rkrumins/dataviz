/**
 * useBranchCreatedDelta — the set of URNs created (`create_entity`) in the active
 * branch's draft, read from `stagedChangesStore`.
 *
 * Why it exists: a CLOSED-SCOPE Context Model view (one with persisted
 * `entityAssignments`) deliberately ignores a node's GLOBAL `layerAssignment`
 * property, because honouring it for arbitrary nodes would leak in entities the
 * view never assigned (cross-view contamination). But an entity you JUST created
 * in this branch's draft has no persisted `entityAssignment` yet, so it would
 * never render. This delta is the leak-safe key: `useLayerAssignment` honours the
 * node `layerAssignment` in closed-scope ONLY for URNs in this set — the entities
 * this branch actually created, and nothing else.
 *
 * The store's active-scope slice lives in `changes` (its `_scopeKey`/`setScope`
 * machinery keeps `changes` pointed at exactly the current branch's edits), so the
 * delta is inherently scoped to the active branch. Each `create_entity` staged
 * change stamps its new entity's urn on `targetUrn` (see stageBuildRows /
 * useStageEntityCreation).
 */
import { useMemo } from 'react'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import type { ChangeSet } from '@/features/versioning/model/changeModel'

/**
 * PURE: the target URNs of every live-STAGED (not-yet-saved) `create_entity`
 * change. Optimistic coverage before the draft is committed.
 */
export function branchCreatedUrns(changes: StagedChange[]): Set<string> {
  const urns = new Set<string>()
  for (const c of changes) {
    if (c.type === 'create_entity' && c.targetUrn) urns.add(c.targetUrn)
  }
  return urns
}

/**
 * PURE: URNs created (`added` NODE changes) and COMMITTED in the active branch,
 * read from the branch changeset. Unlike the staged store — which clears on save —
 * this survives reload, so a saved-then-reloaded created entity stays in the delta
 * (the actual user bug: entities committed to the draft but invisible after save).
 */
export function committedCreatedUrns(changeSet: ChangeSet | null): Set<string> {
  const urns = new Set<string>()
  if (!changeSet) return urns
  for (const c of changeSet.changes) {
    if (c.status === 'added' && c.kind === 'node' && c.entityId) urns.add(c.entityId)
  }
  return urns
}

/**
 * Reactive branch-created delta for the active scope: live-staged creates (optimistic)
 * UNION committed-in-branch creates (durable across reload). Both are genuinely
 * "created in THIS branch", so honouring the node `layerAssignment` for them in
 * closed-scope stays leak-safe.
 */
export function useBranchCreatedDelta(): Set<string> {
  const changes = useStagedChangesStore((s) => s.changes)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  return useMemo(() => {
    const urns = branchCreatedUrns(changes)
    for (const u of committedCreatedUrns(changeSet)) urns.add(u)
    return urns
  }, [changes, changeSet])
}
