/**
 * A workspace that can't be loaded — the reader isn't a member, or it is
 * gone — stops loading, so the page can say so (and offer Request access)
 * instead of showing its skeleton for good.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { get } }))
vi.mock('@/services/catalogService', () => ({ catalogService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/ontologyDefinitionService', () => ({ ontologyDefinitionService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/providerService', () => ({ providerService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/aggregationService', () => ({ aggregationService: { getReadiness: vi.fn().mockResolvedValue(null) } }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ items: [], total: 0 }) }))
vi.mock('@/services/cacheEnvelope', () => ({ fetchEnveloped: vi.fn().mockResolvedValue({}) }))

import { useWorkspaceDetailData } from '../useWorkspaceDetailData'

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

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
        get.mockResolvedValue({ id: 'ws_fin', name: 'Finance', dataSources: [] })
        const { result } = renderHook(() => useWorkspaceDetailData('ws_fin'), { wrapper })

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.workspace?.name).toBe('Finance')
    })
})
