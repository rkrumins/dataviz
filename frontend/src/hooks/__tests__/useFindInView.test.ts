/**
 * useFindInView — the header search's two tiers.
 *
 * The box this hook replaced filtered `displayFlat` with a substring
 * test, which on a lazily-hydrated canvas could only ever find the slice
 * of the view already downloaded. These specs pin the contract that
 * fixes that, and the failure modes a two-tier search invites:
 *
 *   - the local tier answers before the network does, and costs no request
 *   - the server tier runs once per burst, always scoped to the view
 *   - a slow response can never overwrite a newer one
 *   - a server failure never destroys the local answer
 *   - every published hit carries an ancestor path, or collapsed
 *     containers show no "N inside" badge and deep matches go invisible
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { HierarchyNode } from '@/types/hierarchy'
import type { SearchQuery, SearchResultPage } from '@/types/search'

/** A real RemoteGraphProvider prototype (the hook branches on
 *  `instanceof`) with only the one method it calls. */
const provider = Object.create(RemoteGraphProvider.prototype) as {
    searchAdvanced: ReturnType<typeof vi.fn>
}
provider.searchAdvanced = vi.fn()

/** Anything that isn't a live backend — a static/offline provider. */
const plainProvider = {}

let activeProvider: unknown = provider

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => activeProvider,
    useGraphProviderContext: () => ({ providerVersion: 1 }),
}))

import { useFindInView } from '../useFindInView'


function node(
    id: string,
    name: string,
    extra: Partial<HierarchyNode> = {},
): HierarchyNode {
    return {
        id, name,
        typeId: 'dataset',
        urn: id,
        data: {},
        children: [],
        depth: 0,
        entityTypeOption: 'dataset',
        tags: [],
        ...extra,
    } as HierarchyNode
}

function page(
    hits: Array<{ urn: string; displayName: string }>,
    extra: Partial<SearchResultPage> = {},
): SearchResultPage {
    return {
        hits: hits.map((h) => ({
            node: { urn: h.urn, entityType: 'dataset', displayName: h.displayName, properties: {} },
            ancestorPath: [{ urn: 'urn:parent', displayName: 'Orders', entityType: 'container' }],
        })),
        ...extra,
    } as SearchResultPage
}


const FLAT: HierarchyNode[] = [
    node('urn:a', 'revenue_gross'),
    node('urn:b', 'revenue_net'),
    node('urn:c', 'customer_id', { data: { description: 'the revenue owner' } }),
    node('urn:d', 'order_date'),
]
const DISPLAY_MAP = new Map(FLAT.map((n) => [n.id, n]))
const PARENT_MAP = new Map<string, string>()

function setup(viewId = 'view-1') {
    return renderHook(() => useFindInView({
        viewId,
        displayFlat: FLAT,
        parentMap: PARENT_MAP,
        displayMap: DISPLAY_MAP,
    }))
}


