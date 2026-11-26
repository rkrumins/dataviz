/**
 * Pure transforms over a view's `referenceLayout.layers` array — the single source the Context View
 * canvas renders columns from. Every op returns a NEW array with `order` re-normalized to 0..n-1, so
 * the caller just hands the result to `updateView({ layout: { referenceLayout: { layers } } })`.
 *
 * Kept pure + separately tested (layerMutations.test.ts) because the reorder/remove index math is
 * where off-by-ones hide. The handlers in ContextViewCanvas (addLayer/renameLayer/deleteLayer/
 * reorderLayer) are thin wrappers that mint ids/persist; all the list logic lives here.
 */
import type { LayerAssignmentEntry, LayerNodeSortAlgo, LayerNodeSortMode, ViewLayerConfig } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { compareOrderKeys, generateNKeysBetween } from '@/utils/orderKeys'
import { changedAssignments, isTempUrn, restoreAssignment } from './assignmentMutations'

const renumber = (layers: ViewLayerConfig[]): ViewLayerConfig[] =>
  layers.map((l, i) => (l.order === i ? l : { ...l, order: i }))

/** The layers as they are SHOWN — by `order`, ties in stored order. A saved array is not always in
 *  that order (a wizard save, an API write), and every op below works in what the reader sees. */
const inDisplayOrder = (layers: ViewLayerConfig[]): ViewLayerConfig[] =>
  [...layers].sort((a, b) => a.order - b.order)

/** Append a new layer at the end; its `order` follows the last one shown (the pre-append length when
 *  the orders run 0..n-1). The stored array is otherwise kept as it was. */
export function appendLayer(layers: ViewLayerConfig[], newLayer: ViewLayerConfig): ViewLayerConfig[] {
  const last = layers.reduce((max, l) => Math.max(max, l.order), -1)
  return [...layers, { ...newLayer, order: Math.max(last + 1, layers.length) }]
}

/**
 * Insert a new layer at `index` (clamped to 0..length), shifting the layers from there one place
 * right; order re-normalized. Inserting at `length` is an append. The new layer's own `order` is
 * ignored — where it lands is its order.
 */
export function insertLayer(layers: ViewLayerConfig[], newLayer: ViewLayerConfig, index: number): ViewLayerConfig[] {
  const at = Math.max(0, Math.min(Math.trunc(index), layers.length))
  const shown = inDisplayOrder(layers)
  return renumber([...shown.slice(0, at), newLayer, ...shown.slice(at)])
}

/** Recolour one layer by id; no-op (same array) if not found or already that colour. */
export function recolorLayer(layers: ViewLayerConfig[], id: string, color: string): ViewLayerConfig[] {
  const target = layers.find((l) => l.id === id)
  if (!target || target.color === color) return layers
  return layers.map((l) => (l.id === id ? { ...l, color } : l))
}

/** The fields of one layer the settings panel edits. */
export type LayerPatch = Partial<Pick<ViewLayerConfig, 'name' | 'description' | 'color' | 'icon' | 'properties' | 'showUnassigned'>>

/** `layer` with a name someone chose: it no longer follows the entity the column is mapped to. */
const named = (layer: ViewLayerConfig, name: string): ViewLayerConfig => {
  const { nameFromAnchor: _drop, ...rest } = layer
  return { ...rest, name }
}

/** Change one layer's fields by id; the same array when nothing would change. A new name is one
 *  someone chose (see `renameLayer`). */
export function updateLayer(layers: ViewLayerConfig[], id: string, patch: LayerPatch): ViewLayerConfig[] {
  const target = layers.find((l) => l.id === id)
  if (!target) return layers
  const changed = (Object.keys(patch) as Array<keyof LayerPatch>)
    .some((k) => JSON.stringify(target[k]) !== JSON.stringify(patch[k]))
  if (!changed) return layers
  return layers.map((l) => {
    if (l.id !== id) return l
    const next = { ...l, ...patch }
    return patch.name !== undefined && patch.name !== l.name ? named(next, patch.name) : next
  })
}

/** Rename one layer by id; no-op if not found. Order untouched. A rename is a name someone chose:
 *  a column mapped to an entity stops taking that entity's name. */
