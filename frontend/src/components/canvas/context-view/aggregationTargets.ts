/**
 * The entities the canvas asks `/edges/aggregated` about: every row the
 * reader can see and has not opened.
 *
 * Read off the RENDERED tree, not the store. An anchored column draws its
 * anchor as the column itself and the anchor's children as its rows, so in
 * the store every row sits under a parent that is never "expanded". Walking
 * store parents made the anchors the targets and the rows never, and the
 * rows got no roll-up lines at all.
 *
 * An open row stands aside for its children: asking about both would count
 * the same flows at two levels. A logical group is view-only, so the server
 * cannot aggregate to it; its members are asked about whether the group is
 * open or closed, and their lines roll up to it on the client.
 */
import type { HierarchyNode } from '@/types/hierarchy'

export function renderedAggregationTargets(
  nodesByLayer: ReadonlyMap<string, readonly HierarchyNode[]>,
  expandedNodes: ReadonlySet<string>,
): string[] {
  const targets = new Set<string>()
  const stack: HierarchyNode[] = []
  nodesByLayer.forEach(roots => { for (const root of roots) stack.push(root) })
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.isLogical || expandedNodes.has(node.id)) {
      for (const child of node.children) stack.push(child)
    } else {
      targets.add(node.urn || node.id)
    }
  }
  return [...targets]
}
