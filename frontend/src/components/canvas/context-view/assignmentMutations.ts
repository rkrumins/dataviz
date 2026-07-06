/**
 * Pure transforms over a view's canonical `referenceLayout` — the layer definitions plus the flattened
 * physical-root-urn -> assignment map (`NormalizedReferenceLayout`, see utils/referenceLayout.ts). Every
 * op returns a NEW `{ layers, assignments }` so the caller just hands the result to
 * `persistReferenceLayout(next)` (which writes the view config, never the store).
 *
 * Mirrors layerMutations.ts in spirit: the placement/BFS logic that used to live in the reference-model
 * store (assignEntityToLayer) is isolated and separately tested here. A Context View node's id IS its
 * urn, so the assignment keys are the same ids the canvas renders from.
 */
import type { AssignmentConflict, LayerAssignmentEntry } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'

export interface AssignEntitiesOptions {
  logicalNodeId?: string
  /** default true — descendants resolve via containment at read time */
  inheritsChildren?: boolean
  assignedBy?: 'user' | 'rule' | 'import'
  /** Descendant urns whose explicit entries are removed so they inherit the newly-assigned layer. */
  clearDescendants?: string[]
}

/**
 * Assign `urns` to `layerId`. Each gets a fresh explicit entry; entries named in
 * `opts.clearDescendants` are DELETED so those descendants fall back to containment
 * inheritance (this replaces the store's descendant-materializing BFS — children now
 * follow the parent implicitly rather than being re-stamped).
 */
export function assignEntities(
  layout: NormalizedReferenceLayout,
  urns: string[],
  layerId: string,
  opts: AssignEntitiesOptions = {},
): NormalizedReferenceLayout {
  const assignments = { ...layout.assignments }
  const now = new Date().toISOString()
  for (const urn of urns) {
    const entry: LayerAssignmentEntry = {
      layerId,
      inheritsChildren: opts.inheritsChildren ?? true,
      assignedBy: opts.assignedBy ?? 'user',
      assignedAt: now,
    }
    if (opts.logicalNodeId) entry.logicalNodeId = opts.logicalNodeId
    assignments[urn] = entry
  }
  for (const descendant of opts.clearDescendants ?? []) {
    delete assignments[descendant]
  }
  return { layers: layout.layers, assignments }
}

/** Drop the explicit entries for `urns`; entities then fall out (curated) or resolve by rule (open). */
export function unassignEntities(
  layout: NormalizedReferenceLayout,
  urns: string[],
): NormalizedReferenceLayout {
  const assignments = { ...layout.assignments }
  for (const urn of urns) delete assignments[urn]
  return { layers: layout.layers, assignments }
}

/** Re-key one assignment from `oldUrn` to `newUrn` (temp→real on Save). No-op if `oldUrn` is unassigned. */
export function remapAssignmentUrn(
  layout: NormalizedReferenceLayout,
  oldUrn: string,
  newUrn: string,
): NormalizedReferenceLayout {
  if (oldUrn === newUrn || !layout.assignments[oldUrn]) return layout
  const assignments = { ...layout.assignments }
  assignments[newUrn] = assignments[oldUrn]
  delete assignments[oldUrn]
  return { layers: layout.layers, assignments }
}

/**
 * Containment hard rule: a child cannot be placed in a different layer than its parent subtree —
 * children ALWAYS inherit. Walks up `parentMap` to the nearest ancestor with an explicit assignment
 * (the subtree's effective layer); if that layer differs from the target, the move is blocked. Returns
 * null when there is no such ancestor or it already sits in the target layer. Ported verbatim from the
 * store's `assignEntityToLayer` block — no new conflict UX is introduced.
 */
export function checkAssignmentConflict(
  parentMap: Map<string, string>,
  assignments: Record<string, LayerAssignmentEntry>,
  urn: string,
  layerId: string,
): AssignmentConflict | null {
  const seen = new Set<string>([urn])
  let ancestor = parentMap.get(urn)
  while (ancestor && !seen.has(ancestor)) {
    seen.add(ancestor)
    const entry = assignments[ancestor]
    if (entry?.layerId) {
      if (entry.layerId === layerId) return null
      return {
        entityId: urn,
        conflictingEntityId: ancestor,
        type: 'containment_locked',
        message:
          "Cannot assign child to a different layer than its parent. Children always inherit their parent's layer assignment.",
        conflictingLayerId: entry.layerId,
      }
    }
    ancestor = parentMap.get(ancestor)
  }
  return null
}
