/**
 * Counting as a query is edited: it waits for edits to settle, abandons a
 * count the edit made stale, remembers what it has counted, counts in the
 * search's own scope with a search's limits, stops asking where
 * counting isn't offered, and asks for nothing with live counts off.
 */
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchCountsRequest } from '@/types/search'

import { countId, type CountItem } from '../clauseItems'
import { LIVE_COUNTS_KEY, useLiveCounts } from '../liveCounts'
import { useCounts } from '../useCounts'


const item = (p: Predicate): CountItem => ({ id: countId(p), predicate: p })
const pii = item({ kind: 'tag', op: 'hasAny', values: ['PII'] })
const gdpr = item({ kind: 'tag', op: 'hasAny', values: ['GDPR'] })

function setup(answer: (body: SearchCountsRequest, opts?: { signal?: AbortSignal }) => Promise<unknown>) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    const searchCounts = vi.fn(answer)
    Object.assign(provider, { searchCounts })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
    return { searchCounts, wrapper }
}

const countsFor = (body: SearchCountsRequest, n: number) => ({
    counts: Object.fromEntries(body.items.map((i) => [i.id, { count: n, status: 'complete' }])),
})


describe('useCounts', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        localStorage.clear()
        useSearchStore.getState().clear()
    })
    afterEach(() => vi.useRealTimers())

    it('waits for edits to settle, then counts in the search\'s scope with a search\'s limits', async () => {
        const { searchCounts, wrapper } = setup(async (body) => countsFor(body, 12))
        const { result } = renderHook(() => useCounts('view-a', [pii]), { wrapper })

        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(searchCounts).not.toHaveBeenCalled()
        expect(result.current.status).toBe('counting')

        await act(async () => { await vi.advanceTimersByTimeAsync(400) })
        expect(searchCounts).toHaveBeenCalledTimes(1)
        const [body] = searchCounts.mock.calls[0]
        expect(body.purpose).toBe('search')
        expect(body.scope).toMatchObject({ viewId: 'view-a', scopeMode: useSearchStore.getState().scopeMode })
        expect(result.current.status).toBe('done')
        expect(result.current.counts.get(pii.id)).toEqual({ count: 12, complete: true })
    })

    it('abandons a count an edit made stale', async () => {
        const { searchCounts, wrapper } = setup(async (body) => countsFor(body, 3))
        const { rerender } = renderHook(({ items }) => useCounts('view-b', items),
            { wrapper, initialProps: { items: [pii] } })
        await act(async () => { await vi.advanceTimersByTimeAsync(200) })
        rerender({ items: [gdpr] })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).toHaveBeenCalledTimes(1)
        expect(searchCounts.mock.calls[0][0].items.map((i) => i.id)).toEqual([gdpr.id])
    })

    it('shows a count it already has at once, and asks only for the rest', async () => {
        const { searchCounts, wrapper } = setup(async (body) => countsFor(body, 5))
        const first = renderHook(() => useCounts('view-c', [pii]), { wrapper })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        first.unmount()

        const { result } = renderHook(() => useCounts('view-c', [pii, gdpr]), { wrapper })
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        expect(result.current.counts.get(pii.id)?.count).toBe(5)     // before any request
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).toHaveBeenCalledTimes(2)
        expect(searchCounts.mock.calls[1][0].items.map((i) => i.id)).toEqual([gdpr.id])
    })

    it('says counting isn\'t offered, once, where the server refuses it', async () => {
        const { searchCounts, wrapper } = setup(async () => {
            throw Object.assign(new Error('API Error 501'), { status: 501 })
        })
        const { result, rerender } = renderHook(({ items }) => useCounts('view-d', items),
            { wrapper, initialProps: { items: [pii] } })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(result.current.status).toBe('unavailable')
        rerender({ items: [gdpr] })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).toHaveBeenCalledTimes(1)
        expect(result.current.status).toBe('unavailable')
    })

    it('asks for nothing with live counts off, and counts again once they are on', async () => {
        localStorage.setItem(LIVE_COUNTS_KEY, 'off')
        const { searchCounts, wrapper } = setup(async (body) => countsFor(body, 8))
        const { result } = renderHook(() => ({ counts: useCounts('view-f', [pii]), live: useLiveCounts() }),
            { wrapper })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).not.toHaveBeenCalled()
        expect(result.current.counts.status).toBe('off')

        act(() => result.current.live[1](true))
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).toHaveBeenCalledTimes(1)
        expect(result.current.counts.counts.get(pii.id)).toEqual({ count: 8, complete: true })
    })

    it('abandons a count under way when live counts are turned off', async () => {
        let signal: AbortSignal | undefined
        const { searchCounts, wrapper } = setup((_body, opts) => {
            signal = opts?.signal
            return new Promise(() => {})
        })
        const { result } = renderHook(() => ({ counts: useCounts('view-g', [pii]), live: useLiveCounts() }),
            { wrapper })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).toHaveBeenCalledTimes(1)
        expect(signal?.aborted).toBe(false)

        act(() => result.current.live[1](false))
        expect(signal?.aborted).toBe(true)
        expect(result.current.counts.status).toBe('off')
    })

    it('asks for nothing when there is nothing to count', async () => {
        const { searchCounts, wrapper } = setup(async (body) => countsFor(body, 1))
        const { result } = renderHook(() => useCounts('view-e', []), { wrapper })
        await act(async () => { await vi.advanceTimersByTimeAsync(700) })
        expect(searchCounts).not.toHaveBeenCalled()
        expect(result.current.status).toBe('idle')
    })
})
