/**
 * What an answer's buttons and entity chips do. On the Context View canvas that is showing the
 * answer's view, they act there (through the canvas bridge): reveal, locate, trace, search. Any
 * other page — another view, a Graph or Hierarchy canvas, the dashboard — gets the deep link
 * that opens the same thing: `/views/{id}?focus=`, `?trace=`, `?search=`.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { buildTraceShareLink } from '@/hooks/lib/traceShareCodec'
import { buildViewLink, buildViewShareUrl } from '@/lib/viewShareLink'
import { canvasActions, canvasActionsFor, subscribeCanvasActions, whenCanvasShows } from '@/store/canvasActionsBridge'
import type { Predicate } from '@/types/search'
import type { AssistantAction } from '../api/types'

export interface TraceTarget {
    viewId: string
    urn: string
    direction: 'downstream' | 'upstream' | 'both'
    depth?: number
}

/** The default reach of a trace an answer opens, when it names none. */
const TRACE_DEPTH = 10

const pathOf = (url: string) => {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
}

export function useAssistantActions() {
    const navigate = useNavigate()
    return useMemo(() => {
        const openView = (viewId: string) => navigate(pathOf(buildViewShareUrl(viewId)))

        const reveal = (viewId: string | undefined, urns: string[]) => {
            if (urns.length === 0) return
            const canvas = canvasActionsFor(viewId)
            if (canvas) {
                if (urns.length === 1) void canvas.reveal(urns[0])
                else void canvas.locateMany(urns)
                return
            }
            if (viewId) navigate(pathOf(buildViewLink(viewId, { focus: urns[0] })))
        }

        const openTrace = ({ viewId, urn, direction, depth = TRACE_DEPTH }: TraceTarget) => {
            const canvas = canvasActionsFor(viewId)
            if (canvas) {
                canvas.startTrace([urn], { direction, depth })
                return
            }
            const up = direction !== 'downstream'
            const down = direction !== 'upstream'
            const { url } = buildTraceShareLink(
                { urn, up, down, depthUp: up ? depth : 0, depthDown: down ? depth : 0, open: [] },
                buildViewShareUrl(viewId),
            )
            navigate(pathOf(url))
        }

        const openSearch = (viewId: string, predicate: Predicate) => {
            const canvas = canvasActionsFor(viewId)
            if (canvas) canvas.runSearch(predicate)
            else navigate(pathOf(buildViewLink(viewId, { search: predicate })))
        }

        const openCypher = (viewId: string, cypher: string) => {
            if (!whenCanvasShows(viewId, (canvas) => canvas.openCypher(cypher))) openView(viewId)
        }

        const openDoc = (href: string) => {
            if (href.startsWith('/')) navigate(href)
            else window.open(href, '_blank', 'noopener,noreferrer')
        }

        /** A §6 action from the `actions` event. Unknown kinds do nothing. */
        const run = (action: AssistantAction) => {
            const p = action.payload ?? {}
            const viewId = typeof p.viewId === 'string' ? p.viewId : undefined
            switch (action.kind) {
                case 'open_view':
                    if (viewId) openView(viewId)
                    break
                case 'open_trace':
                    if (viewId && typeof p.urn === 'string') {
                        openTrace({
                            viewId, urn: p.urn,
                            direction: p.direction === 'upstream' || p.direction === 'both' ? p.direction : 'downstream',
                            depth: typeof p.depth === 'number' ? p.depth : undefined,
                        })
                    }
                    break
                case 'open_search':
                    if (viewId && p.predicate) openSearch(viewId, p.predicate as Predicate)
                    break
                case 'reveal':
                    reveal(viewId, Array.isArray(p.urns) ? p.urns.filter((u): u is string => typeof u === 'string') : [])
                    break
                case 'open_doc':
                    if (typeof p.href === 'string') openDoc(p.href)
                    break
                case 'open_cypher':
                    if (viewId && typeof p.cypher === 'string') openCypher(viewId, p.cypher)
                    break
            }
        }

        return { openView, reveal, openTrace, openSearch, openCypher, openDoc, run }
    }, [navigate])
}

/** The view the mounted Context View canvas shows, if any — "Show on canvas" is offered only for it. */
export function useMountedCanvasViewId(): string | null {
    return useSyncExternalStore(subscribeCanvasActions, () => canvasActions()?.viewId ?? null, () => null)
}
