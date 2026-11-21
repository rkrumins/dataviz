/**
 * What the assistant's next question is about: the page the person is on, the view and what is
 * selected on its canvas (through the canvas bridge, live), the entity a launcher opened it on,
 * and the Advanced Search draft — unless the person removed it (the context chip's ✕), which
 * holds for this page only.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { canvasActions, subscribeCanvasActions } from '@/store/canvasActionsBridge'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaMode } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useSearchStore } from '@/store/searchStore'
import { useWorkspacesStore } from '@/store/workspaces'
import type { ChatContext } from '../api/types'
import { useAssistantStore } from '../store/assistantStore'

/** The most selected entities a question carries (the contract's cap). */
export const SELECTION_CAP = 25

export interface AssistantPageContext {
    /** This page, for "remove it from the question" — another page brings its own back. */
    pageKey: string
    /** What the next question carries. */
    context: ChatContext
    /** The view the person is on, if any. */
    view: { id: string; name?: string } | null
    selectedCount: number
    focus: { urn: string; name?: string } | null
    /** The person removed this page from the question. */
    detached: boolean
}

const PAGE_NAMES: Array<[RegExp, string]> = [
    [/^\/dashboard/, 'Dashboard'], [/^\/explorer/, 'Explorer'], [/^\/views\/?$/, 'Views'],
    [/^\/workspaces/, 'Workspaces'], [/^\/datasources/, 'Data source'], [/^\/schema/, 'Semantic layers'],
    [/^\/ingestion/, 'Ingestion'], [/^\/analytics/, 'Analytics'], [/^\/templates/, 'Templates'],
    [/^\/admin/, 'Administration'], [/^\/me|^\/my/, 'Your account'],
]

/** A page's plain name, for the context chip ("Dashboard"). */
export function pageName(pathname: string): string | null {
    return PAGE_NAMES.find(([re]) => re.test(pathname))?.[1] ?? null
}

export function useAssistantContext(): AssistantPageContext {
    const { pathname } = useLocation()
    const bridge = useSyncExternalStore(subscribeCanvasActions, canvasActions, () => null)
    // Read for their changes: the bridge's context is read fresh whenever they move.
    const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
    const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
    const routeViewId = matchPath('/views/:viewId', pathname)?.params.viewId ?? null
    const viewConfig = useSchemaStore((s) => (routeViewId ? s.schema?.views.find((v) => v.id === routeViewId) : undefined))
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const pending = useAssistantStore((s) => s.pendingContext)
    const detachedFrom = useAssistantStore((s) => s.detachedFrom)
    const draft = useSearchStore((s) => s.draftPredicate)
    const personaMode = usePersonaMode()

    return useMemo(() => {
        const canvas = bridge && bridge.viewId === routeViewId ? bridge.getContext() : null
        const pageKey = routeViewId ? `view:${routeViewId}` : `page:${pathname}`
        const detached = detachedFrom === pageKey
        const viewName = canvas?.viewName ?? viewConfig?.name
        const selected = (canvas?.selectedUrns ?? []).slice(0, SELECTION_CAP)
        const focusUrn = pending?.focusUrn ?? canvas?.focusUrn ?? undefined
        const focusName = pending?.focusUrn ? pending.focusName : canvas?.focusName
        const workspaceId = canvas?.workspaceId ?? viewConfig?.workspaceId ?? activeWorkspaceId ?? undefined
        const dataSourceId = canvas?.dataSourceId ?? viewConfig?.dataSourceId ?? activeDataSourceId ?? undefined

        const context: ChatContext = detached ? { route: pathname, personaMode } : {
            route: pathname,
            personaMode,
            ...(workspaceId ? { workspaceId } : {}),
            ...(dataSourceId ? { dataSourceId } : {}),
            ...(routeViewId ? { viewId: routeViewId } : {}),
            ...(routeViewId && viewName ? { viewName } : {}),
            ...(selected.length ? { selectedUrns: selected } : {}),
            ...(focusUrn ? { focusUrn } : {}),
            ...(routeViewId && draft ? { searchPredicate: draft } : {}),
        }
        return {
            pageKey,
            context,
            view: routeViewId ? { id: routeViewId, name: viewName } : null,
            selectedCount: selected.length,
            focus: focusUrn ? { urn: focusUrn, name: focusName } : null,
            detached,
        }
        // selectedNodeIds / drawerNodeId: the canvas's context changes with them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bridge, routeViewId, pathname, viewConfig, activeWorkspaceId, activeDataSourceId, pending, detachedFrom,
        draft, personaMode, selectedNodeIds, drawerNodeId])
}
