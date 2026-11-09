/**
 * The graph and hierarchy layouts at a past revision of Published.
 *
 * The canvas reads the graph as it was there, so it sends nothing a revision refuses: no display
 * rule is evaluated (its matches are a search of the graph as it is now) and no rolled-up trace is
 * asked for, and the controls for both are off and say why. Nothing is edited, and the search is a
 * search of names, as they were.
 *
 * Mounted on the REAL RemoteGraphProvider at revision 12, the network stubbed. Every request that
 * reaches it is held to the server's list of what a revision answers, and the provider's own
 * refusal (made instead of sending what it knows the server refuses) is watched, so a read the
 * canvas only tried counts as much as one it sent.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import type { ComponentType } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))
// The view's library comes from the views API; the rule it would hand over is seeded below.
vi.mock('@/hooks/useViewLibrary', () => ({ useViewLibrary: () => {} }))
vi.mock('@/providers/revisionReads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/providers/revisionReads')>()
    return { ...actual, revisionRefusal: vi.fn(actual.revisionRefusal) }
})
// The drawer has tests of its own: here, what the layout hands it.
const drawer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('@/components/panels/entity/EntityDrawer', () => ({
    EntityDrawer: (props: Record<string, unknown>) => { drawer.props = props; return null },
}))

import { AT_REVISION_READS, OFF_AT_REVISION } from '@/features/versioning/model/revisionCopy'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider, readsAsItIsNow } from '@/providers/RemoteGraphProvider'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { readsAtRevision, revisionRefusal } from '@/providers/revisionReads'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { installJsdomLayout } from '@/test/canvasHarness'
import type { EntityTypeSchema } from '@/types/schema'

import { GraphCanvas } from '../GraphCanvas'
import { HierarchyCanvas } from '../HierarchyCanvas'
import { useHierarchyBuilderStore } from '../create/hierarchyBuilderStore'

const WS = 'ws_1'
const GRAPH = `/api/v1/${WS}/graph`

const visual = { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true }
const behavior = {
    selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand',
}
const ENTITY_TYPES = [
    { id: 'schema', name: 'Schema', pluralName: 'Schemas', description: '', visual, fields: [], behavior,
        hierarchy: { level: 0, canContain: ['dataset'], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] } },
    { id: 'dataset', name: 'Dataset', pluralName: 'Datasets', description: '', visual, fields: [], behavior,
        hierarchy: { level: 1, canContain: [], canBeContainedBy: ['schema'], defaultExpanded: false, rollUpFields: [] } },
] as unknown as EntityTypeSchema[]
const SCHEMA: ResolvedViewSchema = {
    entityTypes: ENTITY_TYPES, relationshipTypes: [], containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: ['TRANSFORMS'], rootEntityTypes: [],
}

const node = (urn: string, type: string, childCount = 0) => ({
    id: urn, type: 'generic', position: { x: 0, y: 0 }, data: { label: urn, type, urn, childCount },
}) as unknown as LineageNode
const edge = (id: string, source: string, target: string, edgeType: string) => ({
    id, source, target, type: 'lineage', data: { edgeType },
}) as unknown as LineageEdge

/** The way down to a hit, as `/search/names` gives it. */
const SALES = { urn: 'sales', displayName: 'sales', entityType: 'schema' }
const nameHit = (urn: string, ancestorPath: unknown[]) => ({
    node: { urn, displayName: urn, entityType: 'dataset', properties: {} }, ancestorPath,
})

const requests: Array<{ method: string; path: string; body: unknown }> = []

function okJson(body: unknown): Response {
    return {
        ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
        headers: { get: () => null },
    } as unknown as Response
}

/** The graph as it was, for the reads a revision answers. */
function answer(path: string, body: { offset?: number } | undefined): unknown {
    switch (path) {
        case '/search/names':
            return body?.offset
                ? { hits: [nameHit('report', [])], hasMore: false, nextOffset: 51 }
                : { hits: [nameHit('orders', [SALES])], hasMore: true, nextOffset: 50 }
        case '/edges/aggregated':
            return { aggregatedEdges: [], totalSourceEdges: 0 }
        default:
            return []
    }
}

/** What the canvas sent that a revision refuses, and what it asked the provider for that the
 *  provider refused in the server's place. */