export function renameLayer(layers: ViewLayerConfig[], id: string, name: string): ViewLayerConfig[] {
  return layers.map((l) => (l.id === id ? named(l, name) : l))
}

// ── Mapping a column to an entity ─────────────────────────────────────────────────────────────────
// A MAPPED column is an entity (`anchorUrn`): its rows are what is inside it. Its entity's own
// placement names the column, inheriting, so the subtree resolves into it — the anchor and that
// placement always change together, here and nowhere else.

/** The fields of a layer that say which entity it is, and whose name it wears. */
const MAPPING_FIELDS = ['anchorUrn', 'nameFromAnchor', 'name'] as const
type MappingField = typeof MAPPING_FIELDS[number]

/** A name nobody chose: empty, the "New layer" a fresh column gets (the wizard's "Layer 2"), or one
 *  that follows its entity. */
export function isAutoLayerName(layer: Pick<ViewLayerConfig, 'name' | 'nameFromAnchor'>): boolean {
  const name = layer.name.trim()
  return !!layer.nameFromAnchor || name === '' || /^(new )?layer( \d+)?$/i.test(name)
}

/** `layer` with `fields` set as `from` holds them (absent there: removed). */
const withFields = (layer: ViewLayerConfig, from: Partial<ViewLayerConfig>, fields: readonly MappingField[]): ViewLayerConfig => {
  const next: Record<string, unknown> = { ...layer }
  for (const f of fields) {
    if (from[f] === undefined) delete next[f]
    else next[f] = from[f]
  }
  return next as unknown as ViewLayerConfig
}

const sameMapping = (a: ViewLayerConfig, b: ViewLayerConfig) => MAPPING_FIELDS.every((f) => a[f] === b[f])

/** `layer` mapped to nothing. Its name stays — `name`, when given, is the one it showed. */
const unmapped = (layer: ViewLayerConfig, name?: string): ViewLayerConfig =>
  withFields(layer, { nameFromAnchor: layer.nameFromAnchor, name: layer.nameFromAnchor && name ? name : layer.name }, MAPPING_FIELDS)

/**
 * Map a layer to an entity: the column IS `urn`, its rows what is inside it. The entity's placement
 * moves into the column, inheriting (so its subtree follows); any other column mapped to it lets
 * go. A column nobody named takes the entity's name (`opts.name`, as the reader sees it) and follows
 * it from then on (`nameFromAnchor`). `opts.clearDescendants`: placements of what is inside it that
 * held it in its old column (a custom order's), dropped so they follow it. The SAME layout when it
 * already is so, or the layer is missing.
 */
export function mapLayerToEntity(
  layout: NormalizedReferenceLayout,
  layerId: string,
  urn: string,
  opts: { name?: string; clearDescendants?: readonly string[] } = {},
): NormalizedReferenceLayout {
  if (!layout.layers.some((l) => l.id === layerId)) return layout
  let layersChanged = false
  const layers = layout.layers.map((l) => {
    let next = l
    if (l.id === layerId) {
      const auto = isAutoLayerName(l)
      next = withFields(l, {
        anchorUrn: urn,
        nameFromAnchor: auto ? true : undefined,
        name: auto && opts.name ? opts.name : l.name,
      }, MAPPING_FIELDS)
    } else if (l.anchorUrn === urn) {
      next = unmapped(l)
    }
    if (sameMapping(next, l)) return l
    layersChanged = true
    return next
  })

  const prior = layout.assignments[urn]
  const keep = prior?.layerId === layerId && prior.inheritsChildren !== false && !prior.logicalNodeId
  const clear = (opts.clearDescendants ?? []).filter((d) => d !== urn && layout.assignments[d])
  if (!layersChanged && keep && clear.length === 0) return layout
  const assignments = { ...layout.assignments }
  if (!keep) assignments[urn] = { layerId, inheritsChildren: true, assignedBy: 'user', assignedAt: new Date().toISOString() }
  for (const d of clear) delete assignments[d]
  return { ...layout, layers: layersChanged ? layers : layout.layers, assignments }
}

/**
 * Show the entity a layer is mapped to as a row in it again: the mapping goes; the entity keeps its
 * placement in the column, so it is drawn there, with what is inside it beneath. The column keeps
 * its name (`opts.name`, when it showed its entity's: the one it showed) and stays free to follow a
 * new mapping. The SAME layout for a layer that is not mapped, or missing.
 */
