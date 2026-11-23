/**
 * Every entity one layer shows — what "Select all in <Layer>" selects, from
 * the layer's menu, from an empty column's menu, and from ⌘A in a column, so
 * the three can never disagree about what "all" is.
 *
 * "Shows" in the sense the reader means: every loaded entity placed in the
 * layer, INCLUDING those inside a folded container (they are the layer's, one
 * click away, and a bulk action on "the layer" that skipped them would be on
 * part of it). Not the rows a filter takes away: an Advanced Search in
 * Isolate or Hide mode, or a narrowing — selecting what the reader cannot see
 * is how a bulk edit lands on the wrong entities. A selected row stays, as it
 * does on the column (LayerColumn never hides a selected row). Groups
 * (`logical:` rows) are arrangement, not entities: walked into, never picked.
 */
import type { NarrowVisibility } from '@/features/narrow/model'
import type { CanvasFilterMode } from '@/store/searchStore'
import type { HierarchyNode } from '@/types/hierarchy'

export interface LayerRowFilter {
  /** An Advanced Search on the canvas: Isolate keeps matches and the way down
   *  to them, Hide takes matches away, Highlight takes nothing. */
  search?: { mode: CanvasFilterMode; matches: ReadonlySet<string>; spine: ReadonlyMap<string, number> } | null
  /** The canvas's narrowing, or null while it shows the whole view. */
  narrow?: NarrowVisibility | null
  /** What is selected already — never filtered away. */
  selected?: ReadonlySet<string>
}

/** Entity ids in the layer, top-down in the order the column draws them. */
export function selectableIdsInLayer(
  layerId: string,
  byLayer: ReadonlyMap<string, readonly HierarchyNode[]>,
  filter: LayerRowFilter = {},
): string[] {
  const { search, narrow, selected } = filter
  const filtering = !!search && search.mode !== 'highlight' && search.matches.size > 0
  const shown = (node: HierarchyNode, key: string, underWhole: boolean): boolean => {
    if (selected?.has(node.id)) return true
    // The same rule narrowRows applies: a member, the way down to one, or
    // anything inside a member whose whole inside is in scope.
    if (narrow && !(underWhole || narrow.byUrn.has(key) || narrow.ancestors.has(key))) return false
    if (!filtering) return true
    const match = search!.matches.has(key)
    return search!.mode === 'isolate' ? match || (search!.spine.get(key) ?? 0) > 0 : !match
  }

  const out = new Set<string>()
  const roots = byLayer.get(layerId) ?? []
  const stack = roots.map((node) => ({ node, underWhole: false })).reverse()
  while (stack.length > 0) {
    const { node, underWhole } = stack.pop()!
    const key = node.urn ?? node.id
    if (!node.isLogical && !node.id.startsWith('logical:') && shown(node, key, underWhole)) out.add(node.id)
    const inWhole = underWhole || !!narrow?.whole.has(key)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, underWhole: inWhole })
  }
  return [...out]
}
