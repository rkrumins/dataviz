/**
 * saveStagedChangesToDraft — the draft "Save" path. Two phases so every edit type
 * actually persists to the draft branch:
 *   1. create_entity runs through its proven `provider.createNode` apply hook (the
 *      provider is branch-scoped, so it writes to the draft; this also constructs the
 *      urn + containment edge and remaps the optimistic temp id).
 *   2. everything else (rename/update/delete node, edit/delete/reverse edge) is folded
 *      into ONE atomic, server-merged commit via `/graph/changes`.
 *
 * This replaces the old per-change `applyAll` for drafts, where most change types had
 * no working apply hook (or hit the unscoped endpoint) and so never persisted.
 */
import { applyGraphChanges, type GraphChangeOp } from '@/services/versioningApiService'
import { useStagedChangesStore, type ApplyContext, type StagedChange } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { stagedChangesToOps } from './stagedChangesToOps'

export interface DraftSaveTarget {
  wsId: string
  dataSourceId: string
  branchId: string
  provider: GraphDataProvider
  message?: string
  /**
   * Re-key view-config (layer) assignments from a created entity's temp urn onto its
   * real urn. Called the instant each create resolves in Phase 1 — coupled to the
   * optimistic node swap — so the assignment is never lost if a later create or the
   * Phase-2 commit throws, and the node never flashes out of its layer mid-save.
   */
  remapEntityId?: (oldId: string, newId: string) => void
}

export async function saveStagedChangesToDraft(
  changes: StagedChange[],
  target: DraftSaveTarget,
): Promise<{ commitId?: string | null }> {
  const tempIdMap = new Map<string, string>()
  const ctx: ApplyContext = {
    provider: target.provider,
    wsId: target.wsId,
    resolveTempId: (t) => tempIdMap.get(t),
    registerTempIdResolution: (t, r) => tempIdMap.set(t, r),
  }

  // Phase 1 — creates via the proven branch-scoped provider path. Each create is
  // attempted independently so an ontology rejection (e.g. an illegal containment
  // relationship) is attributed to its specific entity rather than aborting the
  // batch opaquely. If ANY create fails we drop the ones that already persisted
  // (so a retry can't duplicate them), skip children of a failed parent, flag the
  // failures, and stop before the mutation commit — never persist a partial hierarchy.
  const succeeded: string[] = []
  const failures: { id: string; name: string; message: string }[] = []
  // Temp urns of creates that failed or were skipped — their descendants can't resolve a parent.
  const blockedParentUrns = new Set<string>()
  for (const c of changes) {
    if (c.type !== 'create_entity' || !c.apply) continue
    const after = c.after as { displayName?: string; parentUrn?: string } | undefined
    const name = after?.displayName || c.targetId
    const parentUrn = after?.parentUrn
    // A child of a staged parent that already failed can never resolve its parent —
    // skip it with a clear message instead of a raw backend "Parent not found".
    if (parentUrn && parentUrn.startsWith('urn:staged:') && blockedParentUrns.has(parentUrn)) {
      failures.push({ id: c.id, name, message: 'Skipped — its parent could not be created.' })
      if (c.targetUrn) blockedParentUrns.add(c.targetUrn)
      continue
    }
    try {
      await c.apply(ctx)
      succeeded.push(c.id)
      // Re-key this entity's layer assignment temp→real NOW, in the same tick as the
      // apply hook's node swap — so it survives a later create/Phase-2 failure and the
      // node never drops out of its layer column during the save. (No-op if unassigned.)
      const realUrn = c.targetUrn ? tempIdMap.get(c.targetUrn) : undefined
      if (c.targetUrn && realUrn) target.remapEntityId?.(c.targetUrn, realUrn)
    } catch (e) {
      failures.push({ id: c.id, name, message: (e as Error).message })
      if (c.targetUrn) blockedParentUrns.add(c.targetUrn)
    }
  }
  if (failures.length > 0) {
    const succeededSet = new Set(succeeded)
    const failedIds = new Set(failures.map((f) => f.id))
    const msgById = new Map(failures.map((f) => [f.id, f.message]))
    useStagedChangesStore.setState((s) => ({
      // Drop already-persisted creates (retry-safe) and flag the failures so the
      // review panel highlights exactly the offending entities.
      changes: s.changes
        .filter((c) => !succeededSet.has(c.id))
        .map((c) => (failedIds.has(c.id) ? { ...c, error: msgById.get(c.id) } : c)),
      applyStatus: 'partial-error',
      lastApplyResult: { ok: succeeded.length, failed: failures.length },
    }))
    const summary =
      failures.length === 1
        ? failures[0].message
        : `${failures.length} entities couldn't be created:\n` +
          failures.map((f) => `• ${f.name}: ${f.message}`).join('\n')
    throw new Error(summary)
  }

  // Phase 2 — mutations + user-drawn edges as one atomic, server-merged commit.
  // Resolve edge endpoints through Phase 1's temp-id map: an edge between two
  // freshly-created nodes references their temp urns until the creates above
  // register the real ones.
  const resolve = (id: string) => tempIdMap.get(id) ?? id
  const ops: GraphChangeOp[] = stagedChangesToOps(
    changes.filter((c) => c.type !== 'create_entity'),
    resolve,
  )
  let commitId: string | null = null
  if (ops.length > 0) {
    const res = await applyGraphChanges(target.wsId, target.dataSourceId, target.branchId, ops, target.message)
    commitId = res.commitId ?? null
  }

  // Phase 3 — layer moves persist in a SEPARATE, isolated commit AFTER the
  // structural one. A layer move rewrites the entity's own `layerAssignment`
  // (the single field the reload placement reads), but it MUST NOT ride in the
  // atomic Phase-2 batch: if a layer op failed there it would roll back the
  // user's creates/renames/containment edits too — the data-loss trap. Isolated
  // + best-effort here, a layer failure is logged and skipped; the structural
  // commit already succeeded and is safe.
  const layerOps: GraphChangeOp[] = []
  for (const c of changes) {
    if (c.type !== 'assign_layer' && c.type !== 'move_to_layer') continue
    const layerId = (c.after as { layerId?: string } | undefined)?.layerId
    const rawId = c.targetUrn ?? c.targetId
    if (!layerId || !rawId) continue
    const id = resolve(rawId)
    // Logical/pseudo groups have no backend entity to update — skip them.
    if (id.startsWith('logical:')) continue
    layerOps.push({ op: 'update', kind: 'node', id, payload: { layerAssignment: layerId } })
  }
  if (layerOps.length > 0) {
    try {
      await applyGraphChanges(target.wsId, target.dataSourceId, target.branchId, layerOps, 'Layer assignments')
    } catch (e) {
      // Non-fatal by design: the structural edits are already committed.
      console.error('[saveStagedChangesToDraft] layer assignment persist failed (structural edits are safe)', e)
    }
  }

  // Rollups may have changed (lineage edges added/removed, containment moved): the server's
  // draft overlay reports adjusted aggregated edges, but only a fresh fetch shows them.
  invalidateAggregatedEdges()
  return { commitId }
}