export function unmapLayer(layout: NormalizedReferenceLayout, layerId: string, opts: { name?: string } = {}): NormalizedReferenceLayout {
  const target = layout.layers.find((l) => l.id === layerId)
  if (!target?.anchorUrn) return layout
  return { ...layout, layers: layout.layers.map((l) => (l.id === layerId ? unmapped(l, opts.name) : l)) }
}

/**
 * Keep every mapping with its placement: a column that held its entity in `before` and no longer
 * does in `after` (placed in another column, or not at all) is no longer mapped to it — otherwise it
 * would stand empty, claiming an entity drawn elsewhere. Only the placements `before → after` changed
 * are looked at. The SAME `after` when no column lost its entity.
 */
export function unmapMovedAnchors(before: NormalizedReferenceLayout, after: NormalizedReferenceLayout): NormalizedReferenceLayout {
  let out = after
  for (const urn of changedAssignments(before, after)) {
    for (const l of after.layers) {
      if (l.anchorUrn !== urn || before.assignments[urn]?.layerId !== l.id || after.assignments[urn]?.layerId === l.id) continue
      out = unmapLayer(out, l.id)
    }
  }
  return out
}

/** What one layout change touched: layers (by their mapping, or added or removed) and placements. */
export interface LayoutTouch {
  layerIds: string[]
  urns: string[]
}

/** The layers whose mapping (or name) `after` holds differently from `before`, and those only one of
 *  them has — not the ones an insert merely shifted along. */
export function changedLayerMappings(before: NormalizedReferenceLayout, after: NormalizedReferenceLayout): string[] {
  const was = new Map(before.layers.map((l) => [l.id, l]))
  const now = new Map(after.layers.map((l) => [l.id, l]))
  return [...new Set([...was.keys(), ...now.keys()])].filter((id) => {
    const a = was.get(id)
    const b = now.get(id)
    return !a || !b || !sameMapping(a, b)
  })
}

/** What `before → after` touched. */
export function touchedBy(before: NormalizedReferenceLayout, after: NormalizedReferenceLayout): LayoutTouch {
  return { layerIds: changedLayerMappings(before, after), urns: changedAssignments(before, after) }
}

/**
 * The touched part of a layout, as it stands in `layout`: each touched layer (`null`: not there)
 * and each touched placement (`null`: none). Plain data, so a staged change can carry it through a
 * reload and still be taken back (`restoreLayoutPart`).
 */
export interface LayoutPart {
  layers: Record<string, ViewLayerConfig | null>
  assignments: Record<string, LayerAssignmentEntry | null>
}

export function layoutPart(layout: NormalizedReferenceLayout, touch: LayoutTouch): LayoutPart {
  const layers: LayoutPart['layers'] = {}
  for (const id of touch.layerIds) layers[id] = layout.layers.find((l) => l.id === id) ?? null
  const assignments: LayoutPart['assignments'] = {}
  for (const urn of touch.urns) assignments[urn] = layout.assignments[urn] ?? null
  return { layers, assignments }
}

/**
 * `layout` with `part` put back — and everything else as it is, so one change is taken back (or put
 * back) alone and every edit made since stays. A layer the part has: its mapping and name as the part
 * holds them (its colour, groups, settings stay); one the part lacks (`null`) is removed; one the
 * layout lacks comes back, whole, where it stood. The SAME layout when it already holds the part.
 */
export function restoreLayoutPart(layout: NormalizedReferenceLayout, part: LayoutPart): NormalizedReferenceLayout {
  let layers = layout.layers
  for (const [id, was] of Object.entries(part.layers)) {
    const now = layers.find((l) => l.id === id)
    if (!was) {
      if (now) layers = removeLayer(layers, id)
    } else if (!now) {
      layers = insertLayer(layers, was, was.order)
    } else if (!sameMapping(now, was)) {
      layers = layers.map((l) => (l.id === id ? withFields(l, was, MAPPING_FIELDS) : l))
    }
  }
  const out = layers === layout.layers ? layout : { ...layout, layers }
  return Object.entries(part.assignments).reduce((at, [urn, entry]) => restoreAssignment(at, urn, entry), out)
}

