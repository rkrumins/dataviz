/**
 * The Dashboard's "Needs attention": open profiling findings, worst first, for
 * the people who can read profiling — and nothing at all for everyone else.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Finding } from '@/types/profiling'

const { service, access } = vi.hoisted(() => ({
    service: { getFindings: vi.fn(), acknowledge: vi.fn() },
    access: { canRead: true },
}))
vi.mock('@/services/profilingService', () => ({ profilingService: service }))
vi.mock('@/hooks/useProfilingAccess', () => ({ useCanReadProfiling: () => access.canRead }))

import { useWorkspacesStore } from '@/store/workspaces'
import { NeedsAttention } from './NeedsAttention'

function finding(id: string, over: Partial<Finding>): Finding {
    return {
        id, data_source_id: `ds_${id}`, detected_at: '2026-10-17T10:00:00Z', observed_at: null,
        workspace_id: 'ws_fin', workspace_name: null, provider_id: null, provider_name: null, provider_type: null,
        data_source_label: `Source ${id}`, graph_name: null, catalog_item_id: null,
        severity: 'notable', direction: 'drop', metric: 'nodes', finding: 'movement', subject_type: null,
        delta: -500, count: 1000, baseline: 40, evidence: null, acknowledged_at: null, acknowledged_by: null,
        ...over,
    }
}

const FINDINGS = [
    finding('a', { severity: 'notable', detected_at: '2026-10-17T12:00:00Z' }),
    finding('b', { severity: 'critical', delta: -12_400, baseline: 40 }),
    finding('c', { severity: 'severe', finding: 'type_gone', subject_type: 'Report', delta: -1204 }),
    finding('d', { severity: 'severe', finding: 'silent', detected_at: '2026-10-16T09:00:00Z' }),
]

function renderStrip() {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter><NeedsAttention /></MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    access.canRead = true
    service.getFindings.mockResolvedValue({
        alerts: FINDINGS, total: 4, openCount: 4, offset: 0, limit: 50, platform_wide: false,
    })
    useWorkspacesStore.setState({ workspaces: [{ id: 'ws_fin', name: 'Finance', dataSources: [] }] } as never)
})

describe('NeedsAttention', () => {
    it('shows the worst three, each checkable against what is usual, with a way to the rest', async () => {
        renderStrip()
        const items = await screen.findAllByRole('listitem')
        expect(items).toHaveLength(3)
        expect(within(items[0]).getByText('Source b')).toBeInTheDocument()
        expect(within(items[0]).getByText('−12,400 entities, against a usual movement of 40.')).toBeInTheDocument()
        expect(within(items[0]).getByText('in Finance')).toBeInTheDocument()
        // The two severe ones next, the newer first.
        expect(within(items[1]).getByText('Every Report is gone (1,204 entities).')).toBeInTheDocument()
        expect(within(items[2]).getByText(/Stopped reporting/)).toBeInTheDocument()
        expect(within(items[0]).getByRole('link', { name: 'Open' }))
            .toHaveAttribute('href', '/ingestion?tab=profiling&source=ds_b')
        expect(screen.getByRole('link', { name: /View all 4/ })).toHaveAttribute('href', '/ingestion?tab=profiling')
    })

    it('marks one seen and asks again', async () => {
        service.acknowledge.mockResolvedValue({})
        renderStrip()
        const first = (await screen.findAllByRole('listitem'))[0]
        fireEvent.click(within(first).getByRole('button', { name: 'Mark seen' }))
        await waitFor(() => expect(service.acknowledge).toHaveBeenCalledWith('b'))
        await waitFor(() => expect(service.getFindings).toHaveBeenCalledTimes(2))
    })

    it('says nothing when nothing is open, or to someone who cannot read profiling', async () => {
        service.getFindings.mockResolvedValue({ alerts: [], total: 0, openCount: 0, offset: 0, limit: 50, platform_wide: false })
        const { container, unmount } = renderStrip()
        await waitFor(() => expect(service.getFindings).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
        unmount()

        access.canRead = false
        service.getFindings.mockClear()
        const again = renderStrip()
        expect(again.container).toBeEmptyDOMElement()
        expect(service.getFindings).not.toHaveBeenCalled()
    })
})