function refused(): string[] {
    const sent = requests.filter(({ method, path }) => {
        const graphPath = path.startsWith(GRAPH) ? path.slice(GRAPH.length) : null
        return graphPath === null || !(readsAtRevision(method, graphPath) || readsAsItIsNow(graphPath))
    }).map(({ method, path }) => `${method} ${path}`)
    const tried = vi.mocked(revisionRefusal).mock.calls.map(([path]) => `refused ${path}`)
    return [...sent, ...tried]
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

function mountAtRevision(Canvas: ComponentType) {
    const provider = new RemoteGraphProvider({ workspaceId: WS, dataSourceId: 'ds_1', asOfSeq: 12 })
    const spies = {
        searchMembership: vi.spyOn(provider, 'searchMembership'),
        searchCounts: vi.spyOn(provider, 'searchCounts'),
        traceAtLevel: vi.spyOn(provider, 'traceAtLevel'),
        getFullLineage: vi.spyOn(provider, 'getFullLineage'),
    }
    render(
        <MemoryRouter>
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <ProviderOverride value={{
                    provider, isLoading: false, error: null, scopeKind: 'ready',
                    workspaceId: WS, dataSourceId: 'ds_1', providerReady: true, providerVersion: 1,
                } as never}>
                    <StaticViewSchemaProvider schema={SCHEMA} asOfSeq={12}>
                        <ReactFlowProvider>
                            <Canvas />
                        </ReactFlowProvider>
                    </StaticViewSchemaProvider>
                </ProviderOverride>
            </QueryClientProvider>
        </MemoryRouter>,
    )
    return spies
}

beforeAll(() => installJsdomLayout())

beforeEach(() => {
    requests.length = 0
    vi.mocked(revisionRefusal).mockClear()
    vi.mocked(fetchWithTimeout).mockImplementation(async (url, init) => {
        const { pathname } = new URL(String(url), 'http://localhost')
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        requests.push({ method: (init?.method ?? 'GET').toUpperCase(), path: pathname, body })
        return okJson(answer(pathname.slice(GRAPH.length), body))
    })
    drawer.props = null
    useSchemaStore.setState({
        activeViewId: 'v1',
        schema: {
            id: 'ws', name: 'ws', version: '1', entityTypes: ENTITY_TYPES, relationshipTypes: [], globalVisuals: {},
            containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS'], rootEntityTypes: [], defaultViewId: 'v1',
            views: [{
                id: 'v1', name: 'Sales', workspaceId: WS, dataSourceId: 'ds_1', layout: { type: 'graph' },
                content: {}, filters: {}, entityOverrides: {}, isDefault: true,
            }],
        },
    } as never)
    useCanvasStore.getState().setNodesAndEdges(
        [node('sales', 'schema', 1), node('orders', 'dataset'), node('report', 'dataset')],
        [edge('c1', 'sales', 'orders', 'CONTAINS'), edge('e1', 'orders', 'report', 'TRANSFORMS')],
    )
    useCanvasStore.setState({ hydrationPhase: 'complete', selectedNodeIds: [], drawerNodeId: null } as never)
    // A rule that, evaluated, would ask which of the canvas's entities it tags.
    useReferenceModelStore.setState({
        displayRules: [{
            id: 'r1', name: 'Orders', color: '#e11d48', enabled: true, createdAt: '2026-11-01T00:00:00Z',
            predicate: { kind: 'text', target: 'name', value: 'orders', match: 'substring' },
        }],
    } as never)
    useStagedChangesStore.setState({ changes: [], redoStack: [] } as never)
    useHierarchyBuilderStore.setState({ isOpen: false } as never)
})

/** Open an entity's right-click menu, wherever the layout draws the entity. */
function openMenuOn(urn: string) {
    const card = document.querySelector(`.react-flow__node[data-id="${urn}"]`)
        ?? document.getElementById(`hierarchy-node-${urn}`)?.querySelector('.group\\/row')
    if (!card) throw new Error(`${urn} is not on the canvas`)
    fireEvent.contextMenu(card)
}

describe.each([
    ['GraphCanvas', GraphCanvas],
    ['HierarchyCanvas', HierarchyCanvas],
] as const)('%s at a past revision', (_name, Canvas) => {
    it('evaluates no display rule, and its Properties button is off and says why', async () => {
        const spies = mountAtRevision(Canvas)
        await wait(700)
        expect(spies.searchMembership).not.toHaveBeenCalled()
        expect(spies.searchCounts).not.toHaveBeenCalled()
        expect(refused()).toEqual([])

        const properties = screen.getByRole('button', { name: 'Properties' })
        expect(properties).toBeDisabled()
        await userEvent.hover(properties.parentElement!)
        expect(await screen.findByRole('tooltip')).toHaveTextContent(OFF_AT_REVISION)
    })

    it('offers no edit from an entity’s menu, and its trace is off and says why', async () => {
        mountAtRevision(Canvas)
        await wait(50)
        openMenuOn('report')
        const trace = await screen.findByRole('button', { name: /Trace Lineage/ })
        expect(trace).toBeDisabled()
        expect(trace).toHaveAttribute('title', OFF_AT_REVISION)
        expect(screen.getByRole('button', { name: /View & Edit/ })).toBeInTheDocument()
        for (const edit of [/^Delete/, /^Duplicate/, /Add Child Entity/, /Link to/]) {
            expect(screen.queryByRole('button', { name: edit })).toBeNull()
        }
    })

    it('edits nothing and traces nothing from the keyboard', async () => {
        const spies = mountAtRevision(Canvas)
        await wait(50)
        act(() => useCanvasStore.getState().selectNode('report'))
        for (const key of [{ key: 'Delete' }, { key: 'd', metaKey: true }, { key: 'n' }, { key: 'c' }, { key: 't' }]) {
            fireEvent.keyDown(document.body, key)
        }
        await wait(50)
        expect(useStagedChangesStore.getState().changes).toEqual([])
        expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(['sales', 'orders', 'report'])
        expect(useHierarchyBuilderStore.getState().isOpen).toBe(false)
        expect(spies.traceAtLevel).not.toHaveBeenCalled()
        expect(spies.getFullLineage).not.toHaveBeenCalled()
        expect(refused()).toEqual([])
    })

    it('mounts no builder, even one left open, and hands the drawer its trace off', async () => {
        useHierarchyBuilderStore.setState({ isOpen: true, surface: 'rail' } as never)
        mountAtRevision(Canvas)
        await wait(50)
        expect(screen.queryByText('Add entities')).toBeNull()
        expect(drawer.props?.traceBlocked).toBe(OFF_AT_REVISION)
    })

    it('searches names instead, a page at a time, and reveals a hit', async () => {
        mountAtRevision(Canvas)
        fireEvent.click(screen.getByRole('button', { name: /Open advanced search/ }))
        const panel = screen.getByRole('complementary', { name: 'Search names' })
        expect(panel).toHaveTextContent(AT_REVISION_READS)

        fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'ord' } })
        fireEvent.click(await screen.findByRole('button', { name: /Load more/ }))
        await waitFor(() => expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull())
        const asked = requests.filter((r) => r.path === `${GRAPH}/search/names`).map((r) => r.body)
        expect(asked).toEqual([
            { q: 'ord', match: 'substring', limit: 50, offset: 0 },
            { q: 'ord', match: 'substring', limit: 50, offset: 50 },
        ])

        fireEvent.click(screen.getAllByRole('button', { name: /Reveal in canvas/ })[0])
        await waitFor(() => expect(useCanvasStore.getState().selectedNodeIds).toEqual(['orders']))
        expect(refused()).toEqual([])
    })
})