/** Point columns mapped to an entity created in this draft at the urn its save gave it (`ids`: temp
 *  → real), as `remapAssignmentUrns` does its placement. The SAME layout when none is. */
export function remapLayerAnchors(layout: NormalizedReferenceLayout, ids: ReadonlyMap<string, string>): NormalizedReferenceLayout {
  if (!layout.layers.some((l) => l.anchorUrn && ids.has(l.anchorUrn))) return layout
  return { ...layout, layers: layout.layers.map((l) => (l.anchorUrn && ids.has(l.anchorUrn) ? { ...l, anchorUrn: ids.get(l.anchorUrn)! } : l)) }
}

/** Map to nothing every column still mapped to a temp urn — after a save's remap, its create was
 *  discarded — as `pruneTempAssignments` drops its placement. The SAME layout when none is. */
export function pruneTempAnchors(layout: NormalizedReferenceLayout): NormalizedReferenceLayout {
  return layout.layers
    .filter((l) => l.anchorUrn && isTempUrn(l.anchorUrn))
    .reduce((at, l) => unmapLayer(at, l.id), layout)
}

/** Set (or clear, with undefined) a layer's authored column width. */
export function setLayerWidth(layers: ViewLayerConfig[], id: string, width: number | undefined): ViewLayerConfig[] {
  return layers.map((l) => (l.id === id ? { ...l, width } : l))
}

/** Remove one layer by id and re-normalize order; no-op if not found. */
export function removeLayer(layers: ViewLayerConfig[], id: string): ViewLayerConfig[] {
  if (!layers.some((l) => l.id === id)) return layers
  return renumber(inDisplayOrder(layers).filter((l) => l.id !== id))
}

/**
 * Move `draggedId` next to `targetId`, list-reorder semantics: dragging RIGHT drops it AFTER the
 * target, dragging LEFT drops it BEFORE — so the layer lands where you released it. No-op if either
 * id is missing or they're the same. Order re-normalized. The layer's nodes/edges follow for free —
 * they render wherever the layer sits (they key off `layerAssignment`, not a column index).
 */
export function reorderLayer(layers: ViewLayerConfig[], draggedId: string, targetId: string): ViewLayerConfig[] {
  if (draggedId === targetId) return layers
  // Positions in what the reader sees: a move left lands before the target, right after it.
  const shown = inDisplayOrder(layers)
  const fromIdx = shown.findIndex((l) => l.id === draggedId)
  const toIdx = shown.findIndex((l) => l.id === targetId)
  if (fromIdx < 0 || toIdx < 0) return layers

  const dragged = shown[fromIdx]
  const without = shown.filter((l) => l.id !== draggedId)
  const targetPos = without.findIndex((l) => l.id === targetId)
  const insertAt = fromIdx < toIdx ? targetPos + 1 : targetPos
  return renumber([...without.slice(0, insertAt), dragged, ...without.slice(insertAt)])
}

/**
 * Set (or clear, with `mode === null`) a layer's `nodeSortMode` override. Operates on the full
 * `NormalizedReferenceLayout` because entering 'custom' also SEEDS `orderKey`s: the layer's existing
 * UNKEYED assignment entries get fractional keys following `seedOrder` (the column's current visual
 * root ids), appended after the largest already-existing key so re-entering custom is idempotent and
 * never reshuffles keys a user already arranged. Leaving custom keeps the keys — they are inert in
 * alpha modes, so flipping back restores the manual arrangement. No-op returns the same layout.
 */
