/**
 * Search Studio: the panel opened out over its canvas, with the one query
 * card, the answer as a table and the view's contents counted — the
 * canvas behind out of reach until Esc brings the panel back.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchHit } from '@/types/search'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../../SearchMapPanel'
import { ResultsTable } from '../ResultsTable'
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

function withProvider(extra: Record<string, unknown> = {}) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    Object.assign(provider, extra)
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
                workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
                {children}
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
        await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Ask about this view'))

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

    it('looks inside a row\'s container', () => {
        const onLookInside = vi.fn()
        render(<ResultsTable hits={[hit('a', 'orders')]} query={draft} draft={draft} onRefine={vi.fn()}
                             onLookInside={onLookInside} canLoadMore={false} isLoadingMore={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'Look inside GOLD' }))
        expect(onLookInside).toHaveBeenCalledWith(expect.objectContaining({ urn: 'urn:gold' }))
    })
})


describe('SchemaInspector', () => {
    const catalog = {
        status: 'complete', sessionId: 's',
        entityTypes: [{ type: 'dataset', count: 13 }, { type: 'chart', count: 5 }],
        tags: [{ tag: 'PII', count: 5 }],
        properties: [{ key: 'owner', count: 4, distinct: 2, distinctExact: true,
            values: [{ value: 'alice', count: 3, kind: 'string' }] }],
    }
    const wrapper = withProvider({ searchCatalog: vi.fn(async () => catalog) })

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
