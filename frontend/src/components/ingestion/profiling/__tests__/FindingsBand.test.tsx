/**
 * Findings — open now, and what was found before.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Finding } from '@/types/profiling'

vi.mock('@/hooks/useProfilingAccess', () => ({
    useCanReadProfiling: () => true,
    useCanEditProfilingPolicy: () => true,
    useIsPlatformOperator: () => true,
    INGESTION_READ_PERMS: [],
}))

const getFindings = vi.fn()
vi.mock('@/services/profilingService', () => ({
    profilingService: {
        getFindings: (...a: unknown[]) => getFindings(...a),
        acknowledge: vi.fn().mockResolvedValue({}),
    },
}))

import { FindingsBand } from '../FindingsBand'

function finding(over: Partial<Finding> = {}): Finding {
    return {
        id: 'alr_1', data_source_id: 'ds_a',
        detected_at: '2026-08-21T09:20:00Z', observed_at: '2026-08-21T09:14:00Z',
        workspace_id: 'ws_1', workspace_name: 'Platform',
        provider_id: 'prov_1', provider_name: 'Falkor Docker',
        provider_type: 'falkordb',
        data_source_label: 'customers', graph_name: 'customers',
        catalog_item_id: 'cat_1', severity: 'severe', direction: 'drop',
        metric: 'nodes', finding: 'movement', subject_type: null,
        delta: -12400, count: 1191600, baseline: 40, evidence: null,
        acknowledged_at: null, acknowledged_by: null,
        ...over,
    }
}

function renderIt() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <FindingsBand dataSourceId="ds_a" />
        </QueryClientProvider>,
    )
}

describe('FindingsBand', () => {
    beforeEach(() => getFindings.mockReset())

    it('leads with what is outstanding', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding()], total: 1, openCount: 1, offset: 0, limit: 50,
            platform_wide: false,
        })
        renderIt()
        expect(await screen.findByText(/one finding needs a look/i)).toBeInTheDocument()
        expect(screen.getByText(/against a usual movement of/i)).toBeInTheDocument()
    })

    it('keeps the record after everything is acknowledged', async () => {
        // Showing only unacknowledged findings meant the record vanished the
        // moment someone cleared it — and "has this happened before?" is the
        // second question after every incident.
        getFindings.mockResolvedValue({
            alerts: [], total: 4, openCount: 0, offset: 0, limit: 50,
            platform_wide: false,
        })
        renderIt()
        expect(
            await screen.findByRole('button', { name: /what has been found before/i }),
        ).toBeInTheDocument()
        expect(screen.getByText(/nothing outstanding/i)).toBeInTheDocument()
    })

    it('switches to the history and asks the API for it', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding({
                acknowledged_at: '2026-08-21T10:00:00Z', acknowledged_by: 'RK',
            })],
            total: 1, openCount: 0, offset: 0, limit: 50, platform_wide: false,
        })
        renderIt()

        await userEvent.click(await screen.findByRole('button', { name: 'All' }))
        expect(await screen.findByText(/findings history/i)).toBeInTheDocument()
        expect(getFindings).toHaveBeenCalledWith(
            expect.objectContaining({ openOnly: false }), expect.anything(),
        )
    })

    it('shows an acknowledged finding as a record, not an action', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding({
                acknowledged_at: '2026-08-21T10:00:00Z', acknowledged_by: 'RK',
            })],
            total: 1, openCount: 0, offset: 0, limit: 50, platform_wide: false,
        })
        renderIt()

        await userEvent.click(await screen.findByRole('button', { name: 'All' }))
        expect(await screen.findByText('Seen')).toBeInTheDocument()
        expect(screen.getByText(/by RK/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /mark seen/i })).not.toBeInTheDocument()
    })

    it('stays out of the way when there is nothing to say', async () => {
        getFindings.mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 50,
            platform_wide: false,
        })
        const { container } = renderIt()
        await waitFor(() => expect(getFindings).toHaveBeenCalled())
        await waitFor(() => expect(container.textContent).toBe(''))
    })
})