export function setLayerNodeSortMode(
  layout: NormalizedReferenceLayout,
  layerId: string,
  mode: LayerNodeSortMode | null,
  seedOrder?: string[],
): NormalizedReferenceLayout {
  const target = layout.layers.find((l) => l.id === layerId)
  if (!target) return layout
  const modeUnchanged = mode === null ? target.nodeSortMode === undefined : target.nodeSortMode === mode
  if (modeUnchanged && mode !== 'custom') return layout // re-selecting 'custom' may still need seeding
  const layers = layout.layers.map((l) => {
    if (l.id !== layerId) return l
    if (mode === null) {
      const { nodeSortMode: _drop, ...rest } = l
      return rest as ViewLayerConfig
    }
    return { ...l, nodeSortMode: mode }
  })

  let assignments = layout.assignments
  if (mode === 'custom' && seedOrder && seedOrder.length > 0) {
    const existingKeys = Object.values(layout.assignments)
      .filter((e) => e.layerId === layerId && e.orderKey)
      .map((e) => e.orderKey as string)
      .sort(compareOrderKeys)
    const last = existingKeys.length > 0 ? existingKeys[existingKeys.length - 1] : null
    const toSeed = seedOrder.filter((urn) => {
      const entry = layout.assignments[urn]
      return entry?.layerId === layerId && !entry.orderKey
    })
    if (toSeed.length > 0) {
      const keys = generateNKeysBetween(last, null, toSeed.length)
      assignments = { ...layout.assignments }
      toSeed.forEach((urn, i) => {
        assignments[urn] = { ...assignments[urn], orderKey: keys[i] }
      })
    }
  }
  return { ...layout, layers, assignments }
}

/**
 * Set the view-wide `defaultNodeSortMode` and clear every layer's asc/desc override so all columns
 * follow it ("Apply to all layers"). Layers in 'custom' mode keep their override — a manual
 * arrangement is a deliberate per-layer choice a view-wide default must not destroy.
 */
export function setViewDefaultSortMode(
  layout: NormalizedReferenceLayout,
  mode: LayerNodeSortAlgo,
): NormalizedReferenceLayout {
  const layers = layout.layers.map((l) => {
    if (!l.nodeSortMode || l.nodeSortMode === 'custom') return l
    const { nodeSortMode: _drop, ...rest } = l
    return rest as ViewLayerConfig
  })
  return { ...layout, layers, defaultNodeSortMode: mode }
}

/**
 * Discard a layer's manual arrangement: remove every `orderKey` on its
 * assignment entries AND clear its `nodeSortMode` override, so the column
 * falls back to the view default. Returns the same layout when there is
 * nothing to reset (no keys and no override).
 */
export function clearLayerOrderKeys(
  layout: NormalizedReferenceLayout,
  layerId: string,
): NormalizedReferenceLayout {
  const target = layout.layers.find((l) => l.id === layerId)
  const hasKeys = Object.values(layout.assignments).some(
    (e) => e.layerId === layerId && e.orderKey,
  )
  if (!hasKeys && !target?.nodeSortMode) return layout

  const layers = layout.layers.map((l) => {
    if (l.id !== layerId || l.nodeSortMode === undefined) return l
    const { nodeSortMode: _drop, ...rest } = l
    return rest as ViewLayerConfig
  })
  let assignments = layout.assignments
  if (hasKeys) {
    assignments = {}
    for (const [urn, entry] of Object.entries(layout.assignments)) {
      if (entry.layerId === layerId && entry.orderKey) {
        const { orderKey: _dropKey, ...rest } = entry
        assignments[urn] = rest
      } else {
        assignments[urn] = entry
      }
    }
  }
  return { ...layout, layers, assignments }
}

// ── Groups (a layer's `logicalNodes` tree — view-only containers) ─────────────────────────────────

type GroupNode = NonNullable<ViewLayerConfig['logicalNodes']>[number]

const mapGroups = (
  layers: ViewLayerConfig[], layerId: string, fn: (groups: GroupNode[]) => GroupNode[],
): ViewLayerConfig[] => layers.map((l) => (l.id === layerId ? { ...l, logicalNodes: fn(l.logicalNodes ?? []) } : l))

const editTree = (groups: GroupNode[], fn: (g: GroupNode) => GroupNode | null): GroupNode[] =>
  groups.flatMap((g) => {
    const next = fn(g)
    if (!next) return []
    return [{ ...next, ...(next.children ? { children: editTree(next.children, fn) } : {}) }]
  })

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** The first of `names` already taken by a group directly under `parentId` in a layer (null = its
 *  top level), ignoring `ignoreIds`. Two groups side by side with one name can't be told apart in
 *  any list or picker, so no operation may leave them — each refuses (returns its input) instead,
 *  and the UI says why with this. Groups under DIFFERENT parents may share a name: their paths differ. */
