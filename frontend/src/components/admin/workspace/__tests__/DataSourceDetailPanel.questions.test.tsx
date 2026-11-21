/**
 * A data source's Questions tab: there only while conversations are on, counting the open
 * questions; a thread opens in the tab itself and the address keeps it, so the link in a
 * notification (`?dstab=questions&discussion=…`) lands on it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const summary = vi.hoisted(() => vi.fn())
vi.mock('@/features/discussions/useDiscussions', async (orig) => ({
    ...(await orig<typeof import('@/features/discussions/useDiscussions')>()),
    useSubjectSummary: (s: unknown) => ({ data: s ? summary() : undefined }),
}))
vi.mock('@/features/discussions/DiscussionPanel', () => ({
    DiscussionPanel: ({ subject, onOpenThread, compose }: { subject: { name: string }; onOpenThread: (id: string) => void; compose?: boolean }) => (
        <div data-testid="panel">
            Questions about {subject.name}{compose ? ' (asking)' : ''}
            <button type="button" onClick={() => onOpenThread('th_9')}>Open th_9</button>
        </div>
    ),
}))
vi.mock('@/features/discussions/ThreadView', () => ({
    ThreadView: ({ threadId, onBack }: { threadId: string; onBack: () => void }) => (
        <div data-testid="thread">Thread {threadId}<button type="button" onClick={onBack}>Back</button></div>
    ),
}))
vi.mock('@/features/discussions/DiscussionsDrawer', () => ({ WatchButton: () => <button type="button">Watch</button> }))
vi.mock('../DataContactsCard', () => ({
    DataContactsCard: ({ onAsk }: { onAsk?: () => void }) => <button type="button" onClick={onAsk}>Ask the contacts</button>,
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
} as DataSourceResponse

function Where() { const l = useLocation(); return <p data-testid="where">{l.search}</p> }

function renderAt(url: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[url]}>
                <DataSourceDetailPanel ds={ds} wsId="ws1" isOpen views={[]} ontologies={[]}
                    onSaveEdit={vi.fn()} onReaggregate={vi.fn()} onPurge={vi.fn()} onSetPrimary={vi.fn()}
                    onSaveAggregationConfig={vi.fn()} onClose={vi.fn()} />
                <Where />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    summary.mockReturnValue({ open: 3, answered: 1, closed: 0, total: 4, unread: 0, watching: false, latest: 'x', byEntity: {} })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
})

describe('the Questions tab of a data source', () => {
    it('is not there while conversations are off, and its link falls back to the Overview', () => {
        renderAt('/workspaces/ws1?ds=ds_gl&dstab=questions&discussion=th_1')
        expect(screen.queryByRole('button', { name: /Questions/ })).toBeNull()
        expect(screen.queryByTestId('thread')).toBeNull()
        expect(screen.getByRole('button', { name: 'Ask the contacts' })).toBeInTheDocument()
    })

    it('counts the open questions, and opens a thread in the tab, kept in the address', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        renderAt('/workspaces/ws1?ds=ds_gl')
        await userEvent.click(screen.getByRole('button', { name: /Questions\s*3/ }))
        expect(screen.getByTestId('panel')).toHaveTextContent('Questions about General Ledger')
        await userEvent.click(screen.getByRole('button', { name: 'Open th_9' }))
        expect(screen.getByTestId('thread')).toHaveTextContent('Thread th_9')
        expect(screen.getByTestId('where')).toHaveTextContent('dstab=questions&discussion=th_9')
        await userEvent.click(screen.getByRole('button', { name: 'Back' }))
        expect(screen.getByTestId('panel')).toBeInTheDocument()
        expect(screen.getByTestId('where')).not.toHaveTextContent('discussion=')
    })

    it('lands on the thread a notification links to; leaving the tab drops it', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        renderAt('/workspaces/ws1?ds=ds_gl&dstab=questions&discussion=th_1&message=m_2')
        expect(screen.getByTestId('thread')).toHaveTextContent('Thread th_1')
        await userEvent.click(screen.getByRole('button', { name: /Overview/ }))
        expect(screen.getByTestId('where')).not.toHaveTextContent('discussion=')
        expect(screen.getByTestId('where')).not.toHaveTextContent('message=')
    })

    it('asking the data’s contacts from the Overview opens the ask box on the Questions tab', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        renderAt('/workspaces/ws1?ds=ds_gl')
        await userEvent.click(screen.getByRole('button', { name: 'Ask the contacts' }))
        expect(screen.getByTestId('panel')).toHaveTextContent('(asking)')
    })
})
