/**
 * Search Studio: the panel opened out over its canvas, with the one query
 * card, the answer as a table and the view's contents counted — the
 * canvas behind out of reach until Esc brings the panel back.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { EdgeHit, Predicate, SearchHit } from '@/types/search'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../../SearchMapPanel'
import { EdgeResultsTable } from '../EdgeResultsTable'
import { KEEP_MAX, ResultsTable } from '../ResultsTable'
import { SchemaInspector } from '../SchemaInspector'


const hit = (urn: string, name: string): SearchHit => ({
    node: { urn, displayName: name, entityType: 'dataset', properties: {} },
    ancestorPath: [{ urn: 'urn:gold', displayName: 'GOLD', entityType: 'container' }],
} as unknown as SearchHit)

const RESULTS = {
    kind: 'results', template: {}, inputs: {}, query: { predicate: { kind: 'tag', op: 'hasAny', values: ['PII'] } },
    result: { candidateCount: 2, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4,
        hits: [hit('a', 'orders'), hit('b', 'customers')] },
    elapsedMs: 4,
} as unknown as PanelView

const edge = (key: string, source: string, target: string, properties: Record<string, unknown> = {}): EdgeHit => ({
    key, id: key, edgeType: 'TRANSFORMS', properties,
    source: { urn: `urn:${source}`, displayName: source, entityType: 'schemaField',
        parent: { urn: 'urn:raw_orders', displayName: 'raw_orders', entityType: 'dataset' },
        ancestorPath: [{ urn: 'urn:raw_orders', displayName: 'raw_orders', entityType: 'dataset' }] },
    target: { urn: `urn:${target}`, displayName: target, entityType: 'schemaField', parent: null, ancestorPath: [] },
})

const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }

const CONNECTIONS = {
    kind: 'results', template: {}, inputs: {}, query: { predicate: { kind: 'edges', sourceWhere: PII } },
    result: { candidateCount: 1, totalCount: 1, truncated: false, deadlineExceeded: false, cacheHit: false,
        elapsedMs: 4, hits: [], edges: [edge('e1', 'amount', 'amount_usd')], edgeTypeCounts: { TRANSFORMS: 1 } },
    elapsedMs: 4,
} as unknown as PanelView

const CATALOG = {
    status: 'complete', sessionId: 's',
    entityTypes: [{ type: 'dataset', count: 13 }, { type: 'chart', count: 5 }],
    tags: [{ tag: 'PII', count: 5 }],
    properties: [{ key: 'owner', count: 4, distinct: 2, distinctExact: true,
        values: [{ value: 'alice', count: 3, kind: 'string' }] }],
}

function withProvider(extra: Record<string, unknown> = {}) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    Object.assign(provider, extra)
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
                workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
                <MemoryRouter>{children}</MemoryRouter>
            </ProviderOverride>
        )
    }
}

function renderPanel(session: ViewSearchSession) {
    return render(
        <ViewSearchSessionContext.Provider value={session}>
            <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={session.advanced}
                            onClear={session.clearQuery} />
        </ViewSearchSessionContext.Provider>,
        { wrapper: withProvider() },
    )
}


describe('Search Studio', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useSearchStore.getState().setStudioOpen(false)
        useSearchStore.getState().commitDraft({ kind: 'tag', op: 'hasAny', values: ['PII'] })
    })

    it('opens out over the canvas with the one query card, and Esc brings the panel back', async () => {
        const { container } = renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced({ view: RESULTS }) }))
        // The region it covers is wide enough for all three panes.
        container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1600, height: 900 }) as DOMRect
        fireEvent.click(screen.getByRole('button', { name: 'Open Search Studio' }))

        const studio = screen.getByRole('dialog', { name: 'Search Studio' })
        expect(screen.getAllByRole('radiogroup', { name: 'How to build the query' })).toHaveLength(1)
        expect(within(studio).getByRole('radiogroup', { name: 'How to build the query' })).toBeInTheDocument()
        expect(within(studio).getByRole('rowgroup', { name: 'Matches' })).toBeInTheDocument()
        expect(container).toHaveAttribute('inert')
        await waitFor(() => expect(document.activeElement).toBe(studio))

        fireEvent.keyDown(studio, { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Search Studio' })).not.toBeInTheDocument()
        expect(container).not.toHaveAttribute('inert')
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open Search Studio' })))
    })

    it('keeps the keys typed in it: Enter presses its buttons, and its Esc goes no further', () => {
        const { container, unmount } = renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced({ view: RESULTS }) }))
        container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1600, height: 900 }) as DOMRect
        const expand = screen.getByRole('button', { name: 'Open Search Studio' })
        expect(fireEvent.keyDown(expand, { key: 'Enter' })).toBe(true)
        fireEvent.click(expand)

        const studio = screen.getByRole('dialog', { name: 'Search Studio' })
        expect(studio).toHaveAttribute('data-keyboard-scope', 'search-studio')
        const back = within(studio).getByRole('button', { name: 'Back to the panel' })
        expect(fireEvent.keyDown(back, { key: 'Enter' })).toBe(true)
        expect(fireEvent.keyDown(back, { key: 'j' })).toBe(true)

        const canvasKeys = vi.fn()
        window.addEventListener('keydown', canvasKeys)
        fireEvent.keyDown(studio, { key: 'Escape' })
        window.removeEventListener('keydown', canvasKeys)
        expect(screen.queryByRole('dialog', { name: 'Search Studio' })).not.toBeInTheDocument()
        expect(canvasKeys).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Open Search Studio' }))
        unmount()
        expect(useSearchStore.getState().studioOpen).toBe(false)
    })

    it('opens an empty query at the field to add a filter', async () => {
        useSearchStore.getState().clear()
        renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced() }))
        fireEvent.click(screen.getByRole('button', { name: 'Open Search Studio' }))
        const studio = screen.getByRole('dialog', { name: 'Search Studio' })
        const field = within(studio).getByPlaceholderText('Search by name, tag, type, property…')
        await waitFor(() => expect(document.activeElement).toBe(field))
        await new Promise((r) => requestAnimationFrame(r))
        expect(document.activeElement).toBe(field)
    })

    it('closes on Esc with focus fallen to the page, not from a field elsewhere', () => {
        const outside = document.createElement('input')
        document.body.appendChild(outside)
        renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced({ view: RESULTS }) }))
        fireEvent.click(screen.getByRole('button', { name: 'Open Search Studio' }))
        outside.focus()
        fireEvent.keyDown(outside, { key: 'Escape' })
        expect(screen.getByRole('dialog', { name: 'Search Studio' })).toBeInTheDocument()
        outside.blur()
        fireEvent.keyDown(document.body, { key: 'Escape' })
        expect(screen.queryByRole('dialog', { name: 'Search Studio' })).not.toBeInTheDocument()
        outside.remove()
    })

    it('opens a Connections search out to its edges, and adds what the view holds to its From end', async () => {
        useSearchStore.getState().commitDraft({ kind: 'edges', sourceWhere: PII })
        const advanced = stubAdvanced({ view: CONNECTIONS })
        const { container } = render(
            <ViewSearchSessionContext.Provider value={stubSession({ refineOpen: true, advanced })}>
                <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={advanced} />
            </ViewSearchSessionContext.Provider>,
            { wrapper: withProvider({ searchCatalog: vi.fn(async () => CATALOG) }) },
        )
        container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1600, height: 900 }) as DOMRect
        fireEvent.click(screen.getByRole('button', { name: 'Open Search Studio' }))
        const studio = screen.getByRole('dialog', { name: 'Search Studio' })
        expect(within(studio).getByRole('rowgroup', { name: 'Connections' })).toBeInTheDocument()
        expect(within(studio).getByText('Click to add it to From.')).toBeInTheDocument()

        fireEvent.click(await within(studio).findByRole('button', { name: 'Find chart: 5' }))
        const next = { kind: 'edges', sourceWhere: { kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['chart'] }, PII] } }
        expect(useSearchStore.getState().draftPredicate).toEqual(next)
        expect(advanced.runPredicate).toHaveBeenLastCalledWith(next, expect.anything())
    })

    it('opens on E from the panel, never while a field is being typed in', () => {
        renderPanel(stubSession({ refineOpen: true, advanced: stubAdvanced({ view: RESULTS }) }))
        fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask about this view' }), { key: 'e' })
        expect(screen.queryByRole('dialog', { name: 'Search Studio' })).not.toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('button', { name: 'Open Search Studio' }), { key: 'e' })
        expect(screen.getByRole('dialog', { name: 'Search Studio' })).toBeInTheDocument()
    })
})


describe('ResultsTable', () => {
    const draft: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
    // jsdom lays nothing out: give the list a viewport so its rows render.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
    })
    afterEach(() => vi.restoreAllMocks())

    it('keeps only the picked rows, or leaves them out', () => {
        const onRefine = vi.fn()
        render(<ResultsTable hits={[hit('a', 'orders'), hit('b', 'customers')]} query={draft} draft={draft}
                             onRefine={onRefine} onLookInside={vi.fn()} canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Pick orders' }))
        fireEvent.click(screen.getByRole('button', { name: /Keep only these/ }))
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'group', op: 'and', children: [
            draft, { kind: 'is', refs: [{ urn: 'a' }] }] })
        fireEvent.click(screen.getByRole('button', { name: /Leave these out/ }))
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'group', op: 'and', children: [
            draft, { kind: 'group', op: 'not', children: [{ kind: 'is', refs: [{ urn: 'a' }] }] }] })
    })

    it('keeps at most as many as one condition can name', () => {
        const onRefine = vi.fn()
        const many = Array.from({ length: KEEP_MAX + 6 }, (_, i) => hit(`u${i}`, `table ${i}`))
        render(<ResultsTable hits={many} query={draft} draft={draft} onRefine={onRefine} onLookInside={vi.fn()}
                             canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Pick every loaded row' }))
        fireEvent.click(screen.getByRole('button', { name: `Keep only the first ${KEEP_MAX}` }))
        const kept = onRefine.mock.calls.at(-1)?.[0].children[1]
        expect(kept.refs).toHaveLength(KEEP_MAX)
        expect(KEEP_MAX).toBe(64)
    })

    it('narrows to a type, as the cards do, when the matches come in several', () => {
        const onRefine = vi.fn()
        const chart = { ...hit('c', 'revenue'), node: { ...hit('c', 'revenue').node, entityType: 'chart' } } as SearchHit
        render(<ResultsTable hits={[hit('a', 'orders'), hit('b', 'customers'), chart]} query={draft} draft={draft}
                             onRefine={onRefine} onLookInside={vi.fn()} canLoadMore={false} isLoadingMore={false}
                             total={3} />)
        fireEvent.click(screen.getByRole('button', { name: 'Narrow to chart: 1' }))
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['chart'] }, draft] })
    })

    it('looks inside a row\'s container', () => {
        const onLookInside = vi.fn()
        render(<ResultsTable hits={[hit('a', 'orders')]} query={draft} draft={draft} onRefine={vi.fn()}
                             onLookInside={onLookInside} canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'Look inside GOLD' }))
        expect(onLookInside).toHaveBeenCalledWith(expect.objectContaining({ urn: 'urn:gold' }))
    })
})


describe('EdgeResultsTable', () => {
    // jsdom lays nothing out: give the list a viewport so its rows render.
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
    })
    afterEach(() => vi.restoreAllMocks())

    const EDGES = [edge('e1', 'amount', 'amount_usd', { logic: 'cast' }), edge('e2', 'amount', 'margin', { logic: 'a, "b"' })]
    const rowOf = (name: string) => screen.getByRole('checkbox', { name: `Pick ${name}` }).closest('[role="row"]')

    it('reads each edge as its two ends, each with its parent, and the type between', () => {
        render(<EdgeResultsTable edges={EDGES} canLoadMore={false} isLoadingMore={false} />)
        expect(rowOf('amount to amount_usd')).toHaveTextContent(/^amountraw_ordersTransformsamount_usd—$/)
    })

    it('adds an edge property as a column', () => {
        render(<EdgeResultsTable edges={EDGES} canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'logic' }))
        expect(screen.getByRole('button', { name: 'logic' })).toHaveAttribute('aria-pressed', 'true')
        expect(rowOf('amount to amount_usd')).toHaveTextContent(/cast$/)
    })

    it('frames the picked rows’ ends on the canvas, each once, or copies them as CSV', () => {
        const onFrame = vi.fn()
        const writeText = vi.fn(async () => {})
        Object.assign(navigator, { clipboard: { writeText } })
        render(<EdgeResultsTable edges={EDGES} onFrame={onFrame} canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Pick every loaded row' }))
        expect(screen.getByText('2 picked')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Frame on canvas/ }))
        expect(onFrame).toHaveBeenCalledWith(['urn:amount', 'urn:amount_usd', 'urn:margin'])

        fireEvent.click(screen.getByRole('button', { name: 'logic' }))
        fireEvent.click(screen.getByRole('button', { name: /Copy as CSV/ }))
        expect(writeText).toHaveBeenCalledWith([
            'source,sourceParent,edgeType,target,targetParent,logic',
            'amount,raw_orders,TRANSFORMS,amount_usd,,cast',
            'amount,raw_orders,TRANSFORMS,margin,,"a, ""b"""',
        ].join('\n'))
    })

    it('loads more as the end comes into view', () => {
        const onLoadMore = vi.fn()
        render(<EdgeResultsTable edges={EDGES} canLoadMore isLoadingMore={false} onLoadMore={onLoadMore} />)
        expect(onLoadMore).toHaveBeenCalled()
    })
})


describe('SchemaInspector', () => {
    const wrapper = withProvider({ searchCatalog: vi.fn(async () => CATALOG) })

    it('adds what the view holds to the query', async () => {
        const onRefine = vi.fn()
        render(<SchemaInspector viewId="view-1" draft={{ kind: 'tag', op: 'hasAny', values: ['PII'] }}
                                onRefine={onRefine} mode="sentence" />, { wrapper })
        fireEvent.click(await screen.findByRole('button', { name: 'Find chart: 5' }))
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['chart'] }, { kind: 'tag', op: 'hasAny', values: ['PII'] }] })

        fireEvent.click(screen.getByRole('radio', { name: 'Properties' }))
        fireEvent.click(screen.getByRole('button', { name: 'Show the values of owner' }))
        fireEvent.click(screen.getByRole('button', { name: /alice/ }))
        expect(onRefine.mock.calls.at(-1)?.[0].children[1]).toEqual({ kind: 'property', key: 'owner', op: 'eq', value: 'alice' })
    })

    it('copies what to write when the query is Cypher', async () => {
        const writeText = vi.fn(async () => {})
        Object.assign(navigator, { clipboard: { writeText } })
        const onRefine = vi.fn()
        render(<SchemaInspector viewId="view-1" draft={null} onRefine={onRefine} mode="cypher" />, { wrapper })
        fireEvent.click(await screen.findByRole('button', { name: 'Copy the label dataset: 13' }))
        expect(writeText).toHaveBeenCalledWith(':dataset')
        expect(onRefine).not.toHaveBeenCalled()
    })
})
