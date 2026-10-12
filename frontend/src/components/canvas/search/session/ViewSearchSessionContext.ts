/**
 * How the header box, the layer columns and the results panel reach the
 * canvas's one search session without a prop drilled through six levels
 * of canvas layout. The session itself is built by
 * `useViewSearchSessionController`.
 *
 * Two readers, because two kinds of consumer exist:
 *   * `useViewSearchSession` — for the surfaces that only ever render
 *     inside a canvas that provides a session. A missing provider is a
 *     wiring bug, and throwing names it at the seam instead of leaving a
 *     search box that silently does nothing.
 *   * `useViewSearchSessionOptional` — for the shared components that
 *     also render on the canvases which own their own search
 *     (SearchMapPanel on GraphCanvas / HierarchyCanvas).
 *
 * And a SECOND context, `ViewRowSearchContext`, carrying the narrow
 * slice the layer columns read. Not a convenience: the session object
 * changes identity on every character typed in the header box, and a
 * column memoises an O(rows) flat tree on what it reads, so a column
 * subscribed to the session rebuilt itself — and every other column on
 * the board — per keystroke, with no row box open anywhere. The row
 * slice is referentially stable until a box actually clamps the search
 * to a container. Columns read `useViewRowSearch()` and nothing else.
 */
import { createContext, useContext } from 'react'

import type {
    ViewRowSearch,
    ViewSearchSession,
} from './useViewSearchSessionController'


export const ViewSearchSessionContext = createContext<ViewSearchSession | null>(null)


export function useViewSearchSession(): ViewSearchSession {
    const session = useContext(ViewSearchSessionContext)
    if (!session) {
        throw new Error(
            'useViewSearchSession must be used inside a ViewSearchSessionContext provider',
        )
    }
    return session
}


export function useViewSearchSessionOptional(): ViewSearchSession | null {
    return useContext(ViewSearchSessionContext)
}


const NOOP = () => {}

/**
 * The answer on a canvas that provides no session — GraphCanvas and
 * HierarchyCanvas render columns without one.
 *
 * A row search holding nothing, rather than a null every call site would
 * have to check or a throw those canvases don't deserve. Module-level so
 * it is the same object on every render: a column memoises on it.
 */
export const ROW_SEARCH_IDLE: ViewRowSearch = {
    scope: null,
    quick: null,
    resultMatchesQuick: false,
    view: null,
    setQuick: NOOP,
    clearScope: NOOP,
    openPanel: NOOP,
}


export const ViewRowSearchContext = createContext<ViewRowSearch>(ROW_SEARCH_IDLE)


export function useViewRowSearch(): ViewRowSearch {
    return useContext(ViewRowSearchContext)
}
