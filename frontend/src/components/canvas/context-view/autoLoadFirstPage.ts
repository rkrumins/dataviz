/**
 * Should this expanded node have its FIRST page of children fetched?
 *
 * A node can become expanded without going through the toggle handler that
 * loads its page — the per-view expanded-state restore replays a saved
 * expansion set onto a freshly-hydrated canvas that has only roots, and a
 * search reveal opens a whole spine. Such a node would otherwise render as
 * an open container with nothing in it but a "Load more" row, which reads
 * as a bug. Pages 2+ stay explicit; that is the Load-more row's job.
 *
 * Extracted from the effect it used to live inside so the rule can be read
 * and tested without mounting the canvas. Its caller keeps the in-flight
 * guards (`loadingNodes` / `failedNodes`), which are about a request's
 * state rather than about whether this node needs a page at all.
 */
import type { HierarchyNode } from './types'

export interface AutoLoadFirstPageInput {
    /** Canvas node id (== URN in the ContextView layout). */
    nodeId: string
    /** The nodes the canvas is drawing. */
    displayMap: Map<string, HierarchyNode>
    /** Containment children currently loaded, by parent id. */
    childMap: Map<string, string[]>
    /**
     * Nodes whose first page is already accounted for — pages fetched
     * before, and levels a search reveal opened and furnished itself.
     *
     * The reveal marks its own levels (`markFirstPageHandled`) rather than
     * relying on `childMap` to have been populated by the containment edge
     * it primed. That inference held, but it was made in another file from
     * data the walk never checked; a reveal that promises not to fetch
     * sibling pages should be the thing that says so.
     */
    autoLoaded: ReadonlySet<string>
}

export function shouldAutoLoadFirstPage({
    nodeId,
    displayMap,
    childMap,
    autoLoaded,
}: AutoLoadFirstPageInput): boolean {
    if (autoLoaded.has(nodeId)) return false

    const node = displayMap.get(nodeId)
    if (!node) return false

    const childCount = (node.data?.childCount as number) ?? 0
    if (childCount === 0) return false

    // Already has children on the canvas — a page-2+ situation, which is
    // the Load-more row's business, not ours.
    if ((childMap.get(nodeId)?.length ?? 0) > 0) return false

    return true
}
