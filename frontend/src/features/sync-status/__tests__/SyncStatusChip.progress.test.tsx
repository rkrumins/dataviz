/**
 * SyncStatusChip while the graph is updated and the server says how far it is
 * (`versioned.progress`): the Business pill says the version, percentage and time left (or, while
 * an earlier version shows, the percentage and time); the Technical pill adds them to its words and
 * its name, and the graph's lane in the card shows the update itself. A graph in sync says it is up
 * to date, whatever is built beside it. The status hook is mocked.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { progressOf } from '@/harness/updateProgressFixtures'
import { usePersonaStore } from '@/store/persona'
import type { SyncStatus } from '../syncStatusApi'

let data: SyncStatus | undefined

vi.mock('../useSyncStatus', () => ({
    useSyncStatus: () => ({ data, isError: false, isFetching: false, refetch: vi.fn() }),
}))

import { SyncStatusChip } from '../SyncStatusChip'

const at = new Date(Date.now() - 2 * 60_000).toISOString()

function versioned(over: Partial<NonNullable<SyncStatus['versioned']>> = {}): SyncStatus {
    const rev = { commitId: 'cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A', createdAt: at, actorName: 'System Admin', message: 'Publish draft' }
    return {
        kind: 'versioned', dataSourceId: 'ds', checkedAt: at,
        versioned: { graphId: 'g', committed: 42, projected: 41, fresh: false, status: 'projecting', served: 41,
            committedRevision: rev, projectedRevision: rev, servedRevision: rev, lastProjectedAt: at, readMode: 'in_place', ...over },
        summaries: { aggregationStatus: 'ready', driftState: 'managed', lastJobStatus: 'completed', lastSuccessAt: at },
        counts: { nodes: 1922, edges: 2288, readAt: at },
    }
}

const renderChip = () => render(<SyncStatusChip workspaceId="ws1" dataSourceId="ds" viewId="v1" />)

describe('SyncStatusChip with an update in flight, in the Business view', () => {
    beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

    it('says the version, how far it is and the time left', () => {
        data = versioned({ served: null, progress: progressOf() })
        renderChip()
        expect(screen.getByText('Version 42 · 63% · about 4 min left')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Version 42: 63% written, about 4 min left')
        expect(screen.queryByText('Updating…')).toBeNull()
    })

    it('says an earlier version shows, and how far the newer one is', () => {
        data = versioned({ progress: progressOf() })
        renderChip()
        expect(screen.getByText(/^Showing an earlier version ·/)).toBeInTheDocument()
        expect(screen.getByText('63% · about 4 min left')).toBeInTheDocument()
    })

    it('says it is updating, as before, when there is no percentage to give', () => {
        data = versioned({ progress: progressOf({ phase: 'building', done: null, total: null, ratePerSec: null, etaSecs: null }) })
        renderChip()
        expect(screen.getByText('Showing an earlier version · updating…')).toBeInTheDocument()
    })

    it('says a graph being loaded back into memory is loading, and how far, not that it is behind', () => {
        data = versioned({ projected: 0, served: null, status: 'rehydrating', progress: progressOf({ phase: 'loading' }) })
        renderChip()
        expect(screen.getByText('Loading version 42 · 63% · about 4 min left')).toBeInTheDocument()
        expect(screen.queryByText('May be out of date')).toBeNull()
    })

    it('says it is up to date while a rebuild is built beside the version it shows', () => {
        data = versioned({ projected: 42, fresh: true, status: 'idle', served: 42, progress: progressOf({ phase: 'building' }) })
        renderChip()
        expect(screen.getByText(/^Up to date · checked/)).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })
})

describe('SyncStatusChip with an update in flight, in the Technical view', () => {
    beforeEach(() => usePersonaStore.setState({ mode: 'technical' }))

    it('adds how far it is to the pill and its name, and shows the update in the graph’s lane', async () => {
        data = versioned({ progress: progressOf({ phase: 'switching', etaSecs: 180 }), readMode: 'beside',
            candidate: { step: 'catching_up' } })
        renderChip()
        const pill = screen.getByRole('button', { name: /Version 42 is being built beside: ready in about 3 min/ })
        expect(within(pill).getByText('63% · ready in about 3 min')).toBeInTheDocument()
        await userEvent.setup().click(pill)
        const lanes = await screen.findByRole('list', { name: "Where this view's data comes from" })
        const bar = within(lanes).getByRole('progressbar', { name: 'Switching when ready progress' })
        expect(bar).toHaveAttribute('aria-valuenow', '63')
        expect(within(lanes).getByText('Version 42 is being built beside: ready in about 3 min')).toBeInTheDocument()
        expect(within(lanes).getByText(/6,300 of 10,000 rows/)).toBeInTheDocument()
    })
})