export function groupNameClash(
  layers: ViewLayerConfig[], layerId: string, parentId: string | null, names: string[], ignoreIds: string[] = [],
): string | null {
  const top = layers.find((l) => l.id === layerId)?.logicalNodes
  const siblings = (parentId ? findGroup(top, parentId)?.children : top) ?? []
  const taken = siblings.filter((g) => !ignoreIds.includes(g.id))
  return names.find((n) => taken.some((g) => sameName(g.name, n))) ?? null
}

/** Add a group to a layer — at its top, or inside `parentGroupId` (a group of groups). Refused
 *  when a group beside it already has its name. */
export function addGroup(
  layers: ViewLayerConfig[], layerId: string, group: GroupNode, parentGroupId?: string,
): ViewLayerConfig[] {
  if (groupNameClash(layers, layerId, parentGroupId ?? null, [group.name])) return layers
  if (!parentGroupId) return mapGroups(layers, layerId, (gs) => [...gs, group])
  return mapGroups(layers, layerId, (gs) =>
    editTree(gs, (g) => (g.id === parentGroupId ? { ...g, children: [...(g.children ?? []), group] } : g)))
}

/** Rename one group anywhere in a layer's tree (refused when a group beside it has that name). */
export function renameGroup(layers: ViewLayerConfig[], layerId: string, groupId: string, name: string): ViewLayerConfig[] {
  if (groupNameClash(layers, layerId, parentGroupOf(layers, layerId, groupId) ?? null, [name], [groupId])) return layers
  return mapGroups(layers, layerId, (gs) => editTree(gs, (g) => (g.id === groupId ? { ...g, name } : g)))
}

/** Every group id at or below `groupId` in a layer (what deleting it removes). */
export function groupSubtreeIds(layers: ViewLayerConfig[], layerId: string, groupId: string): string[] {
  const out: string[] = []
  const walk = (gs: GroupNode[] | undefined, inside: boolean) => gs?.forEach((g) => {
    const here = inside || g.id === groupId
    if (here) out.push(g.id)
    walk(g.children, here)
  })
  walk(layers.find((l) => l.id === layerId)?.logicalNodes, false)
  return out
}

/** Remove a group (and the groups inside it) from a layer. Members are released separately. */
export function removeGroup(layers: ViewLayerConfig[], layerId: string, groupId: string): ViewLayerConfig[] {
  return mapGroups(layers, layerId, (gs) => editTree(gs, (g) => (g.id === groupId ? null : g)))
}

/** Every group in a layer, depth-first, with its path of names ("Critical › Tier 1"). */
export function listGroups(layers: ViewLayerConfig[], layerId: string): Array<{ id: string; name: string; path: string }> {
  const out: Array<{ id: string; name: string; path: string }> = []
  const walk = (gs: GroupNode[] | undefined, trail: string[]) => gs?.forEach((g) => {
    const path = [...trail, g.name]
    out.push({ id: g.id, name: g.name, path: path.join(' › ') })
    walk(g.children, path)
  })
  walk(layers.find((l) => l.id === layerId)?.logicalNodes, [])
  return out
}

/** The group a group sits in (null = the layer's top level; undefined = not found). */
export function parentGroupOf(layers: ViewLayerConfig[], layerId: string, groupId: string): string | null | undefined {
  let found: string | null | undefined
  const walk = (gs: GroupNode[] | undefined, parent: string | null) => gs?.forEach((g) => {
    if (g.id === groupId) found = parent
    walk(g.children, g.id)
  })
  walk(layers.find((l) => l.id === layerId)?.logicalNodes, null)
  return found
}

const findGroup = (gs: GroupNode[] | undefined, id: string): GroupNode | undefined => {
  for (const g of gs ?? []) {
    if (g.id === id) return g
    const inner = findGroup(g.children, id)
    if (inner) return inner
  }
  return undefined
}

/** Move a group (with everything inside it) into another group, or to the layer's top level
 *  (`null`). No-op for a move into itself or its own descendants — a group can't contain itself. */
export function moveGroup(
  layers: ViewLayerConfig[], layerId: string, groupId: string, newParentId: string | null,
): ViewLayerConfig[] {
  if (newParentId && groupSubtreeIds(layers, layerId, groupId).includes(newParentId)) return layers
  const moving = findGroup(layers.find((l) => l.id === layerId)?.logicalNodes, groupId)
  if (!moving || groupNameClash(layers, layerId, newParentId, [moving.name], [groupId])) return layers
  return addGroup(removeGroup(layers, layerId, groupId), layerId, moving, newParentId ?? undefined)
}

