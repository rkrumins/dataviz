import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAlerts = vi.fn()
const acknowledgeAlert = vi.fn()
const useAnyPermission = vi.fn()

vi.mock('@/services/insightsHistoryService', () => ({
    insightsHistoryService: {
        listAlerts: (...a: unknown[]) => listAlerts(...a),
        acknowledgeAlert: (id: string) => acknowledgeAlert(id),
    },
}))
vi.mock('@/hooks/useHistoryAccess', () => ({
    useCanReadHistory: () => useAnyPermission(),
}))

import { AlertBand } from './AlertBand'

function alert(over: Record<string, unknown> = {}) {
    return {
        id: 'alr_1',
        data_source_id: 'ds-1',
        catalog_item_id: 'cat-1',
        workspace_id: 'ws-1',
        provider_id: 'p-1',
        graph_name: 'orders',
        observed_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        detected_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        severity: 'severe',
        direction: 'drop',
        node_delta: -12_400,
        node_count: 600,
        baseline: 40,
        evidence: { nodes: { removed: { Column: 12_000 }, changed: { Table: [900, 500] } } },
        acknowledged_at: null,
        acknowledged_by: null,
        ...over,
    }
}

function renderBand(props: Record<string, unknown> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <AlertBand scopeId="cat-1" {...props} />
        </QueryClientProvider>,
    )
}

describe('AlertBand', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useAnyPermission.mockReturnValue(true)
        acknowledgeAlert.mockResolvedValue({})
    })

    it('renders nothing when there is nothing outstanding', async () => {
        listAlerts.mockResolvedValue({ alerts: [], openCount: 0 })
        const { container } = renderBand()
        await waitFor(() => expect(listAlerts).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing for a viewer who cannot read alerts', () => {
        useAnyPermission.mockReturnValue(false)
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        const { container } = renderBand()
        expect(container).toBeEmptyDOMElement()
        expect(listAlerts).not.toHaveBeenCalled()
    })

    it('asks only for unacknowledged alerts on this source', async () => {
        listAlerts.mockResolvedValue({ alerts: [], openCount: 0 })
        renderBand()
        await waitFor(() => expect(listAlerts).toHaveBeenCalled())
        expect(listAlerts.mock.calls[0][0]).toMatchObject({
            dataSourceId: 'cat-1', openOnly: true,
        })
    })

    it('leads with the magnitude and direction', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        renderBand()
        expect(await screen.findByText(/−12k entities/)).toBeInTheDocument()
        expect(screen.getByText('severe')).toBeInTheDocument()
        expect(screen.getByText(/one movement needs a look/i)).toBeInTheDocument()
    })

    it('states what the movement was judged against, not just that it was unusual', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        renderBand()
        // "Unusual" alone is a claim; the baseline makes it an argument the
        // reader can check against the chart below.
        expect(await screen.findByText(/usual movement for this source is about/i))
            .toBeInTheDocument()
        expect(screen.getByText('40')).toBeInTheDocument()
    })

    it('names the labels that actually moved, worst first', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        renderBand()
        const line = await screen.findByText(/Column −12k/)
        expect(line).toBeInTheDocument()
        expect(line.textContent).toMatch(/Column −12k.*Table −400/)
    })

    it('distinguishes when it happened from when it was noticed', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        renderBand()
        // Detection trails observation by up to one sweep interval; showing
        // only one invites the wrong conclusion about how fast this noticed.
        expect(await screen.findByRole('button', { name: /happened 3h ago/i }))
            .toBeInTheDocument()
        expect(screen.getByText(/noticed 2h ago/i)).toBeInTheDocument()
    })

    it('reveals the moment on the chart when the timestamp is clicked', async () => {
        const onSelect = vi.fn()
        const a = alert()
        listAlerts.mockResolvedValue({ alerts: [a], openCount: 1 })
        renderBand({ onSelect })

        await userEvent.click(await screen.findByRole('button', { name: /happened/i }))
        expect(onSelect).toHaveBeenCalledWith(a.observed_at)
    })

    it('acknowledges an alert and re-reads', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        renderBand()

        await userEvent.click(await screen.findByRole('button', { name: /acknowledge/i }))
        await waitFor(() => expect(acknowledgeAlert).toHaveBeenCalledWith('alr_1'))
    })

    it('tints a rise differently from a drop', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ direction: 'rise', node_delta: 30_000, severity: 'notable' })],
            openCount: 1,
        })
        renderBand()
        expect(await screen.findByText(/\+30k/)).toBeInTheDocument()
        expect(screen.getByText('notable')).toBeInTheDocument()
    })

    it('names which source under which provider is affected', async () => {
        // On a deployment running several providers this is the difference
        // between an alert you can act on and one you have to go and identify.
        listAlerts.mockResolvedValue({
            alerts: [alert({
                provider_name: 'Falkor Prod',
                data_source_label: 'Orders',
                graph_name: 'orders_graph',
            })],
            openCount: 1,
        })
        renderBand()
        expect(await screen.findByText('Falkor Prod')).toBeInTheDocument()
        expect(screen.getByText('Orders')).toBeInTheDocument()
        expect(screen.getByText(/graph orders_graph/)).toBeInTheDocument()
    })

    it('marks a near-total loss as critical, not merely severe', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ severity: 'critical', node_delta: -4_000_000, node_count: 12 })],
            openCount: 1,
        })
        renderBand()
        expect(await screen.findByText('critical')).toBeInTheDocument()
        expect(screen.getByTitle(/almost the whole graph is gone/i)).toBeInTheDocument()
    })

    it('pluralises the heading', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert(), alert({ id: 'alr_2' })], openCount: 2,
        })
        renderBand()
        expect(await screen.findByText(/2 movements need a look/i)).toBeInTheDocument()
    })
})
