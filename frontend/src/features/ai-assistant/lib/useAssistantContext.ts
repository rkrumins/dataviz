/**
 * What the assistant's next question is about: the page the person is on (a view, from the
 * route; any other page, as it registered itself with `useAssistantPage`), what is selected on
 * the canvas (through the canvas bridge, live — or, on the Graph and Hierarchy canvases, which
 * register none, the canvas store), the entity a launcher opened it on, and the Advanced Search
 * draft — unless the person removed it (the context chip's ✕), which holds for this page only.
 *
 * A view names its own workspace and data source (the bridge's, or the view's config): never the
 * person's active ones, which on a view shared from another workspace are someone else's.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { canvasActions, subscribeCanvasActions } from '@/store/canvasActionsBridge'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaMode } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useSearchStore } from '@/store/searchStore'
import { useWorkspacesStore } from '@/store/workspaces'
import type { AssistantPage, ChatContext } from '../api/types'
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
    /** What the page is called, for the chip and the launcher ("Supply chain", "Dashboard"). */
    label: string | null
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

/** The Graph and Hierarchy canvases' selection, from the canvas store (they register no bridge). */
function canvasStoreSelection(selectedNodeIds: string[], drawerNodeId: string | null) {
    const nodes = useCanvasStore.getState().nodes
    const node = (id: string) => nodes.find((n) => n.id === id)
    const urnOf = (id: string) => node(id)?.data.urn ?? id
    return {
        selectedUrns: selectedNodeIds.slice(0, SELECTION_CAP).map(urnOf),
        focusUrn: drawerNodeId ? urnOf(drawerNodeId) : undefined,
        focusName: drawerNodeId ? node(drawerNodeId)?.data.label : undefined,
    }
}

export function useAssistantContext(): AssistantPageContext {
    const { pathname } = useLocation()
    const bridge = useSyncExternalStore(subscribeCanvasActions, canvasActions, () => null)
    // Read for their changes: the bridge's context is read fresh whenever they move.
    const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
    const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
    const routeViewId = matchPath('/views/:viewId', pathname)?.params.viewId ?? null
    const viewConfig = useSchemaStore((s) => (routeViewId ? s.schema?.views.find((v) => v.id === routeViewId) : undefined))
    const activeViewId = useSchemaStore((s) => s.activeViewId)
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const pending = useAssistantStore((s) => s.pendingContext)
    const detachedFrom = useAssistantStore((s) => s.detachedFrom)
    // A page that registered itself, while the person is still on it.
    const registered = useAssistantStore((s) => (s.page?.path === pathname ? s.page : null))
    const draft = useSearchStore((s) => s.draftPredicate)
    const personaMode = usePersonaMode()

    return useMemo(() => {
        const canvas = bridge && bridge.viewId === routeViewId ? bridge.getContext() : null
        const fromStore = !canvas && routeViewId && activeViewId === routeViewId
            ? canvasStoreSelection(selectedNodeIds, drawerNodeId) : null
        const pageKey = routeViewId ? `view:${routeViewId}` : `page:${pathname}`
        const detached = detachedFrom === pageKey
        const viewName = canvas?.viewName ?? viewConfig?.name
        const selected = (canvas?.selectedUrns ?? fromStore?.selectedUrns ?? []).slice(0, SELECTION_CAP)
        const focusUrn = pending?.focusUrn ?? canvas?.focusUrn ?? fromStore?.focusUrn ?? undefined
        const focusName = pending?.focusUrn ? pending.focusName : canvas ? canvas.focusName : fromStore?.focusName

        let workspaceId: string | undefined
        let dataSourceId: string | undefined
        if (routeViewId) {
            workspaceId = canvas?.workspaceId ?? viewConfig?.workspaceId ?? undefined
            dataSourceId = canvas?.dataSourceId ?? viewConfig?.dataSourceId ?? undefined
        } else if (registered) {
            workspaceId = registered.workspaceId ?? (registered.kind === 'workspace' ? registered.id : undefined)
                ?? activeWorkspaceId ?? undefined
            // Never a data source of another workspace; a data source page names its own (`id`).
            dataSourceId = registered.dataSourceId
                ?? (registered.kind !== 'data_source' && workspaceId === activeWorkspaceId ? activeDataSourceId ?? undefined : undefined)
        } else {
            workspaceId = activeWorkspaceId ?? undefined
            dataSourceId = activeDataSourceId ?? undefined
        }
        const page: AssistantPage | undefined = routeViewId
            ? { kind: 'view', id: routeViewId, ...(viewName ? { title: viewName } : {}) }
            : registered
                ? { kind: registered.kind, ...(registered.id ? { id: registered.id } : {}), ...(registered.title ? { title: registered.title } : {}) }
                : undefined

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
            ...(page ? { page } : {}),
        }
        return {
            pageKey,
            context,
            view: routeViewId ? { id: routeViewId, name: viewName } : null,
            selectedCount: selected.length,
            focus: focusUrn ? { urn: focusUrn, name: focusName } : null,
            detached,
            label: routeViewId ? viewName ?? 'This view' : registered?.title ?? pageName(pathname),
        }
        // selectedNodeIds / drawerNodeId: the canvas's context changes with them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bridge, routeViewId, pathname, viewConfig, activeViewId, activeWorkspaceId, activeDataSourceId, pending, detachedFrom,
        registered, draft, personaMode, selectedNodeIds, drawerNodeId])
}
