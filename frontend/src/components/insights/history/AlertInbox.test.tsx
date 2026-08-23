import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAlerts = vi.fn()
const useAnyPermission = vi.fn()

vi.mock('@/services/insightsHistoryService', () => ({
    insightsHistoryService: { listAlerts: (...a: unknown[]) => listAlerts(...a) },
}))
vi.mock('@/hooks/useHistoryAccess', () => ({
    useCanReadHistory: () => useAnyPermission(),
}))

import { AlertInbox } from './AlertInbox'

let seq = 0
function alert(over: Record<string, unknown> = {}) {
    seq += 1
    return {
        id: `alr_${seq}`,
        data_source_id: `ds-${seq}`,
        catalog_item_id: `cat-${seq}`,
        workspace_id: 'ws-1',
        provider_id: 'p-1',
        provider_name: 'Falkor Prod',
        graph_name: 'orders_graph',
        data_source_label: 'Orders',
        observed_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        detected_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        severity: 'severe',
        direction: 'drop',
        node_delta: -900,
        node_count: 100,
        baseline: 40,
        evidence: null,
        acknowledged_at: null,
        acknowledged_by: null,
        ...over,
    }
}

async function renderInbox(props: Record<string, unknown> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const result = render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <AlertInbox {...props} />
            </QueryClientProvider>
        </MemoryRouter>,
    )
    return result
}

describe('AlertInbox', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        seq = 0
        useAnyPermission.mockReturnValue(true)
    })

    it('says so plainly when nothing is outstanding', async () => {
        listAlerts.mockResolvedValue({ alerts: [], openCount: 0 })
        await renderInbox()
        expect(await screen.findByText(/nothing outstanding/i)).toBeInTheDocument()
        expect(screen.getByText(/across any provider/i)).toBeInTheDocument()
    })

    it('renders nothing for a viewer who cannot read alerts', () => {
        useAnyPermission.mockReturnValue(false)
        listAlerts.mockResolvedValue({ alerts: [alert()], openCount: 1 })
        const { container } = render(
            <MemoryRouter>
                <QueryClientProvider client={new QueryClient()}>
                    <AlertInbox />
                </QueryClientProvider>
            </MemoryRouter>,
        )
        expect(container).toBeEmptyDOMElement()
        expect(listAlerts).not.toHaveBeenCalled()
    })

    it('groups affected sources under their provider', async () => {
        listAlerts.mockResolvedValue({
            alerts: [
                alert({ provider_id: 'p-1', provider_name: 'Falkor Prod', data_source_label: 'Orders' }),
                alert({ provider_id: 'p-1', provider_name: 'Falkor Prod', data_source_label: 'Customers' }),
                alert({ provider_id: 'p-2', provider_name: 'Neo4j Staging', data_source_label: 'Sandbox' }),
            ],
            openCount: 3,
        })
        await renderInbox()

        expect(await screen.findByText(/3 open anomalies across 2 providers/i))
            .toBeInTheDocument()
        expect(screen.getByText('Falkor Prod')).toBeInTheDocument()
        expect(screen.getByText('Neo4j Staging')).toBeInTheDocument()
        // A provider with several affected sources is a provider problem, and
        // the count says so at the group level.
        expect(screen.getByText('2 affected')).toBeInTheDocument()
    })

    it('puts the provider carrying the worst severity first', async () => {
        listAlerts.mockResolvedValue({
            alerts: [
                alert({ provider_id: 'p-1', provider_name: 'Healthy-ish', severity: 'notable' }),
                alert({ provider_id: 'p-2', provider_name: 'On Fire', severity: 'critical' }),
            ],
            openCount: 2,
        })
        const { container } = await renderInbox()
        await screen.findByText('On Fire')

        const names = [...container.querySelectorAll('span')]
            .map((n) => n.textContent)
            .filter((t) => t === 'On Fire' || t === 'Healthy-ish')
        expect(names[0]).toBe('On Fire')
    })

    it('names both the source and the physical graph when they differ', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ data_source_label: 'Orders', graph_name: 'orders_graph' })],
            openCount: 1,
        })
        await renderInbox()
        expect(await screen.findByText('Orders')).toBeInTheDocument()
        // One names what the product calls it, the other what to look for on
        // the server.
        expect(screen.getByText('graph orders_graph')).toBeInTheDocument()
    })

    it('does not repeat the graph name when it matches the label', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ data_source_label: 'orders_graph', graph_name: 'orders_graph' })],
            openCount: 1,
        })
        await renderInbox()
        await screen.findByText('orders_graph')
        expect(screen.queryByText('graph orders_graph')).toBeNull()
    })

    it('still names a provider that has since been deleted', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ provider_name: null, provider_id: 'p-gone' })],
            openCount: 1,
        })
        await renderInbox()
        expect(await screen.findByText('p-gone')).toBeInTheDocument()
    })

    it('deep-links each affected source into its own history', async () => {
        listAlerts.mockResolvedValue({
            alerts: [alert({ catalog_item_id: 'cat-9', data_source_id: 'ds-9' })],
            openCount: 1,
        })
        await renderInbox()
        const link = await screen.findByRole('link', { name: /open history for orders/i })
        expect(link).toHaveAttribute('href', '/datasources/cat-9/history?ds=ds-9')
    })

    it('scopes to one provider when asked', async () => {
        listAlerts.mockResolvedValue({
            alerts: [
                alert({ provider_id: 'p-1', provider_name: 'Falkor Prod' }),
                alert({ provider_id: 'p-2', provider_name: 'Neo4j Staging' }),
            ],
            openCount: 2,
        })
        await renderInbox({ providerId: 'p-1' })

        expect(await screen.findByText('Falkor Prod')).toBeInTheDocument()
        expect(screen.queryByText('Neo4j Staging')).toBeNull()
        expect(screen.getByText(/1 open anomaly across 1 provider/i)).toBeInTheDocument()
    })

    it('reports an empty provider scope in its own terms', async () => {
        listAlerts.mockResolvedValue({ alerts: [alert({ provider_id: 'p-2' })], openCount: 1 })
        await renderInbox({ providerId: 'p-1' })
        expect(await screen.findByText(/on this provider/i)).toBeInTheDocument()
    })

    it('orders sources within a provider worst-first', async () => {
        listAlerts.mockResolvedValue({
            alerts: [
                alert({ data_source_label: 'Mild', severity: 'notable' }),
                alert({ data_source_label: 'Wiped', severity: 'critical' }),
                alert({ data_source_label: 'Bad', severity: 'severe' }),
            ],
            openCount: 3,
        })
        await renderInbox()
        await screen.findByText('Wiped')

        // Document order is the rendered order — all three sit in one
        // provider group, so this reads exactly as the operator sees it.
        const labels = screen.getAllByText(/^(Mild|Wiped|Bad)$/).map((n) => n.textContent)
        expect(labels).toEqual(['Wiped', 'Bad', 'Mild'])
    })
})
