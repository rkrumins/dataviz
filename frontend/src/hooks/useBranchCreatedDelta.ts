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

/**
 * PURE: the target URNs of every `create_entity` change. Extracted from the hook
 * so it is unit-testable without React or the store.
 */
export function branchCreatedUrns(changes: StagedChange[]): Set<string> {
  const urns = new Set<string>()
  for (const c of changes) {
    if (c.type === 'create_entity' && c.targetUrn) urns.add(c.targetUrn)
  }
  return urns
}

/** Reactive branch-created delta for the active scope. */
export function useBranchCreatedDelta(): Set<string> {
  const changes = useStagedChangesStore((s) => s.changes)
  return useMemo(() => branchCreatedUrns(changes), [changes])
}