describe('useFindInView', () => {
    beforeEach(() => {
        vi.useRealTimers()
        activeProvider = provider
        provider.searchAdvanced.mockReset()
        provider.searchAdvanced.mockResolvedValue(page([]))
        useSearchStore.getState().clear()
    })

    it('answers the keystroke locally, before any request goes out', () => {
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        // Name matches plus the description match — the old box read two
        // fields and would have missed customer_id entirely.
        expect(result.current.hits.map((h) => h.node.displayName))
            .toEqual(expect.arrayContaining(['revenue_gross', 'revenue_net', 'customer_id']))
        expect(result.current.localCount).toBe(3)
        expect(provider.searchAdvanced).not.toHaveBeenCalled()
    })

    it('coalesces a burst of typing into one request', async () => {
        const { result } = setup()
        act(() => { result.current.setText('r') })
        act(() => { result.current.setText('re') })
        act(() => { result.current.setText('rev') })
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalledTimes(1))
        const query = provider.searchAdvanced.mock.calls[0][0] as SearchQuery
        expect(query.predicate).toBeTruthy()
    })

    it('always scopes to the view, even when the rail was left on "visible"', async () => {
        // Regression pin: the rail's scopeMode persists, and inheriting
        // 'visible' here would silently reinstate the loaded-only bug this
        // hook exists to fix.
        act(() => { useSearchStore.getState().setScopeMode('visible') })
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalled())
        const query = provider.searchAdvanced.mock.calls[0][0] as SearchQuery
        expect(query.scope.viewId).toBe('view-1')
        expect(query.scope.scopeMode).toBe('view')
    })

    it('asks for ancestor paths — collapsed containers need them for their badges', async () => {
        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalled())
        const query = provider.searchAdvanced.mock.calls[0][0] as SearchQuery
        expect(query.options?.includeAncestorPath).toBe(true)
        expect(query.options?.results).toBe('hits')
    })

    it('merges server hits in and dedupes by URN', async () => {
        provider.searchAdvanced.mockResolvedValue(page([
            { urn: 'urn:a', displayName: 'revenue_gross' },   // also local
            { urn: 'urn:deep', displayName: 'revenue_ytd' },  // never hydrated
        ]))
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(result.current.status).toBe('ready'))
        const urns = result.current.hits.map((h) => h.node.urn)
        expect(urns).toContain('urn:deep')
        expect(urns.filter((u) => u === 'urn:a')).toHaveLength(1)
    })

    it('never lets a stale response overwrite a newer one', async () => {
        let releaseSlow: (p: SearchResultPage) => void = () => {}
        provider.searchAdvanced
            .mockImplementationOnce(() => new Promise<SearchResultPage>((res) => { releaseSlow = res }))
            .mockResolvedValue(page([{ urn: 'urn:fresh', displayName: 'fresh' }]))

        const { result } = setup()
        act(() => { result.current.setText('slow') })
        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalledTimes(1))

        act(() => { result.current.setText('fresh') })
        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(result.current.status).toBe('ready'))

        // The first request finally lands, long after it stopped mattering.
        await act(async () => {
            releaseSlow(page([{ urn: 'urn:stale', displayName: 'stale' }]))
        })
        expect(result.current.hits.map((h) => h.node.urn)).not.toContain('urn:stale')
    })

    it('keeps the local answer when the server fails', async () => {
        provider.searchAdvanced.mockRejectedValue(new Error('backend down'))
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.errorMessage).toContain('backend down')
        expect(result.current.hits.length).toBeGreaterThan(0)
    })

    it('surfaces truncation instead of silently capping', async () => {
        provider.searchAdvanced.mockResolvedValue(
            page([{ urn: 'urn:x', displayName: 'revenue_x' }],
                { truncated: true, candidateCount: 5000 }),
        )
        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.truncated).toBe(true))
        expect(result.current.serverTotal).toBe(5000)
    })

    it('degrades to local-only without a live backend, and says so', async () => {
        activeProvider = plainProvider
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        expect(result.current.status).toBe('localOnly')
        expect(result.current.hits.length).toBeGreaterThan(0)
        expect(provider.searchAdvanced).not.toHaveBeenCalled()
    })

    it('degrades to local-only when there is no resolvable view', () => {
        const { result } = setup('')
        act(() => { result.current.setText('revenue') })
        expect(result.current.status).toBe('localOnly')
        expect(provider.searchAdvanced).not.toHaveBeenCalled()
    })

    it('publishes matches to the canvas as the header, with ancestor paths', async () => {
        const withParent = [
            node('urn:parent', 'Orders', { typeId: 'container' }),
            node('urn:child', 'revenue_line', { parentId: 'urn:parent' }),
        ]
        const { result } = renderHook(() => useFindInView({
            viewId: 'view-1',
            displayFlat: withParent,
            parentMap: new Map([['urn:child', 'urn:parent']]),
            displayMap: new Map(withParent.map((n) => [n.id, n])),
        }))
        act(() => { result.current.setText('revenue_line') })

        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.has('urn:child')).toBe(true)
        })
        expect(useSearchStore.getState().resultSource).toBe('quick')
        // The collapsed parent knows a match lives inside it.
        expect(useSearchStore.getState().ancestorMatchCounts.get('urn:parent')).toBe(1)
    })

    it('clearing takes the spotlight off the canvas', async () => {
        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.size).toBeGreaterThan(0)
        })
        act(() => { result.current.clear() })
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
        expect(result.current.text).toBe('')
    })

    it('ranks the merged list, so the best match is not the first alphabetically', async () => {
        // The backend sorts by displayName (no relevance signal in v1) and
        // returns the first page of that. Without a client-side re-rank the
        // exact match sits at the bottom of the panel.
        provider.searchAdvanced.mockResolvedValue(page([
            { urn: 'urn:x1', displayName: 'a_revenue_draft' },
            { urn: 'urn:x2', displayName: 'b_revenue_old' },
            { urn: 'urn:x3', displayName: 'revenue' },
        ]))
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.hits[0].node.displayName).toBe('revenue')
    })

    it('exposes more pages when the server says there are', async () => {
        provider.searchAdvanced.mockResolvedValue(
            page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: 'CUR1' }),
        )
        const { result } = setup()
        act(() => { result.current.setText('revenue') })

        await waitFor(() => expect(result.current.hasMore).toBe(true))
    })

    it('appends the next page rather than replacing what is on screen', async () => {
        provider.searchAdvanced
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: 'CUR1' }))
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p2', displayName: 'revenue_2' }], { cursor: null }))

        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.hasMore).toBe(true))

        act(() => { result.current.loadMore() })
        await waitFor(() => expect(result.current.hasMore).toBe(false))

        const urns = result.current.hits.map((h) => h.node.urn)
        expect(urns).toEqual(expect.arrayContaining(['urn:p1', 'urn:p2']))
    })

    it('pages the query that produced the results, carrying the cursor', async () => {
        provider.searchAdvanced
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: 'CUR1' }))
            .mockResolvedValue(page([], { cursor: null }))

        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.hasMore).toBe(true))

        act(() => { result.current.loadMore() })
        await waitFor(() => expect(provider.searchAdvanced).toHaveBeenCalledTimes(2))

        const second = provider.searchAdvanced.mock.calls[1][0] as SearchQuery
        expect(second.options?.cursor).toBe('CUR1')
        expect(second.scope.viewId).toBe('view-1')
    })

    it('does not page when there is no cursor', async () => {
        provider.searchAdvanced.mockResolvedValue(
            page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: null }))
        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.hasMore).toBe(false)

        act(() => { result.current.loadMore() })
        expect(provider.searchAdvanced).toHaveBeenCalledTimes(1)
    })

    it('publishes the widened set, so the spotlight covers the new page', async () => {
        provider.searchAdvanced
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: 'CUR1' }))
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p2', displayName: 'revenue_2' }], { cursor: null }))

        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.hasMore).toBe(true))

        act(() => { result.current.loadMore() })
        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.has('urn:p2')).toBe(true)
        })
        expect(useSearchStore.getState().matchUrnSet.has('urn:p1')).toBe(true)
    })

    it('keeps the pages it has when a load-more fails', async () => {
        provider.searchAdvanced
            .mockResolvedValueOnce(
                page([{ urn: 'urn:p1', displayName: 'revenue_1' }], { cursor: 'CUR1' }))
            .mockRejectedValueOnce(new Error('backend down'))

        const { result } = setup()
        act(() => { result.current.setText('revenue') })
        await waitFor(() => expect(result.current.hasMore).toBe(true))

        act(() => { result.current.loadMore() })
        await waitFor(() => expect(result.current.isLoadingMore).toBe(false))

        expect(result.current.errorMessage).toContain('backend down')
        expect(result.current.hits.map((h) => h.node.urn)).toContain('urn:p1')
    })

    it('leaves the rail\'s results alone', async () => {
        // The two surfaces share one result slot; the header must only
        // ever tear down results it published itself.
        act(() => {
            useSearchStore.getState().setResult({
                viewId: 'view-1', matchUrns: ['urn:rail'],
                queryHash: 'rail', source: 'advanced',
            })
        })
        const { result } = setup()
        act(() => { result.current.clear() })
        expect(useSearchStore.getState().matchUrnSet.has('urn:rail')).toBe(true)
    })
})
