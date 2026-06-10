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
import type { ApplyContext, StagedChange } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { stagedChangesToOps } from './stagedChangesToOps'

export interface DraftSaveTarget {
  wsId: string
  dataSourceId: string
  branchId: string
  provider: GraphDataProvider
  message?: string
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

  // Phase 1 — creates via the proven branch-scoped provider path.
  for (const c of changes) {
    if (c.type === 'create_entity' && c.apply) {
      await c.apply(ctx)
    }
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
  if (ops.length === 0) return { commitId: null }
  const res = await applyGraphChanges(target.wsId, target.dataSourceId, target.branchId, ops, target.message)
  return { commitId: res.commitId }
}
