/**
 * The view search's hits, arranged as virtual rows under ONE container row.
 *
 * The row-level magnifier used to be destructive: it replaced a parent's
 * loaded children in the canvas store with whatever one hop of the server
 * matched, and nothing recorded what it had dropped. It is now a scoped
 * instance of the view's one search session — the loaded children stay
 * exactly where they are, and the server's hits (at ANY depth inside the
 * container) render alongside them as rows the store never sees.
 *
 * This module is the whole decision about WHICH hits get a row and what
 * each row says about where it lives. It is pure so that decision can be
 * tested without a canvas.
 */
import type { AncestorRef, SearchHit } from '@/types/search'


/** Rows beyond this go to the panel. A container can hold every match in
 *  the view, and splicing thousands of rows into a tree is neither
 *  readable nor what the panel is for. */
const DEFAULT_CAP = 50


export interface InlineSearchHitRow {
    hit: SearchHit
    /** The steps between the container and the hit — the container's own
     *  ancestors cut away, because the reader is already looking at it.
     *  Empty when the hit sits directly inside. */
    crumbs: AncestorRef[]
}

export interface InlineSearchHits {
    rows: InlineSearchHitRow[]
    /** Hits inside the container that the cap left out. */
    overflow: number
}


export function inlineSearchHits(
    parentUrn: string,
    hits: readonly SearchHit[],
    loadedChildUrns: Set<string>,
    cap: number = DEFAULT_CAP,
): InlineSearchHits {
    const rows: InlineSearchHitRow[] = []
    let overflow = 0

    for (const hit of hits) {
        // Already a row of its own under this parent. Rendering it again as
        // a hit is the one duplicate the reader would blame on the search.
        if (loadedChildUrns.has(hit.node.urn)) continue

        if (rows.length >= cap) {
            overflow += 1
            continue
        }

        // `findIndex` answering -1 (the container is not on the path the
        // server sent) slices from 0 — the whole path. Showing every step
        // that DID arrive beats showing none.
        const path = hit.ancestorPath ?? []
        rows.push({ hit, crumbs: path.slice(path.findIndex(a => a.urn === parentUrn) + 1) })
    }

    return { rows, overflow }
}
