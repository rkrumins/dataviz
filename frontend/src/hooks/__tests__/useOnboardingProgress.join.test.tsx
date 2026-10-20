/**
 * Someone who can't create a workspace starts Getting started by joining
 * one — through Find a workspace while it is on, My access while it is off
 * — and the step ticks itself off once they belong to one.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { workspaces } = vi.hoisted(() => ({ workspaces: vi.fn() }))
vi.mock('@/services/providerService', () => ({ providerService: { list: vi.fn().mockRejectedValue(new Error('403')) } }))
vi.mock('@/services/catalogService', () => ({ catalogService: { list: vi.fn().mockRejectedValue(new Error('403')) } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: workspaces } }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ total: 0 }) }))

import { useOnboardingProgress } from '../useOnboardingProgress'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const joinStep = (result: { current: ReturnType<typeof useOnboardingProgress> }) =>
    result.current.tracks.flatMap(t => t.steps).find(s => s.id === 'join-workspace')

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { sid: 's', global: [], ws: {} } } as never)
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceDirectoryEnabled: true } })
    workspaces.mockResolvedValue([])
})

describe('useOnboardingProgress — joining a workspace', () => {
    it('starts someone with no workspace at Find a workspace', async () => {
        const { result } = renderHook(() => useOnboardingProgress(), { wrapper })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(joinStep(result)).toMatchObject({ done: false, href: '/workspaces?tab=discover', guideSlug: 'requesting-access' })
    })

    it('points to My access while Find a workspace is off, and ticks off once they are in one', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        workspaces.mockResolvedValue([{ id: 'ws_fin', dataSources: [] }])
        const { result } = renderHook(() => useOnboardingProgress(), { wrapper })
        await waitFor(() => expect(joinStep(result)?.done).toBe(true))
        expect(joinStep(result)?.href).toBe('/my/access')
    })

    it('is not for someone who can create workspaces', async () => {
        useAuthStore.setState({ permissions: { sid: 's', global: ['system:workspaces:create'], ws: {} } } as never)
        const { result } = renderHook(() => useOnboardingProgress(), { wrapper })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(joinStep(result)).toBeUndefined()
    })
})
