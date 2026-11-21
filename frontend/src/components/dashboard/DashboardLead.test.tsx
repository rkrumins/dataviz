/**
 * What the Dashboard leads with, by persona. Business: what is the reader's to
 * do — reviews, their requests, the Playground. Technical, for someone who can
 * read a data source: how the data is doing — what failed, what's behind, what
 * is building, the connections — each with the one place to see why. A line
 * above says which it is and switches it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { aggregation, reviewCounts, myRequests, accessRequests, playground } = vi.hoisted(() => ({
    aggregation: { getProjectionHealth: vi.fn(), getReadiness: vi.fn(), getJobsSummary: vi.fn() },
    reviewCounts: vi.fn(),
    myRequests: vi.fn(),
    accessRequests: vi.fn(),
    playground: vi.fn(),
}))
vi.mock('@/services/aggregationService', () => ({ aggregationService: aggregation }))
vi.mock('@/features/versioning/hooks/useVersioning', async () => ({
    ...await vi.importActual<object>('@/features/versioning/hooks/useVersioning'),
    useReviewCenterCounts: reviewCounts,
}))
vi.mock('@/hooks/useWorkspaceRequests', async () => ({
    ...await vi.importActual<object>('@/hooks/useWorkspaceRequests'),
    useMyWorkspaceRequests: myRequests,
}))
vi.mock('@/hooks/useWorkspaceAccess', async () => ({
    ...await vi.importActual<object>('@/hooks/useWorkspaceAccess'),
    useMyAccessRequests: accessRequests,
}))
vi.mock('@/hooks/usePlayground', async () => ({
    ...await vi.importActual<object>('@/hooks/usePlayground'),
    usePlayground: playground,
}))

import { DashboardLead } from './DashboardLead'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { useProviderStatusStore } from '@/store/providerStatus'
import { useWorkspacesStore } from '@/store/workspaces'

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const source = (id: string, label: string, aggregationStatus: string, h = 5) => ({
    id, label, aggregationStatus, isActive: true, lastAggregatedAt: ago(h), createdAt: ago(h + 200),
})

const signIn = (global: string[], ws: Record<string, string[]>) =>
    useAuthStore.setState({ permissions: { sid: 't', global, ws } } as never)

function renderLead() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter><DashboardLead /></MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacesStore.setState({
        workspaces: [
            { id: 'ws_fin', name: 'Finance Risk', dataSources: [
                source('ds_gl', 'General Ledger', 'ready'), source('ds_risk', 'Risk Models', 'failed', 30),
                source('ds_reg', 'Regulatory Reporting', 'running'), source('ds_new', 'Treasury feed', 'none'),
            ] },
            { id: 'ws_pg', name: 'Playground', kind: 'playground', dataSources: [source('ds_pg', 'My sketch', 'failed')] },
        ],
    } as never)
    signIn([], { ws_fin: ['workspace:datasource:read', 'workspace:datasource:manage', 'workspace:provider:read'] })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, workspaceRequestsEnabled: true } })
    useProviderStatusStore.setState({ statuses: {
        p1: { id: 'p1', name: 'FalkorDB prod', status: 'ready', lastCheckedAt: null },
        p2: { id: 'p2', name: 'Neo4j archive', status: 'unavailable', lastCheckedAt: null, error: 'refused' },
    } })
    aggregation.getProjectionHealth.mockResolvedValue({ dataSourceId: 'ds_gl', projectorCurrent: false, projectionCommitsBehind: 4 })
    aggregation.getReadiness.mockImplementation(async (id: string) => ({
        dataSourceId: id, isReady: false, aggregationStatus: id === 'ds_risk' ? 'failed' : 'running',
        activeJob: id === 'ds_risk'
            ? { id: 'j1', status: 'failed', progress: 62, errorMessage: 'FalkorDB timeout after 900s' }
            : { id: 'j2', status: 'running', progress: 41, currentPhase: 'computing' },
    }))
    aggregation.getJobsSummary.mockResolvedValue({ total: 120, byStatus: { failed: 6 }, successRate: 95, avgDurationSeconds: 240 })
    reviewCounts.mockReturnValue({ data: { counts: { needs_review: 3, sent_back: 1 } } })
    myRequests.mockReturnValue({ data: [{ id: 'r1', name: 'ML platform lineage', status: 'changes_requested', createdAt: ago(50), teammateIds: [], playgroundSourceIds: [] }] })
    accessRequests.mockReturnValue({ requests: [{ id: 'a1' }] })
    playground.mockReturnValue({ data: { enabled: true, exists: true, joined: true, graphsUsed: 2, graphQuota: 5 } })
})

describe('DashboardLead — Business view', () => {
    beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

    it('leads with what is the reader’s to do', () => {
        renderLead()
        expect(screen.getByText('Business view')).toBeInTheDocument()
        expect(screen.getByText('3 reviews waiting for you')).toBeInTheDocument()
        expect(screen.getByText('Your workspace request')).toBeInTheDocument()
        expect(screen.getByText(/“ML platform lineage” · They asked you a question/)).toBeInTheDocument()
        expect(screen.getByText(/1 request to join waiting/)).toBeInTheDocument()
        expect(screen.getByText('Keep experimenting')).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'Data health' })).not.toBeInTheDocument()
    })

    it('points each tile at the one place to go', () => {
        renderLead()
        expect(screen.getByText('3 reviews waiting for you').closest('a')).toHaveAttribute('href', '/reviews')
        expect(screen.getByText('Your workspace request').closest('a')).toHaveAttribute('href', '/my/access?tab=workspaces')
        expect(screen.getByText('Keep experimenting').closest('a')).toHaveAttribute('href', '/playground')
    })

    it('offers to ask for a workspace when there is no request yet', () => {
        myRequests.mockReturnValue({ data: [] })
        accessRequests.mockReturnValue({ requests: [] })
        renderLead()
        expect(screen.getByText('Need a workspace of your own?')).toBeInTheDocument()
    })

    it('switches to the Technical view from the line above', async () => {
        renderLead()
        fireEvent.click(screen.getByRole('button', { name: 'Switch to Technical' }))
        expect(usePersonaStore.getState().mode).toBe('technical')
        expect(await screen.findByRole('heading', { name: 'Data health' })).toBeInTheDocument()
    })
})

describe('DashboardLead — Technical view', () => {
    beforeEach(() => usePersonaStore.setState({ mode: 'technical' }))

    it('leads with data health: what needs a look, worst first, and what is building', async () => {
        renderLead()
        expect(screen.getByText('Technical view')).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'Data health' })).toBeInTheDocument()
        const look = screen.getByRole('region', { name: 'Sources that need a look' })
        // The Playground's experiments are no one's to look after.
        expect(within(look).queryByText('My sketch')).not.toBeInTheDocument()
        await waitFor(() => expect(within(look).getByText('General Ledger')).toBeInTheDocument())
        const rows = within(look).getAllByRole('listitem').map(li => li.textContent ?? '')
        expect(rows[0]).toContain('Risk Models')
        expect(rows[0]).toContain('FalkorDB timeout after 900s')
        expect(rows[1]).toContain('4 published changes not in its connections yet')
        expect(rows[2]).toContain('Treasury feed')
        const building = screen.getByRole('region', { name: 'Building now' })
        await waitFor(() => expect(within(building).getByText(/41% · computing/)).toBeInTheDocument())
    })

    it('sends whoever may fix it to the workspace’s processing — and says "See why" to a reader', async () => {
        renderLead()
        const fix = within(screen.getByRole('region', { name: 'Sources that need a look' })).getAllByRole('link', { name: 'Fix it' })[0]
        expect(fix).toHaveAttribute('href', '/workspaces/ws_fin?tab=data&section=processing')
        signIn([], { ws_fin: ['workspace:datasource:read'] })
        expect(await screen.findAllByRole('link', { name: 'See why' })).not.toHaveLength(0)
    })

    it('shows the connections to provider readers, and the run record to platform administrators only', async () => {
        renderLead()
        const connections = screen.getByRole('region', { name: 'Connections' })
        expect(within(connections).getByText(/1 connection unavailable/)).toBeInTheDocument()
        expect(screen.queryByRole('region', { name: 'Builds' })).not.toBeInTheDocument()
        expect(aggregation.getJobsSummary).not.toHaveBeenCalled()
    })

    it('shows the run record to a platform administrator', async () => {
        signIn(['system:admin'], {})
        renderLead()
        const builds = await screen.findByRole('region', { name: 'Builds' })
        expect(within(builds).getByText('95%')).toBeInTheDocument()
    })

    it('leads with the reader’s work instead when they can’t read any data source', () => {
        signIn([], { ws_fin: ['workspace:view:read'] })
        renderLead()
        expect(screen.queryByRole('heading', { name: 'Data health' })).not.toBeInTheDocument()
        expect(screen.queryByText('Technical view')).not.toBeInTheDocument()
        expect(screen.getByText('Keep experimenting')).toBeInTheDocument()
        expect(aggregation.getProjectionHealth).not.toHaveBeenCalled()
    })
})
