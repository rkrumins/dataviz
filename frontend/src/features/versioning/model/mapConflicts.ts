/**
 * mapConflicts — a refused save's conflicts, on the staged changes that caused them.
 *
 * The server says which entity and which field two edits both changed (`entity_id`, `path`, and
 * the base / ours / theirs values), plus each entity as it is now (`current`). The staged change
 * that edited that entity is found by the id its op was sent under — the same resolution
 * `stagedChangesToOps` uses — so the Review panel can show the conflict where the edit is.
 */
import type { MergeConflictError } from '@/services/versioningApiService'
import { useStagedChangesStore, type ConflictField, type StagedChange, type StagedConflict } from '@/store/stagedChangesStore'

/** A conflicting change's `error`, shown on its row until the conflict is settled. */
export const CONFLICT_MESSAGE = 'Someone else changed this since you opened it — choose which values to keep.'

/** The id a change's update op addresses (see `stagedChangesToOps`), or null for other types. */
export function conflictTargetOf(c: StagedChange): string | null {
  const id = c.type === 'update_entity' || c.type === 'rename_entity' ? (c.targetUrn ?? c.targetId)
    : c.type === 'edit_edge' ? c.targetId
      : null
  // A reader shows an entity with no urn as "gv:<id>"; the server addresses the entity itself.
  return id && id.startsWith('gv:') ? id.slice(3) : id
}

/** changeId → its conflict. Conflicts on an entity no staged change edits are left out. */
export function mapConflicts(
  err: Pick<MergeConflictError, 'conflicts' | 'current'>,
  changes: readonly StagedChange[],
): Map<string, StagedConflict> {
  const byEntity = new Map<string, StagedChange>()
  for (const c of changes) {
    const id = conflictTargetOf(c)
    if (id) byEntity.set(id, c)
  }
  const out = new Map<string, StagedConflict>()
  for (const raw of err.conflicts) {
    const entityId = String(raw.entity_id ?? '')
    const change = byEntity.get(entityId)
    const current = err.current[entityId]
    if (!change || !current) continue
    const path = Array.isArray(raw.path) ? raw.path.map(String) : []
    const field: ConflictField = { key: path.join('.'), path, base: raw.base, mine: raw.ours, theirs: raw.theirs }
    const entry = out.get(change.id) ?? { fields: [], current }
    if (!entry.fields.some((f) => f.key === field.key)) entry.fields.push(field)
    out.set(change.id, entry)
  }
  return out
}

/** Put a refused save's conflicts on the staged changes (each with `CONFLICT_MESSAGE` as its
 *  error) and say how many changes conflict. */
export function markConflicts(err: Pick<MergeConflictError, 'conflicts' | 'current'>): number {
  const conflicts = mapConflicts(err, useStagedChangesStore.getState().changes)
  useStagedChangesStore.setState((st) => ({
    changes: st.changes.map((c) => {
      const conflict = conflicts.get(c.id)
      return conflict ? { ...c, conflict, error: CONFLICT_MESSAGE } : c
    }),
  }))
  return conflicts.size
}
