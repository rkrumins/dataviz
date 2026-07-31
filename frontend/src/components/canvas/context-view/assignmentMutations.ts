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
import type { LayerAssignmentEntry } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { generateNKeysBetween } from '@/utils/orderKeys'

export interface AssignEntitiesOptions {
  logicalNodeId?: string
  /** default true — descendants resolve via containment at read time */
  inheritsChildren?: boolean
  assignedBy?: 'user' | 'rule' | 'import'
  /** Descendant urns whose explicit entries are removed so they inherit the newly-assigned layer. */
  clearDescendants?: string[]
  /** Fractional position key stamped on the new entries (custom-sorted target layers). */
  orderKey?: string
}

/**
 * Assign `urns` to `layerId`. Each gets a fresh explicit entry; entries named in
 * `opts.clearDescendants` are DELETED so those descendants fall back to containment
 * inheritance (this replaces the store's descendant-materializing BFS — children now
 * follow the parent implicitly rather than being re-stamped).
 *
 * orderKey semantics: an explicit `opts.orderKey` wins; otherwise a SAME-layer
 * re-assign carries the entry's existing key forward (a logical-group move must
 * not shuffle a custom arrangement), while a cross-layer move drops it (the key
 * only orders within its own layer).
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
    const prior = layout.assignments[urn]
    const entry: LayerAssignmentEntry = {
      layerId,
      inheritsChildren: opts.inheritsChildren ?? true,
      assignedBy: opts.assignedBy ?? 'user',
      assignedAt: now,
    }
    if (opts.logicalNodeId) entry.logicalNodeId = opts.logicalNodeId
    const orderKey = opts.orderKey ?? (prior?.layerId === layerId ? prior.orderKey : undefined)
    if (orderKey) entry.orderKey = orderKey
    assignments[urn] = entry
  }
  for (const descendant of opts.clearDescendants ?? []) {
    delete assignments[descendant]
  }
  return { ...layout, layers: layout.layers, assignments }
}

/** Set (or clear, with `null`) one assignment's fractional position key. No-op
 *  (same layout) when the urn has no explicit entry. */
export function setAssignmentOrderKey(
  layout: NormalizedReferenceLayout,
  urn: string,
  orderKey: string | null,
): NormalizedReferenceLayout {
  const entry = layout.assignments[urn]
  if (!entry) return layout
  const assignments = { ...layout.assignments }
  if (orderKey === null) {
    const { orderKey: _drop, ...rest } = entry
    assignments[urn] = rest as LayerAssignmentEntry
  } else {
    assignments[urn] = { ...entry, orderKey }
  }
  return { ...layout, assignments }
}

/** The largest orderKey currently present among `layerId`'s entries, or null. */
export function lastOrderKeyInLayer(
  layout: NormalizedReferenceLayout,
  layerId: string,
): string | null {
  let last: string | null = null
  for (const entry of Object.values(layout.assignments)) {
    if (entry.layerId !== layerId || !entry.orderKey) continue
    if (last === null || entry.orderKey > last) last = entry.orderKey
  }
  return last
}

/**
 * Ensure EVERY id in `siblingIds` carries an `orderKey` — the seeding step that
 * makes a sibling set (a layer's visual roots OR one node's children)
 * manually orderable. Custom order is HIERARCHICAL: the orderKey lives on the
 * node's own assignment entry (keyed by urn) and is only ever compared within
 * its sibling set, so a child set and the root set can hold independent keys.
 *
 * Only the UNKEYED siblings are seeded, in `siblingIds` (current visual) order,
 * appended after the largest key already in THIS set — so key order matches
 * what the user sees. A sibling that lacks an assignment entry (children
 * normally inherit their layer and have none) gets a bare orderKey-carrier
 * entry; this is layer-safe because the carrier names the SAME layer the
 * sibling set renders in, so it resolves to the layer the child would inherit
 * anyway and the child stays nested. Returns the same layout when every
 * sibling is already keyed.
 */
