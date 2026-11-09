/**
 * At a past revision the graph and hierarchy layouts search by name. The box sends one text leaf
 * on names, in the scope the layouts' own search runs in; lists the hits with the way down to
 * each; reveals one on the canvas; takes the next page by its cursor; and says why nothing but
 * names is searched.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AT_REVISION_READS } from '@/features/versioning/model/revisionCopy'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { SearchHit, SearchQuery, SearchResultPage } from '@/types/search'

import { RevisionNameSearchPanel } from '../RevisionNameSearchPanel'

const SALES = { urn: 'urn:schema:sales', displayName: 'sales', entityType: 'schema' }

const hit = (name: string): SearchHit => ({
    node: { urn: `urn:dataset:${name}`, displayName: name, entityType: 'dataset', properties: {} },
    ancestorPath: [SALES],
}) as unknown as SearchHit

/** A hit's name as its row draws it, the part matching the search marked. */
const shown = (name: string) => (_: string, el: Element | null) =>
    el?.tagName === 'SPAN' && el.textContent === name && !!el.querySelector('mark')

const page = (names: string[], cursor: string | null) =>
    ({ hits: names.map(hit), cursor, status: 'complete' }) as unknown as SearchResultPage

type Search = (query: SearchQuery, opts?: { signal?: AbortSignal }) => Promise<SearchResultPage>

function mount(search: Search) {
    const searchAdvanced = vi.fn(search)
    // A provider the panel takes for the backend's, answering only the search.
    const provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { searchAdvanced })
    const onRevealNode = vi.fn()
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws_1', dataSourceId: 'ds_1', providerReady: true, providerVersion: 1,
        } as never}>
            <RevisionNameSearchPanel viewId="v1" onClose={vi.fn()} onRevealNode={onRevealNode} />
        </ProviderOverride>,
    )
    const type = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: text } })
    return { searchAdvanced, onRevealNode, type }
}

const NAMES = {
    predicate: { kind: 'text', target: 'name', value: 'ord', match: 'substring' },
    scope: { viewId: 'v1', scopeMode: 'view' },
}

beforeEach(() => {
    useSearchStore.setState({ scopeMode: 'view' } as never)
})

describe('RevisionNameSearchPanel', () => {
    it('says why only names are searched', () => {
        mount(async () => page([], null))
        expect(screen.getByText(AT_REVISION_READS)).toBeInTheDocument()
    })

    it('searches the name typed, as one text leaf on names, and lists the hits', async () => {
        const { searchAdvanced, type } = mount(async () => page(['orders', 'orders_daily'], null))
        type('  ord ')
        await screen.findByText(shown('orders_daily'))
        expect(searchAdvanced).toHaveBeenCalledTimes(1)
        expect(searchAdvanced.mock.calls[0][0]).toEqual({ ...NAMES, options: { pageSize: 50 } })
        expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull()
    })

    it('takes the next page by the cursor the last one came with', async () => {
        const { searchAdvanced, type } = mount(async (query) => (query.options?.cursor
            ? page(['orders_2024'], null)
            : page(['orders'], 'names:50')))
        type('ord')
        fireEvent.click(await screen.findByRole('button', { name: /Load more/ }))
        await screen.findByText(shown('orders_2024'))
        expect(searchAdvanced.mock.calls[1][0]).toEqual({ ...NAMES, options: { pageSize: 50, cursor: 'names:50' } })
        expect(screen.getByText(shown('orders'))).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull()
    })

    it('reveals a hit on the canvas, down its path', async () => {
        const { onRevealNode, type } = mount(async () => page(['orders'], null))
        type('ord')
        await screen.findByText(shown('orders'))
        fireEvent.click(screen.getByRole('button', { name: /Reveal in canvas/ }))
        expect(onRevealNode).toHaveBeenCalledWith('urn:dataset:orders', [SALES])
    })

    it('shows the answer to the name typed last, whichever arrives last', async () => {
        let answerFirst: (p: SearchResultPage) => void = () => {}
        const { searchAdvanced, type } = mount((query) => (query.predicate as { value: string }).value === 'or'
            ? new Promise((resolve) => { answerFirst = resolve })
            : Promise.resolve(page(['orders'], null)))
        type('or')
        await waitFor(() => expect(searchAdvanced).toHaveBeenCalledTimes(1))
        type('ord')
        await screen.findByText(shown('orders'))
        answerFirst(page(['organisations'], null))
        await new Promise((r) => setTimeout(r, 0))
        expect(screen.queryByText(shown('organisations'))).toBeNull()
        expect(screen.getByText(shown('orders'))).toBeInTheDocument()
    })

    it('says when the names could not be searched, and asks again', async () => {
        let fail = true
        const { searchAdvanced, type } = mount(async () => {
            if (fail) throw new Error('API Error 503')
            return page(['orders'], null)
        })
        type('ord')
        expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t be searched')
        fail = false
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await screen.findByText(shown('orders'))
        expect(searchAdvanced).toHaveBeenCalledTimes(2)
    })
})
