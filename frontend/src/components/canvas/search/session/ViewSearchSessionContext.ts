/**
 * How the header box, the layer columns and the results panel reach the
 * canvas's one search session without a prop drilled through six levels
 * of canvas layout.
 *
 * Two readers, because two kinds of consumer exist:
 *   * `useViewSearchSession` — for the surfaces that only ever render
 *     inside a canvas that provides a session. A missing provider is a
 *     wiring bug, and throwing names it at the seam instead of leaving a
 *     search box that silently does nothing.
 *   * `useViewSearchSessionOptional` — for the shared components that
 *     also render on the canvases which own their own search
 *     (SearchMapPanel on GraphCanvas / HierarchyCanvas).
 */
import { createContext, useContext } from 'react'

import type { ViewSearchSession } from './useViewSearchSession'


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
