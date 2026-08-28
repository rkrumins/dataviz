/**
 * Group search hits the way the canvas is arranged: under the top-level
 * node each one lives beneath.
 *
 * ``groupByParent`` (the older grouper) keys on the LAST entry of the
 * ancestor path — the hit's immediate parent. At depth that reads as
 * "GOLD · 4 matches" with no clue that GOLD sits under Snowflake in the
 * Warehouse column, which is the thing the user is actually looking at.
 * Grouping by the canvas root instead produces few groups (one per
 * top-level node), each mapping to something visible on screen, so the
 * list and the canvas describe the same shape.
 *
 *   ▾ WAREHOUSE · Snowflake                                  ✦ 2
 *       ◆ dim_customer123     GOLD ›                    dataset
 *       ◆ customer_id         GOLD › dim_orders ›        column
 *   ▾ SOURCE · Commerce                                      ✦ 1
 *
 * ``ancestorPath[0]`` is NOT reliably the canvas root: the local tier is
 * bounded by the canvas so it is, but the server walks the full graph
 * containment chain with no knowledge of the view and can start above
 * anything the canvas draws. So the root is resolved as the FIRST
 * ancestor the canvas actually renders as a root, and anything that
 * resolves to nothing lands in an explicit "not on this canvas" group
 * rather than being keyed silently on an off-canvas URN.
 */
import type { AncestorRef, SearchHit } from '@/types/search'


/** One top-level node the canvas renders, by URN. Carries its layer's
 *  name and colour so the group header reads in the canvas's own
 *  vocabulary ("WAREHOUSE · Snowflake") without a second lookup. */
export interface CanvasRoot {
    urn: string
    /** The canvas node id, so a group header can scroll to it. */
    id: string
    displayName: string
    entityType?: string
    layerName: string | null
    layerColor: string | null
}


export interface HitGroup {
    /** Stable key — the root URN, or ``OFF_CANVAS_KEY``. */
    key: string
    /** Null for the off-canvas group. */
    root: CanvasRoot | null
    hits: SearchHit[]
    /**
     * Index of the root within each hit's ``ancestorPath``. Rows slice
     * their breadcrumb from ``depth + 1`` so the group header isn't
     * repeated as the first chip of every row underneath it.
     *
     * -1 for the off-canvas group, where rows show the full path.
     */
    depth: number
}


export const OFF_CANVAS_KEY = '__off_canvas__'


/**
 * Bucket hits under the top-level canvas node each one sits beneath.
 *
 * Groups come back largest-first — the densest cluster is nearly always
 * where the user is heading — with the off-canvas group pinned last
 * regardless of size, because it is a caveat rather than a destination.
 */
export function groupHitsByTopLevel(
    hits: readonly SearchHit[],
    canvasRoots: ReadonlyMap<string, CanvasRoot>,
): HitGroup[] {
    const buckets = new Map<string, HitGroup>()

    for (const hit of hits) {
        const path: readonly AncestorRef[] = hit.ancestorPath ?? []
        let root: CanvasRoot | null = null
        let depth = -1

        // Nearest-to-the-top wins: the canvas root is the outermost
        // ancestor the canvas draws, not the innermost.
        for (let i = 0; i < path.length; i++) {
            const candidate = canvasRoots.get(path[i].urn)
            if (candidate) { root = candidate; depth = i; break }
        }

        // A top-level node can match the query itself. It heads its own
        // group rather than falling off the canvas.
        if (!root) {
            const self = hit.node?.urn ? canvasRoots.get(hit.node.urn) : undefined
            if (self) { root = self; depth = path.length }
        }

        const key = root?.urn ?? OFF_CANVAS_KEY
        let bucket = buckets.get(key)
        if (!bucket) {
            bucket = { key, root, hits: [], depth }
            buckets.set(key, bucket)
        }
        bucket.hits.push(hit)
    }

    const groups = Array.from(buckets.values())
    groups.sort((a, b) => {
        const aOff = a.root === null
        const bOff = b.root === null
        if (aOff !== bOff) return aOff ? 1 : -1
        return b.hits.length - a.hits.length
    })
    return groups
}