export function ensureSiblingOrderKeys(
  layout: NormalizedReferenceLayout,
  layerId: string,
  siblingIds: readonly string[],
): NormalizedReferenceLayout {
  const toSeed = siblingIds.filter((id) => !layout.assignments[id]?.orderKey)
  if (toSeed.length === 0) return layout
  let last: string | null = null
  for (const id of siblingIds) {
    const key = layout.assignments[id]?.orderKey
    if (key && (last === null || key > last)) last = key
  }
  let keys: string[]
  try {
    keys = generateNKeysBetween(last, null, toSeed.length)
  } catch {
    return layout // malformed existing key — refuse rather than corrupt
  }
  const assignments = { ...layout.assignments }
  const now = new Date().toISOString()
  toSeed.forEach((id, i) => {
    const prev = assignments[id]
    assignments[id] = prev
      ? { ...prev, orderKey: keys[i] }
      : { layerId, inheritsChildren: true, assignedBy: 'user', assignedAt: now, orderKey: keys[i] }
  })
  return { ...layout, assignments }
}

/**
 * Mint a fractional key for inserting at `insertIdx` within `order` (the
 * column's visual root ids, dragged node already removed). Immediate neighbors
 * may be UNKEYED rule-assigned roots (open scope) — `generateKeyBetween(null,
 * null)` would return the smallest key and teleport the node to the top — so
 * walk OUTWARD to the nearest keyed neighbor on each side; both sides unkeyed
 * ⇒ append after the layer's largest key (the drop landed inside the trailing
 * unkeyed region, which renders after every keyed root). Returns null when the
 * neighbor keys are malformed (caller refuses the drop rather than corrupting
 * the arrangement).
 */
export function keyForInsertion(
  layout: NormalizedReferenceLayout,
  layerId: string,
  order: readonly string[],
  insertIdx: number,
): string | null {
  const keys = keysForInsertion(layout, layerId, order, insertIdx, 1)
  return keys ? keys[0] : null
}

/**
 * Block variant of `keyForInsertion`: mint `count` consecutive keys at
 * `insertIdx` (a multi-select drag moves several roots as one contiguous
 * block). Same outward walk / append-fallback semantics; returns null when
 * the neighbor keys are malformed.
 */
export function keysForInsertion(
  layout: NormalizedReferenceLayout,
  layerId: string,
  order: readonly string[],
  insertIdx: number,
  count: number,
): string[] | null {
  let prevKey: string | null = null
  for (let i = insertIdx - 1; i >= 0; i--) {
    const key = layout.assignments[order[i]]?.orderKey
    if (key) { prevKey = key; break }
  }
  let nextKey: string | null = null
  for (let i = insertIdx; i < order.length; i++) {
    const key = layout.assignments[order[i]]?.orderKey
    if (key) { nextKey = key; break }
  }
  if (prevKey === null && nextKey === null) {
    prevKey = lastOrderKeyInLayer(layout, layerId)
  }
  try {
    return generateNKeysBetween(prevKey, nextKey, count)
  } catch {
    return null
  }
}

/** Drop the explicit entries for `urns`; entities then fall out (curated) or resolve by rule (open). */
export function unassignEntities(
  layout: NormalizedReferenceLayout,
  urns: string[],
): NormalizedReferenceLayout {
  const assignments = { ...layout.assignments }
  for (const urn of urns) delete assignments[urn]
  return { ...layout, assignments }
}

/**
 * Temp urn prefix minted by the create paths (useStageEntityCreation / stageBuildRows mint
 * `urn:staged:<type>:<id>`). A temp urn is never a durable, backend-issued urn.
 */
export const TEMP_URN_PREFIX = 'urn:staged:'

export function isTempUrn(urn: string): boolean {
  return urn.startsWith(TEMP_URN_PREFIX)
}

/**
 * Drop assignment entries still keyed by a temp urn. A create is staged with a canonical placement
 * keyed by its temp urn; if the create is later DISCARDED, that placement is orphaned — it never
 * resolves or renders, but it lingers in `referenceLayout.assignments` and wastes a provider lookup
 * on curated hydration. Call on Save AFTER the temp→real remap pass: a create that was kept has had
 * its key remapped to the minted urn, so any SURVIVING temp-urn key is a discarded create. Returns
 * the SAME layout (referential stability) when there is nothing to prune.
 */
export function pruneTempAssignments(layout: NormalizedReferenceLayout): NormalizedReferenceLayout {
  const tempKeys = Object.keys(layout.assignments).filter(isTempUrn)
  if (tempKeys.length === 0) return layout
  const assignments = { ...layout.assignments }
  for (const key of tempKeys) delete assignments[key]
  return { ...layout, assignments }
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
  return { ...layout, assignments }
}
