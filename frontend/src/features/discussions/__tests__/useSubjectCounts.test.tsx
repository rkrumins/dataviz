/**
 * A page of cards asks for its question counts once — a hundred ids a request, never one per
 * card — under one key for the set whatever order it came in, and not at all while the switch
 * is off. Asking, replying or closing anywhere reads them again.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { thread } from './fixtures'

const api = vi.hoisted(() => ({ getSubjectSummaries: vi.fn(), askQuestion: vi.fn() }))
vi.mock('@/services/discussionsService', async (orig) => ({
    ...(await orig<typeof import('@/services/discussionsService')>()),
    ...api,
}))

import { useDiscussionActions, useSubjectCounts } from '../useDiscussions'

const COUNT = { open: 2, answered: 1, total: 3, unread: 1 }

function wrapper(qc: QueryClient) {
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
    api.getSubjectSummaries.mockReset()
    api.getSubjectSummaries.mockImplementation(async (_type: string, ids: string[]) => ({
        summaries: Object.fromEntries(ids.filter((id) => id.endsWith('7')).map((id) => [id, COUNT])),
    }))
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
})

describe('useSubjectCounts', () => {
    it('asks a hundred at a time and answers with one map', async () => {
        const ids = Array.from({ length: 250 }, (_, i) => `v${String(i).padStart(3, '0')}`)
        const { result } = renderHook(() => useSubjectCounts('view', ids), { wrapper: wrapper(client()) })
        await waitFor(() => expect(Object.keys(result.current)).toHaveLength(25))
        expect(api.getSubjectSummaries.mock.calls.map(([, chunk]) => chunk.length)).toEqual([100, 100, 50])
        expect(api.getSubjectSummaries.mock.calls.every(([type]) => type === 'view')).toBe(true)
        expect(result.current.v007).toEqual(COUNT)
    })

    it('is one entry for the set, whatever order the cards are in', async () => {
        const qc = client()
        const { result } = renderHook(() => [useSubjectCounts('data_source', ['b7', 'a7']), useSubjectCounts('data_source', ['a7', 'b7', 'a7'])],
            { wrapper: wrapper(qc) })
        await waitFor(() => expect(result.current[0].a7).toEqual(COUNT))
        expect(result.current[1]).toEqual(result.current[0])
        expect(api.getSubjectSummaries).toHaveBeenCalledTimes(1)
        expect(api.getSubjectSummaries).toHaveBeenCalledWith('data_source', ['a7', 'b7'])
        expect(qc.getQueryCache().find({ queryKey: ['discussions', 'summaries', 'data_source', 'a7,b7'] })).toBeTruthy()
    })

    it('asks nothing, and shows nothing, while the switch is off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false } })
        const { result } = renderHook(() => useSubjectCounts('view', ['v7']), { wrapper: wrapper(client()) })
        await new Promise((r) => setTimeout(r, 20))
        expect(api.getSubjectSummaries).not.toHaveBeenCalled()
        expect(result.current).toEqual({})
    })

    it('asks nothing for no cards', async () => {
        renderHook(() => useSubjectCounts('view', []), { wrapper: wrapper(client()) })
        await new Promise((r) => setTimeout(r, 20))
        expect(api.getSubjectSummaries).not.toHaveBeenCalled()
    })

    it('is read again after a question is asked', async () => {
        api.askQuestion.mockResolvedValue({ thread: thread(), reached: [], notReached: [], usedFallback: false })
        const { result } = renderHook(() => ({ counts: useSubjectCounts('view', ['v7']), actions: useDiscussionActions() }),
            { wrapper: wrapper(client()) })
        await waitFor(() => expect(result.current.counts.v7).toEqual(COUNT))
        await act(() => result.current.actions.ask.mutateAsync({
            subject: { type: 'view', id: 'v7' },
            input: { body: 'Why?', visibility: 'open', route: { viewOwners: true, dataContacts: true }, recipientIds: [], mentions: [], clientKey: 'k' },
        }))
        await waitFor(() => expect(api.getSubjectSummaries).toHaveBeenCalledTimes(2))
    })
})