describe('GraphCanvas at a past revision', () => {
    it('draws no line, and a shift double-click traces nothing', async () => {
        const spies = mountAtRevision(GraphCanvas)
        await wait(50)
        const handles = document.querySelectorAll('.react-flow__handle')
        expect(handles.length).toBeGreaterThan(0)
        expect(document.querySelectorAll('.react-flow__handle.connectable')).toHaveLength(0)

        fireEvent.doubleClick(document.querySelector('.react-flow__node[data-id="report"]')!, { shiftKey: true })
        await wait(50)
        expect(spies.traceAtLevel).not.toHaveBeenCalled()
        expect(refused()).toEqual([])
    })

    it('keeps a selected card’s trace pair, off and saying why', async () => {
        mountAtRevision(GraphCanvas)
        await wait(50)
        fireEvent.click(document.querySelector('.react-flow__node[data-id="report"]')!)
        const up = await screen.findByRole('button', { name: 'Trace Upstream' })
        expect(up).toBeDisabled()
        expect(up).toHaveAttribute('title', OFF_AT_REVISION)
    })

    it('deletes no card it has selected on Backspace', async () => {
        mountAtRevision(GraphCanvas)
        await wait(50)
        fireEvent.click(document.querySelector('.react-flow__node[data-id="report"]')!)
        await screen.findByRole('button', { name: 'Trace Upstream' })
        fireEvent.keyDown(document.body, { key: 'Backspace', code: 'Backspace' })
        fireEvent.keyUp(document.body, { key: 'Backspace', code: 'Backspace' })
        await wait(50)
        expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(['sales', 'orders', 'report'])
        expect(useStagedChangesStore.getState().changes).toEqual([])
    })
})

describe('HierarchyCanvas at a past revision', () => {
    it('offers nothing to add inside a container, and a double-click renames nothing', async () => {
        mountAtRevision(HierarchyCanvas)
        await wait(50)
        expect(screen.queryByRole('button', { name: 'Add inside sales' })).toBeNull()
        fireEvent.doubleClick(screen.getByRole('heading', { name: 'sales' }))
        await wait(50)
        expect(screen.queryByDisplayValue('sales')).toBeNull()
    })
})
