/**
 * "Load all" — walk the cursor to the end, one page at a time.
 *
 * Driven by an EFFECT rather than by an ``await`` loop, for two reasons
 * that both bite:
 *
 *   * ``loadMore`` closes over the result it is appending to, so it is a
 *     NEW function after every page. A loop that captured one would ask
 *     for page 2 forever — its cursor never moves.
 *   * ``loadMore`` parks its AbortController in the pipeline's single
 *     ``abortRef``. Two overlapping calls would leave the first
 *     unabortable, so this never issues one while ``isLoadingMore`` is
 *     true: exactly one request is in flight at any moment, and a new
 *     query (or the panel's Clear) aborts it like any other page.
 *
 * The effect re-fires on each committed page because the pipeline object
 * changes identity with its view. It stops on: the user's Stop, unmount,
 * a cursor that ran out, a cursor that did NOT move (a failed page —
 * asking again would spin), and a hard page ceiling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { UseAdvancedSearchResult } from '@/hooks/useAdvancedSearch'


/** Pages, not rows: at the shared 1 000-row page size this is 200 000
 *  hits, well past the point where "load all" is a reasonable ask. A
 *  ceiling rather than a promise — it exists so a cursor that misbehaves
 *  cannot spin the request lane forever. */
const MAX_PAGES = 200


export interface LoadAllControls {
    /** Start paging. No-op while already paging. */
    loadAll: () => void
    /** True while the loop is running. */
    isLoadingAll: boolean
    /** Stop where it is — every page already loaded stays. */
    cancelLoadAll: () => void
}


export function useLoadAll(pipeline: UseAdvancedSearchResult): LoadAllControls {
    const [isLoadingAll, setIsLoadingAll] = useState(false)
    // The cursor we last handed to `loadMore`. If it comes back around,
    // the page didn't land and re-requesting it would be a spin.
    const lastCursorRef = useRef<string | null>(null)
    const pagesRef = useRef(0)

    const loadAll = useCallback(() => {
        lastCursorRef.current = null
        pagesRef.current = 0
        setIsLoadingAll(true)
    }, [])

    const cancelLoadAll = useCallback(() => { setIsLoadingAll(false) }, [])

    useEffect(() => {
        if (!isLoadingAll) return
        if (pipeline.isLoadingMore) return

        const cursor = pipeline.view.kind === 'results'
            ? (pipeline.view.result.cursor ?? null)
            : null
        if (cursor === null || cursor === lastCursorRef.current
            || pagesRef.current >= MAX_PAGES) {
            setIsLoadingAll(false)
            return
        }
        lastCursorRef.current = cursor
        pagesRef.current += 1
        void pipeline.loadMore()
    }, [isLoadingAll, pipeline])

    return { loadAll, isLoadingAll, cancelLoadAll }
}
