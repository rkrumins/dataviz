/**
 * useCompiledQuery — the Cypher tab's compiled query: asked with the run's
 * own request once the draft settles, never answered by a stale request,
 * and "unsupported" (not a spinner) on a data source that compiles none.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchExplainResult } from '@/types/search'

import { SEARCH_OPTIONS } from '../../searchOptions'
import { buildSearchRequest } from '../../searchRequest'
import { useCompiledQuery } from '../native/useCompiledQuery'

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))

const searchExplain = vi.fn()
let provider: unknown

const CUST: Predicate = { kind: 'text', target: 'any', match: 'substring', value: 'cust' }
const ORDERS: Predicate = { kind: 'text', target: 'any', match: 'substring', value: 'orders' }
const EXPLAINED = { cypher: 'MATCH (n) RETURN n', params: {}, notes: [] } as unknown as SearchExplainResult

function failure(status: number, body: string): Error {
    return Object.assign(new Error(`API Error ${status}: ${body}`), { status })
}

/** Let the settle timer fire and the answer land. */
async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
    })
}

beforeEach(() => {
    vi.useFakeTimers()
    searchExplain.mockReset()
    useSearchStore.getState().setScopeMode('view')
    provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { searchExplain })
})

afterEach(() => {
    vi.useRealTimers()
})


describe('useCompiledQuery', () => {
    it('is empty, and asks nothing, without a complete condition', async () => {
        const { result } = renderHook(() => useCompiledQuery(null, 'view-1'))
        await settle()
        expect(result.current).toEqual({ status: 'empty' })
        expect(searchExplain).not.toHaveBeenCalled()
    })

    it('compiles the request a run sends, once the draft settles', async () => {
        searchExplain.mockResolvedValue(EXPLAINED)
        const { result } = renderHook(() => useCompiledQuery(CUST, 'view-1'))
        expect(result.current).toEqual({ status: 'compiling' })
        expect(searchExplain).not.toHaveBeenCalled()

        await settle()

        expect(result.current).toEqual({ status: 'ok', result: EXPLAINED })
        expect(searchExplain).toHaveBeenCalledTimes(1)
        expect(searchExplain.mock.calls[0][0]).toEqual(buildSearchRequest(CUST, SEARCH_OPTIONS, 'view-1'))
    })

    it('asks once for a draft edited within the settle time', async () => {
        searchExplain.mockResolvedValue(EXPLAINED)
        const { rerender } = renderHook(({ draft }) => useCompiledQuery(draft, 'view-1'),
                                        { initialProps: { draft: CUST } })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(200)
        })
        rerender({ draft: ORDERS })
        await settle()

        expect(searchExplain).toHaveBeenCalledTimes(1)
        expect(searchExplain.mock.calls[0][0].predicate).toEqual(buildSearchRequest(ORDERS, SEARCH_OPTIONS, 'view-1').predicate)
    })

    it('cancels the request in flight when the draft changes, and ignores its answer', async () => {
        let answerFirst: (r: SearchExplainResult) => void = () => {}
        searchExplain.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
        const second = { ...EXPLAINED, cypher: 'MATCH (m) RETURN m' } as SearchExplainResult
        searchExplain.mockResolvedValueOnce(second)
        const { result, rerender } = renderHook(({ draft }) => useCompiledQuery(draft, 'view-1'),
                                                { initialProps: { draft: CUST } })
        await settle()
        const firstSignal: AbortSignal = searchExplain.mock.calls[0][1].signal

        rerender({ draft: ORDERS })
        expect(firstSignal.aborted).toBe(true)
        await settle()
        await act(async () => { answerFirst(EXPLAINED) })

        expect(result.current).toEqual({ status: 'ok', result: second })
    })

    it('says unsupported when the data source compiles no Cypher (501)', async () => {
        searchExplain.mockRejectedValue(failure(501, '{"detail":"Not implemented"}'))
        const { result } = renderHook(() => useCompiledQuery(CUST, 'view-1'))
        await settle()
        expect(result.current).toEqual({ status: 'unsupported' })
    })

    it('says what went wrong, in plain words, for any other failure', async () => {
        searchExplain.mockRejectedValue(failure(400, '{"detail":"That property does not exist"}'))
        const { result } = renderHook(() => useCompiledQuery(CUST, 'view-1'))
        await settle()
        expect(result.current).toEqual({ status: 'error', message: 'That property does not exist' })
    })

    it('says unsupported without a server to compile on', async () => {
        provider = {}
        const { result } = renderHook(() => useCompiledQuery(CUST, 'view-1'))
        await settle()
        expect(result.current).toEqual({ status: 'unsupported' })
        expect(searchExplain).not.toHaveBeenCalled()
    })
})
