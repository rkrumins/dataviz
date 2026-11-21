/**
 * The self-service steps in Getting started, for the people they are for:
 * whoever can't create a workspace tries the Playground and asks for one of
 * their own — whether or not they already work in a team's — with a tour that
 * shows the way; whoever creates workspaces answers those requests; a platform
 * administrator sets the Playground up.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { playground } = vi.hoisted(() => ({ playground: vi.fn() }))
vi.mock('@/services/providerService', () => ({ providerService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/catalogService', () => ({ catalogService: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/workspaceService', () => ({ workspaceService: { list: vi.fn().mockResolvedValue([{ id: 'ws_fin', dataSources: [] }]) } }))
vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn().mockResolvedValue({ total: 0 }) }))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { get: playground } }))
vi.mock('@/services/workspaceRequestsService', () => ({ workspaceRequestsService: { listMine: vi.fn().mockResolvedValue([]) } }))

import { useOnboardingProgress } from '../useOnboardingProgress'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const signIn = (global: string[], ws: Record<string, string[]> = {}) =>
    useAuthStore.setState({ permissions: { sid: 's', global, ws } } as never)

async function stepsFor() {
    const { result } = renderHook(() => useOnboardingProgress(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    return () => result.current.tracks.flatMap(t => t.steps.map(s => ({ ...s, track: t.id })))
}

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, workspaceRequestsEnabled: true } })
    playground.mockResolvedValue({ enabled: true, exists: true, joined: false, canSetUp: false, graphQuota: 5, graphsUsed: 0 })
})

describe('useOnboardingProgress — the self-service way on', () => {
    it('offers the Playground and asking for a workspace to someone already working in a team’s, after the basics', async () => {
        // Reads providers in their workspace (so it sets data up), but can't make workspaces.
        signIn([], { ws_fin: ['workspace:provider:read', 'workspace:view:create'] })
        const steps = await stepsFor()
        await waitFor(() => expect(steps().some(s => s.id === 'try-playground')).toBe(true))
        const explore = steps().filter(s => s.track === 'explore').map(s => s.id)
        expect(explore).toEqual(['create-view', 'trace-lineage', 'try-playground', 'request-workspace'])
    })

    it('shows the way to ask with the Request a workspace tour', async () => {
        signIn([])
        const steps = await stepsFor()
        await waitFor(() => expect(steps().find(s => s.id === 'request-workspace')).toBeDefined())
        expect(steps().find(s => s.id === 'request-workspace')).toMatchObject({ tourId: 'request-workspace' })
        // Someone who must join one first starts there.
        expect(steps().filter(s => s.track === 'explore')[0].id).toBe('join-workspace')
    })

    it('asks whoever creates workspaces to answer requests for them, with the approver tour', async () => {
        signIn(['system:workspaces:create'])
        const steps = await stepsFor()
        await waitFor(() => expect(steps().find(s => s.id === 'answer-workspace-requests')).toBeDefined())
        expect(steps().find(s => s.id === 'answer-workspace-requests'))
            .toMatchObject({ track: 'govern', href: '/workspaces?tab=requests', tourId: 'workspace-approver', manual: true })
        expect(steps().some(s => s.id === 'request-workspace' || s.id === 'try-playground')).toBe(false)
    })

    it('has a platform administrator set the Playground up, ticked once it exists', async () => {
        signIn(['system:admin'])
        playground.mockResolvedValue({ enabled: true, exists: false, joined: false, canSetUp: true, graphQuota: 5, graphsUsed: 0 })
        const steps = await stepsFor()
        await waitFor(() => expect(steps().find(s => s.id === 'set-up-playground')).toBeDefined())
        expect(steps().find(s => s.id === 'set-up-playground')).toMatchObject({ track: 'setup', done: false, href: '/playground' })
    })
})
