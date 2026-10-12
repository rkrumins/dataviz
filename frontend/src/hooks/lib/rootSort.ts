/**
 * rootSort — how a layer's ROOT nodes are ordered, in one place.
 *
 * The canvas orders the roots it renders; the wizard's Layer Studio orders the
 * same roots in its rail. They must agree, or the arrangement you build in the
 * wizard is not the one you get on the canvas — the invariant stated in
 * `useLayerAssignment` (the wizard is the user's source of truth). Extracted
 * verbatim from that hook rather than restated, for the same reason
 * `buildWizardPlacement` calls the canvas's own rule resolver.
 *
 * Sibling-scoped: a comparator only ever compares one parent's children or one
 * layer's roots, which is what lets 'custom' hold independent key sequences per
 * sibling set.
 *
 * No React — safe to unit test in isolation.
 */
import type { LayerAssignmentEntry, LayerNodeSortMode } from '@/types/schema'
import { compareOrderKeys } from '@/utils/orderKeys'

/** The minimum a node must expose to be ordered. `HierarchyNode` satisfies it. */
export interface SortableRoot {
  id: string
  name: string
  urn?: string
  typeId?: string
}

export type RootComparator<T> = (a: T, b: T) => number

/**
 * Comparators for every sort mode, bound to one layout's assignments (only
 * 'custom' reads them, for `orderKey`).
 *
 * `countOf` is supplied by the caller because "how many does it contain" is
 * read differently per surface — the canvas prefers the backend `childCount`
 * and falls back to the loaded children, the wizard has only the directory's
 * count. Everything else is shared.
 */
export function rootComparators<T extends SortableRoot>(
  assignments: Record<string, LayerAssignmentEntry>,
  countOf: (node: T) => number,
): Record<LayerNodeSortMode, RootComparator<T>> {
  const alphaAsc: RootComparator<T> = (a, b) => a.name.localeCompare(b.name)
  const alphaDesc: RootComparator<T> = (a, b) => b.name.localeCompare(a.name)

  // Type groups by the stable type id (display names would need a schema
  // lookup this layer doesn't have); container size prefers the total count.
  // Both tie-break to name so equal groups stay alphabetical inside.
  const typeAsc: RootComparator<T> = (a, b) =>
    (a.typeId || '').localeCompare(b.typeId || '') || alphaAsc(a, b)
  const countDesc: RootComparator<T> = (a, b) => countOf(b) - countOf(a) || alphaAsc(a, b)

  // Keyed siblings first (ordinal orderKey, name+urn tiebreak), unkeyed after
  // (alphabetical). Used for BOTH roots and the children of a custom-sorted
  // layer — only ever applied within one sibling set, so sharing it is safe.
  const custom: RootComparator<T> = (a, b) => {
    const ka = assignments[a.id]?.orderKey
    const kb = assignments[b.id]?.orderKey
    if (ka && kb) {
      return compareOrderKeys(ka, kb)
        || alphaAsc(a, b)
        || compareOrderKeys(a.urn ?? a.id, b.urn ?? b.id)
    }
    if (ka) return -1
    if (kb) return 1
    return alphaAsc(a, b)
  }

  return {
    'alpha-asc': alphaAsc,
    'alpha-desc': alphaDesc,
    'type-asc': typeAsc,
    'count-desc': countDesc,
    custom,
  }
}

/**
 * The comparator for a node's CHILDREN under a layer in `mode`. Children order
 * by key only in 'custom' (hierarchical custom order); every other mode leaves
 * them on the server's alphabetical order, with 'alpha-desc' flipping it.
 */
export function childComparator<T extends SortableRoot>(
  mode: LayerNodeSortMode,
  cmps: Record<LayerNodeSortMode, RootComparator<T>>,
): RootComparator<T> {
  if (mode === 'custom') return cmps.custom
  if (mode === 'alpha-desc') return cmps['alpha-desc']
  return cmps['alpha-asc']
}

/**
 * The mode a column actually sorts by: a session-local override wins, then the
 * layer's own persisted choice, then the view default, then alphabetical.
 */
export function effectiveSortMode(
  layer: { id: string; nodeSortMode?: LayerNodeSortMode },
  defaultNodeSortMode?: LayerNodeSortMode,
  override?: LayerNodeSortMode,
): LayerNodeSortMode {
  return override ?? layer.nodeSortMode ?? defaultNodeSortMode ?? 'alpha-asc'
}
