/**
 * A workspace that can't be loaded — the reader isn't a member, or it is
 * gone — stops loading, so the page can say so (and offer Request access)
 * instead of showing its skeleton for good.
 *
 * And the page's reads are independent: each is keyed by the workspace id, so
 * all of them start at once (none waits for the workspace record or for
 * another), and each section has its answer as soon as its own read lands.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, getWorkspaceReadiness, listViews, getViewCounts, fetchEnveloped } = vi.hoisted(() => ({
    get: vi.fn(), getWorkspaceReadiness: vi.fn(), listViews: vi.fn(), getViewCounts: vi.fn(), fetchEnveloped: vi.fn(),
}))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get } }))
vi.mock('@/services/catalogService', () => ({ catalogService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/ontologyDefinitionService', () => ({ ontologyDefinitionService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/providerService', () => ({ providerService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/aggregationService', () => ({ aggregationService: { getWorkspaceReadiness } }))
vi.mock('@/services/viewApiService', () => ({ listViews, getViewCounts }))
vi.mock('@/services/cacheEnvelope', () => ({ fetchEnveloped }))

import { prefetchWorkspaceDetail, useWorkspaceDetailData } from '../useWorkspaceDetailData'
import { useWorkspacesStore } from '@/store/workspaces'

const FINANCE = {
    id: 'ws_fin', name: 'Finance', isDefault: false, isActive: true, createdAt: '', updatedAt: '',
    dataSources: [{ id: 'ds_a', label: 'Ledger' }, { id: 'ds_b', label: 'CRM' }],
}
const READY = { dataSourceId: 'ds_a', isReady: true, aggregationStatus: 'ready', canCreateViews: true, message: '' }
const never = () => new Promise<never>(() => {})
const page = (n: number) => ({
    items: Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `View ${i}`, dataSourceId: 'ds_a' })),
    total: 1250, hasMore: true, nextOffset: n,
})

let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    for (const fn of [get, getWorkspaceReadiness, listViews, getViewCounts, fetchEnveloped]) fn.mockReset()
    get.mockResolvedValue(FINANCE)
    fetchEnveloped.mockResolvedValue({})
    getWorkspaceReadiness.mockResolvedValue({})
    listViews.mockResolvedValue({ items: [], total: 0, hasMore: false, nextOffset: null })
    getViewCounts.mockResolvedValue({ total: 0, byWorkspace: {}, byDataSource: {} })
    useWorkspacesStore.setState({ workspaces: [] })
})

describe('useWorkspaceDetailData', () => {
    it('stops loading when the workspace can’t be opened', async () => {
        get.mockRejectedValue(new Error('Workspace not found'))
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        expect(result.current.isLoading).toBe(true)
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.workspace).toBeNull()
        expect(result.current.error).toBe('Workspace not found')
    })

    it('loads until the workspace arrives', async () => {
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.workspace?.name).toBe('Finance')
    })
})

describe('the page’s reads are independent', () => {
    it('asks for everything at once, without waiting for the workspace record', () => {
        get.mockImplementation(never)
        renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        expect(fetchEnveloped).toHaveBeenCalledWith(expect.stringContaining('cached-stats?workspace_id=ws_fin'))
        expect(getWorkspaceReadiness).toHaveBeenCalledWith('ws_fin')
        expect(listViews).toHaveBeenCalledWith({ workspaceId: 'ws_fin' })
        expect(getViewCounts).toHaveBeenCalledWith({ workspaceIds: ['ws_fin'] })
    })

    it('has each section’s answer as soon as its own read lands', async () => {
        fetchEnveloped.mockResolvedValue({ 'ws_fin/ds_a': { nodeCount: 40, edgeCount: 12, entityTypeCounts: { Table: 40 } } })
        getViewCounts.mockResolvedValue({ total: 1250, byWorkspace: { ws_fin: 1250 }, byDataSource: { ds_a: 1200, ds_b: 50 } })
        getWorkspaceReadiness.mockImplementation(never)
        listViews.mockImplementation(never)
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        await waitFor(() => expect(result.current.pending.stats).toBe(false))
        await waitFor(() => expect(result.current.viewTotal).toBe(1250))
        expect(result.current.dsStatsMap.ds_a).toEqual({ nodeCount: 40, edgeCount: 12, entityTypes: ['Table'] })
        expect(result.current.viewCountByDs).toEqual({ ds_a: 1200, ds_b: 50 })
        // The others are still on their way, and hold nobody up.
        expect(result.current.pending.readiness).toBe(true)
        expect(result.current.pending.views).toBe(true)
        expect(result.current.workspace?.name).toBe('Finance')
        // A first load is a placeholder, not a refresh.
        expect(result.current.isRefreshing).toBe(false)
    })

    it('counts exactly, never the length of the list’s first page', async () => {
        listViews.mockResolvedValue(page(50))
        getViewCounts.mockResolvedValue({ total: 1250, byWorkspace: { ws_fin: 1250 }, byDataSource: { ds_a: 1250 } })
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        await waitFor(() => expect(result.current.allWorkspaceViews).toHaveLength(50))
        await waitFor(() => expect(result.current.viewTotal).toBe(1250))
        expect(result.current.aggregateStats.totalViews).toBe(1250)
    })

    it('is not sure of a count it has not heard, rather than calling it zero', () => {
        getViewCounts.mockImplementation(never)
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })
        expect(result.current.viewTotal).toBeNull()
        expect(result.current.viewCountByDs).toBeNull()
        expect(result.current.aggregateStats.totalViews).toBeNull()
        expect(result.current.pending.viewCounts).toBe(true)
    })

    it('leaves out a source whose readiness could not be read', async () => {
        getWorkspaceReadiness.mockResolvedValue({ ds_a: READY, ds_b: null })
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        await waitFor(() => expect(result.current.pending.readiness).toBe(false))
        expect(result.current.readinessMap).toEqual({ ds_a: READY })
    })

    it('paints the workspace the app already holds at once, with its count', async () => {
        get.mockImplementation(never)
        getViewCounts.mockImplementation(never)
        useWorkspacesStore.setState({ workspaces: [{ ...FINANCE, viewCount: 7 }] as never })
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        expect(result.current.isLoading).toBe(false)
        expect(result.current.workspace?.dataSources).toHaveLength(2)
        expect(result.current.viewTotal).toBe(7)
    })

    it('opens at once once hovered: the prefetch warms every read the page makes', async () => {
        // The app's own default: what was just read is fresh for five minutes.
        client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } } })
        getViewCounts.mockResolvedValue({ total: 3, byWorkspace: { ws_fin: 3 }, byDataSource: { ds_a: 3 } })
        getWorkspaceReadiness.mockResolvedValue({ ds_a: READY })
        act(() => prefetchWorkspaceDetail(client, 'ws_fin'))
        await waitFor(() => expect(client.isFetching()).toBe(0))
        const asked = [get, fetchEnveloped, getWorkspaceReadiness, listViews, getViewCounts].map(fn => fn.mock.calls.length)
        expect(asked).toEqual([1, 1, 1, 1, 1])

        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })
        expect(result.current.isLoading).toBe(false)
        expect(result.current.viewTotal).toBe(3)
        expect(result.current.readinessMap).toEqual({ ds_a: READY })
        expect(Object.values(result.current.pending)).toEqual([false, false, false, false])
        // Nothing asked again.
        expect([get, fetchEnveloped, getWorkspaceReadiness, listViews, getViewCounts].map(fn => fn.mock.calls.length)).toEqual(asked)
    })
})
