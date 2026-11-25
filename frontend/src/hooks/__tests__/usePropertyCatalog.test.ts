/**
 * usePropertyCatalog — what the Properties tab shows while the view's
 * catalog is read: the read so far, then the complete catalog; a refresh
 * keeps the complete one until the new one is done; a refusal is
 * "unavailable", not an error; and a view's catalog never shows under
 * another view.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useBranchStore } from '@/store/branchStore'
import type { SearchCatalogRequest, SearchCatalogResult } from '@/types/search'

import { usePropertyCatalog } from '../usePropertyCatalog'


let provider: RemoteGraphProvider
const searchCatalog = vi.fn()

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => provider,
}))


function answer(over: Partial<SearchCatalogResult>): SearchCatalogResult {
    return {
        sessionId: 'sid', status: 'complete', stale: false, entities: 0,
        entityTypes: [], properties: [], tags: [], ...over,
    }
}

beforeEach(() => {
    searchCatalog.mockReset()
    // A fresh provider per test: the hook remembers catalogs per provider.
    provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { searchCatalog })
})


describe('usePropertyCatalog', () => {
    it('shows the read so far, then the complete catalog', async () => {
        let finish: (a: SearchCatalogResult) => void = () => {}
        searchCatalog
            .mockResolvedValueOnce(answer({ status: 'running', entities: 40,
                                            progress: { scanned: 40, total: 100, matched: 40 } }))
            .mockImplementationOnce(() => new Promise((r) => { finish = r }))
        const { result } = renderHook(() => usePropertyCatalog('view-1'))

        await waitFor(() => expect(result.current.catalog?.entities).toBe(40))
        expect(result.current.reading).toBe(40)

        act(() => finish(answer({ entities: 100 })))
        await waitFor(() => expect(result.current.catalog?.status).toBe('complete'))
        expect(result.current.catalog?.entities).toBe(100)
        expect(result.current.reading).toBeNull()
    })

    it('keeps the complete catalog on screen while the view is read again', async () => {
        searchCatalog.mockResolvedValueOnce(answer({ entities: 100 }))
        const { result } = renderHook(() => usePropertyCatalog('view-1'))
        await waitFor(() => expect(result.current.catalog?.entities).toBe(100))

        let finish: (a: SearchCatalogResult) => void = () => {}
        searchCatalog
            .mockResolvedValueOnce(answer({ status: 'running', entities: 3,
                                            progress: { scanned: 3, total: 10, matched: 3 } }))
            .mockImplementationOnce(() => new Promise((r) => { finish = r }))
        act(() => result.current.refresh())
        await waitFor(() => expect(result.current.reading).toBe(30))
        expect(result.current.catalog?.entities).toBe(100)
        expect((searchCatalog.mock.calls[1][0] as SearchCatalogRequest).refresh).toBe(true)

        act(() => finish(answer({ entities: 120 })))
        await waitFor(() => expect(result.current.catalog?.entities).toBe(120))
    })

    it('reads a refusal as unavailable, not as an error', async () => {
        searchCatalog.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
        const { result } = renderHook(() => usePropertyCatalog('view-1'))
        await waitFor(() => expect(result.current.unavailable).toBe(true))
        expect(result.current.error).toBeNull()
    })

    it("never shows one view's catalog under another", async () => {
        searchCatalog.mockResolvedValueOnce(answer({ entities: 100 }))
        const { result, rerender } = renderHook(({ view }) => usePropertyCatalog(view),
                                                { initialProps: { view: 'view-1' } })
        await waitFor(() => expect(result.current.catalog?.entities).toBe(100))

        searchCatalog.mockImplementationOnce(() => new Promise(() => {}))
        rerender({ view: 'view-2' })
        expect(result.current.catalog).toBeNull()
        // A refresh asked for in the first view does not follow to the second.
        expect((searchCatalog.mock.calls[1][0] as SearchCatalogRequest).refresh).toBeUndefined()
    })

    it('reads a draft again as it changes, keeping its last complete catalog meanwhile', async () => {
        useBranchStore.setState({ graphId: 'g1', mainBranchId: 'main', currentBranchId: 'd1', draftEpoch: 0 })
        searchCatalog.mockResolvedValueOnce(answer({ entities: 100 }))
        const { result } = renderHook(() => usePropertyCatalog('view-1'))
        await waitFor(() => expect(result.current.catalog?.entities).toBe(100))
        act(() => result.current.refresh())
        await waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(2))

        // Others' saves taken in (or a bulk change's next window): read again, not refreshed —
        // the server folds what changed in — and the last complete catalog stays meanwhile.
        searchCatalog.mockImplementationOnce(() => new Promise(() => {}))
        act(() => useBranchStore.getState().bumpDraftEpoch())
        await waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(3))
        expect((searchCatalog.mock.calls[2][0] as SearchCatalogRequest).refresh).toBeUndefined()
        expect(result.current.catalog?.entities).toBe(100)
        useBranchStore.setState({ currentBranchId: null })
    })

    it('shares one read of a view between its readers — the Properties tab and the bulk dialog', async () => {
        let finish: (a: SearchCatalogResult) => void = () => {}
        searchCatalog
            .mockResolvedValueOnce(answer({ status: 'running', entities: 40,
                                            progress: { scanned: 40, total: 100, matched: 40 } }))
            .mockImplementationOnce(() => new Promise((r) => { finish = r }))
        const tab = renderHook(() => usePropertyCatalog('view-1'))
        await waitFor(() => expect(tab.result.current.catalog?.entities).toBe(40))
        // The dialog opens while the read is under way: it joins it, and hears what it heard so far.
        const dialog = renderHook(() => usePropertyCatalog('view-1'))
        expect(dialog.result.current.catalog?.entities).toBe(40)

        act(() => finish(answer({ entities: 100 })))
        await waitFor(() => expect(dialog.result.current.catalog?.entities).toBe(100))
        expect(tab.result.current.catalog?.entities).toBe(100)
        expect(searchCatalog).toHaveBeenCalledTimes(2)

        // The read stops only once neither follows it.
        const signal = () => (searchCatalog.mock.calls[1][1] as { signal: AbortSignal }).signal
        tab.unmount()
        expect(signal().aborted).toBe(false)
        dialog.unmount()
        expect(signal().aborted).toBe(true)
    })

    it("reads the relationships' catalog apart from the entities': asked for by subject, kept on its own", async () => {
        searchCatalog.mockImplementation(async (body: SearchCatalogRequest) => (body.subject === 'relationships'
            ? answer({ subject: 'relationships', entities: 31_200 }) : answer({ entities: 12_400 })))
        const entities = renderHook(() => usePropertyCatalog('view-1'))
        const relationships = renderHook(() => usePropertyCatalog('view-1', 'relationships'))
        await waitFor(() => expect(relationships.result.current.catalog?.entities).toBe(31_200))
        expect(entities.result.current.catalog?.entities).toBe(12_400)
        // Two reads, one each — the entities' asked for as it always was, without a subject.
        const bodies = searchCatalog.mock.calls.map(([body]) => body as SearchCatalogRequest)
        expect(bodies.map((b) => b.subject)).toEqual([undefined, 'relationships'])
        entities.unmount()
        relationships.unmount()

        // Each is remembered under its own subject: opened again, neither shows the other's.
        searchCatalog.mockImplementation(() => new Promise(() => {}))
        expect(renderHook(() => usePropertyCatalog('view-1', 'relationships')).result.current.catalog?.entities).toBe(31_200)
        expect(renderHook(() => usePropertyCatalog('view-1')).result.current.catalog?.entities).toBe(12_400)
    })

    it("shows a view's last complete catalog at once when it is opened again", async () => {
        searchCatalog.mockResolvedValueOnce(answer({ entities: 100 }))
        const first = renderHook(() => usePropertyCatalog('view-1'))
        await waitFor(() => expect(first.result.current.catalog?.entities).toBe(100))
        first.unmount()

        searchCatalog.mockImplementationOnce(() => new Promise(() => {}))
        const again = renderHook(() => usePropertyCatalog('view-1'))
        expect(again.result.current.catalog?.entities).toBe(100)
    })
})