/** Dismantle a group: it disappears and its sub-groups move up one level, in its place. (Its
 *  entities are lifted by `reassignGroupMembers` — to the parent group, or the layer.) Refused when
 *  a lifted sub-group would sit beside a group of the same name. */
export function ungroup(layers: ViewLayerConfig[], layerId: string, groupId: string): ViewLayerConfig[] {
  const lifted = (findGroup(layers.find((l) => l.id === layerId)?.logicalNodes, groupId)?.children ?? []).map((g) => g.name)
  if (groupNameClash(layers, layerId, parentGroupOf(layers, layerId, groupId) ?? null, lifted, [groupId])) return layers
  const lift = (gs: GroupNode[]): GroupNode[] => gs.flatMap((g) =>
    g.id === groupId ? (g.children ?? []) : [{ ...g, ...(g.children ? { children: lift(g.children) } : {}) }])
  return mapGroups(layers, layerId, lift)
}

/** Move a group's sub-groups under another group (the entities move via `reassignGroupMembers`).
 *  No-op into itself or its own descendants. The emptied group stays until deleted. */
export function moveGroupContents(
  layers: ViewLayerConfig[], layerId: string, fromId: string, toId: string,
): ViewLayerConfig[] {
  if (fromId === toId || groupSubtreeIds(layers, layerId, fromId).includes(toId)) return layers
  const subs = findGroup(layers.find((l) => l.id === layerId)?.logicalNodes, fromId)?.children ?? []
  if (subs.length === 0 || groupNameClash(layers, layerId, toId, subs.map((g) => g.name))) return layers
  const emptied = mapGroups(layers, layerId, (gs) => editTree(gs, (g) => (g.id === fromId ? { ...g, children: [] } : g)))
  return mapGroups(emptied, layerId, (gs) =>
    editTree(gs, (g) => (g.id === toId ? { ...g, children: [...(g.children ?? []), ...subs] } : g)))
}

/** Move a group, with everything inside it, to ANOTHER layer — to its top level (`null`) or into a
 *  group there. Its sub-groups go with it, and so does every entity placed in any of them (their
 *  assignments follow to the new layer; a custom order from the old column means nothing in the new
 *  one, so it is dropped). Within one layer this is `moveGroup`. Same layout when it cannot move. */
export function moveGroupToLayer(
  layout: NormalizedReferenceLayout, fromLayerId: string, groupId: string, toLayerId: string, newParentId: string | null,
): NormalizedReferenceLayout {
  if (fromLayerId === toLayerId) {
    const layers = moveGroup(layout.layers, fromLayerId, groupId, newParentId)
    return layers === layout.layers ? layout : { ...layout, layers }
  }
  const moving = findGroup(layout.layers.find((l) => l.id === fromLayerId)?.logicalNodes, groupId)
  if (!moving || !layout.layers.some((l) => l.id === toLayerId)) return layout
  if (newParentId && !findGroup(layout.layers.find((l) => l.id === toLayerId)?.logicalNodes, newParentId)) return layout
  if (groupNameClash(layout.layers, toLayerId, newParentId, [moving.name])) return layout
  const carried = new Set(groupSubtreeIds(layout.layers, fromLayerId, groupId))
  const layers = addGroup(removeGroup(layout.layers, fromLayerId, groupId), toLayerId, moving, newParentId ?? undefined)
  const assignments = { ...layout.assignments }
  for (const [urn, entry] of Object.entries(layout.assignments)) {
    if (entry.logicalNodeId && carried.has(entry.logicalNodeId) && entry.layerId === fromLayerId) {
      const { orderKey: _drop, ...rest } = entry
      assignments[urn] = { ...rest, layerId: toLayerId }
    }
  }
  return { ...layout, layers, assignments }
}

/** The names of the groups directly inside a group (what an ungroup or a move-everything lifts). */
export function childGroupNames(layers: ViewLayerConfig[], layerId: string, groupId: string): string[] {
  return (findGroup(layers.find((l) => l.id === layerId)?.logicalNodes, groupId)?.children ?? []).map((g) => g.name)
}
