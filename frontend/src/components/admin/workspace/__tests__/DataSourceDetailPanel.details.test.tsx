/**
 * Data source details in the drawer: the trust badges in its header and the Activity tab,
 * both only while the switch is on (a link to the tab falls back to the Overview), and the
 * About card on the Overview above who to ask.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../AboutDataSourceCard', () => ({ AboutDataSourceCard: () => <p>About card</p> }))
vi.mock('../DataSourceActivity', () => ({ DataSourceActivity: () => <p>History of the source</p> }))
vi.mock('../DataContactsCard', () => ({ DataContactsCard: () => <p>Contacts card</p> }))
vi.mock('@/features/discussions/useDiscussions', async (orig) => ({
    ...(await orig<typeof import('@/features/discussions/useDiscussions')>()),
    useSubjectSummary: () => ({ data: undefined }),
}))
vi.mock('@/components/insights/DataSourceProfile', () => ({ DataSourceProfile: () => null }))
vi.mock('@/components/ingestion/profiling/SourceProfiling', () => ({ SourceProfiling: () => null }))
vi.mock('../AggregationHistory', () => ({ AggregationHistory: () => null }))
vi.mock('@/features/versioning/components/DataSourceVersioningTab', () => ({ DataSourceVersioningTab: () => null }))
vi.mock('../VocabAlignmentWarning', () => ({ VocabAlignmentWarning: () => null }))
vi.mock('@/features/view-transfer/FinishImportingViewsBanner', () => ({ FinishImportingViewsBanner: () => null }))
vi.mock('@/features/data-source-transfer/DataSourceLifecycle', () => ({ DataSourceLifecycle: () => null, MovedFromChip: () => null }))
vi.mock('../DataSourceActionMenu', () => ({ DataSourceActionMenu: () => null }))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { DataSourceDetailPanel } from '../DataSourceDetailPanel'
import type { DataSourceResponse } from '@/services/workspaceService'

const ds = {
    id: 'ds_gl', workspaceId: 'ws1', catalogItemId: 'cat_gl', label: 'General Ledger', accessLevel: 'read',
    isPrimary: true, isActive: true, identityProperty: 'urn', nameProperty: 'name',
    trustStatus: 'certified', classification: 'confidential',
} as DataSourceResponse

function renderAt(url: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[url]}>
                <DataSourceDetailPanel ds={ds} wsId="ws1" isOpen viewCount={0} ontologies={[]}
                    onSaveEdit={vi.fn()} onReaggregate={vi.fn()} onPurge={vi.fn()} onSetPrimary={vi.fn()}
                    onSaveAggregationConfig={vi.fn()} onClose={vi.fn()} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

describe('data source details in the drawer', () => {
    it('shows no badges and no Activity tab while the switch is off', () => {
        renderAt('/workspaces/ws1?ds=ds_gl&dstab=activity')
        expect(screen.queryByText('Certified')).toBeNull()
        expect(screen.queryByRole('tab', { name: /Activity/ })).toBeNull()
        expect(screen.queryByText('History of the source')).toBeNull()
        expect(screen.getByText('Contacts card')).toBeInTheDocument()
    })

    it('badges the header, puts About first on the Overview, and opens Activity', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataSourceMetadataEnabled: true } })
        renderAt('/workspaces/ws1?ds=ds_gl')
        expect(screen.getByText('Certified')).toBeInTheDocument()
        expect(screen.getByText('Confidential')).toBeInTheDocument()
        const about = screen.getByText('About card')
        expect(about.compareDocumentPosition(screen.getByText('Contacts card')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        await userEvent.click(screen.getByRole('tab', { name: /Activity/ }))
        expect(screen.getByText('History of the source')).toBeInTheDocument()
    })
})
