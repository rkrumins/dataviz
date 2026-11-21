/**
 * A source's history: a day at a time, who did what, with runs of the same change folded;
 * older events a page at a time; a plain empty state; and no request while the switch is off.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '@/services/activityService'

const api = vi.hoisted(() => ({ get: vi.fn(), saveDetails: vi.fn(), saveTrust: vi.fn(), listActivity: vi.fn() }))
vi.mock('@/services/dataSourceMetadataService', async (orig) => ({
    ...(await orig<typeof import('@/services/dataSourceMetadataService')>()),
    dataSourceMetadataService: api,
}))

import { DataSourceActivity } from '../DataSourceActivity'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const today = new Date()
today.setHours(12, 0, 0, 0)
const at = (daysAgo: number, minutes = 0) => new Date(today.getTime() - daysAgo * 86_400_000 - minutes * 60_000).toISOString()
const event = (id: string, eventType: string, summary: string, occurredAt: string, actorName = 'Ada Okafor'): ActivityEvent => ({
    id, eventType, label: summary, category: 'data', severity: 'info', outcome: 'success', summary, occurredAt, recordedAt: occurredAt,
    actorKind: 'user', actor: { id: 'usr_ada', name: actorName, email: null, deleted: false }, details: {}, resolvedNames: {},
})

function renderIt() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><DataSourceActivity wsId="ws_fin" dsId="ds_gl" /></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataSourceMetadataEnabled: true } })
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

describe('DataSourceActivity', () => {
    it('reads a day at a time, folds a run of the same change, and fetches older events on Show more', async () => {
        const user = userEvent.setup()
        api.listActivity
            .mockResolvedValueOnce({ events: [
                event('e1', 'workspace.data_source.trust_changed', 'Certified General Ledger', at(0, 5)),
                event('e2', 'workspace.data_source.metadata_changed', 'Changed the tags of General Ledger', at(0, 30)),
                event('e3', 'workspace.data_source.metadata_changed', 'Changed the tags of General Ledger', at(0, 40)),
                event('e4', 'workspace.data_source.added', 'Added General Ledger', at(1), 'Ana Ruiz'),
            ], nextCursor: 'c2' })
            .mockResolvedValueOnce({ events: [event('e5', 'workspace.data_source.contacts_changed', 'Named the contacts of General Ledger', at(9))], nextCursor: null })
        renderIt()
        expect(await screen.findByText('Certified General Ledger')).toBeInTheDocument()
        expect(screen.getByText('Today')).toBeInTheDocument()
        expect(screen.getByText('Yesterday')).toBeInTheDocument()
        expect(screen.getByText('Ana Ruiz')).toBeInTheDocument()
        expect(screen.getByText('×2')).toBeInTheDocument()
        expect(screen.getByText(/can take a few seconds to appear/)).toBeInTheDocument()
        expect(api.listActivity).toHaveBeenCalledWith('ws_fin', 'ds_gl', null)

        await user.click(screen.getByRole('button', { name: 'Show more' }))
        expect(await screen.findByText('Named the contacts of General Ledger')).toBeInTheDocument()
        expect(api.listActivity).toHaveBeenLastCalledWith('ws_fin', 'ds_gl', 'c2')
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    })

    it('says when nothing is recorded yet', async () => {
        api.listActivity.mockResolvedValue({ events: [], nextCursor: null })
        renderIt()
        expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument()
    })

    it('asks for nothing while the switch is off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        renderIt()
        await waitFor(() => expect(api.listActivity).not.toHaveBeenCalled())
    })
})
