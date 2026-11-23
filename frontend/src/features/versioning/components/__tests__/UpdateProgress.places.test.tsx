/**
 * Where an update's progress shows off the watermark (its `progress`): the canvas's refreshing
 * badge, the read-route chip, and the fast read layer's card. Each says the server's figures and
 * nothing it doesn't have; with no progress each says what it said before. The watermark hook (and
 * the card's other hooks) are mocked.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Watermark } from '@/services/versioningApiService'
import { usePersonaStore } from '@/store/persona'
import { progressOf } from '@/harness/updateProgressFixtures'

let wm: Watermark | undefined

vi.mock('../../hooks/useVersioning', () => ({
    useProjectionWatermark: () => ({ data: wm, isLoading: false, isError: false, refetch: vi.fn() }),
    useReconcileProjection: () => ({ mutate: vi.fn(), isPending: false }),
    useRebuildProjection: () => ({ mutate: vi.fn(), isPending: false }),
    useBringIntoHistory: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/components/admin/shared/useGraphStoreTopology', () => ({
    useGraphPlacementByGraph: () => ({ data: undefined, isLoading: false, isError: false }),
}))
// The card reads the read mode in force from the settings API when the watermark doesn't say why
// (ProjectionHealthCard.test.tsx covers that row); here it answers nothing.
vi.mock('@/services/settingsService', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/services/settingsService')>(),
    useSettingsSchema: () => ({ data: undefined }),
    useSettingsValues: () => ({ data: undefined, error: null, isLoading: false }),
}))

import { ProjectionHealthCard } from '../ProjectionHealthCard'
import { ReadRouteChip } from '../ReadRouteChip'
import { RefreshingBadge } from '../RefreshingBadge'

const BEHIND: Watermark = {
    committed: 42, projected: 41, fresh: false, status: 'projecting', served: 41,
    readRoute: { main: 'falkordb', drafts: 'overlay' }, projectionKey: 'gv_g1', providerName: 'Primary graph store',
    owned: true, epoch: 3, failedAttempts: 0,
}

beforeEach(() => {
    wm = { ...BEHIND }
    usePersonaStore.setState({ mode: 'technical' })
})

describe('RefreshingBadge', () => {
    it('says how far the update is and the time it has left, the whole sentence on hover', async () => {
        wm = { ...BEHIND, progress: progressOf() }
        render(<RefreshingBadge workspaceId="ws1" graphId="g1" />)
        const words = screen.getByText('Version 42 · 63% · about 4 min left')
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63')
        await userEvent.setup().hover(words)
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Version 42: 63% written, about 4 min left')
    })

    it('says a new version built beside the one shown is under way, which it used to miss', () => {
        wm = { ...BEHIND, status: 'idle', progress: progressOf({ phase: 'building', done: null, total: null, ratePerSec: null, etaSecs: null }) }
        render(<RefreshingBadge workspaceId="ws1" graphId="g1" />)
        expect(screen.getByText('Building version 42 beside')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    })

    it('says it is syncing, as before, while the server has no progress to give', () => {
        render(<RefreshingBadge workspaceId="ws1" graphId="g1" />)
        expect(screen.getByText('Syncing changes…')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('says nothing of an update once the graph is in sync', () => {
        wm = { ...BEHIND, fresh: true, status: 'idle', projected: 42, progress: progressOf() }
        const { container } = render(<RefreshingBadge workspaceId="ws1" graphId="g1" />)
        expect(container).toBeEmptyDOMElement()
    })
})

describe('ReadRouteChip', () => {
    it('adds how far the version being written is to the version it serves', () => {
        wm = { ...BEHIND, progress: progressOf() }
        render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
        expect(screen.getByText(/Serving #41 from FalkorDB · #42 being written/)).toBeInTheDocument()
        expect(screen.getByText('63% · about 4 min left')).toBeInTheDocument()
    })

    it('in the Business view, says it is catching up and how long it has left', () => {
        usePersonaStore.setState({ mode: 'business' })
        wm = { ...BEHIND, served: null, readRoute: { main: 'postgres', drafts: 'overlay' }, progress: progressOf({ phase: 'seeding' }) }
        render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
        expect(screen.getByText(/^Catching up/)).toBeInTheDocument()
        expect(screen.getByText('63% · about 4 min left')).toBeInTheDocument()
        expect(document.body.textContent).not.toMatch(/Postgres|FalkorDB/)
    })

    it('says what it said before when there is no percentage to add', () => {
        wm = { ...BEHIND, progress: progressOf({ done: null, total: null, ratePerSec: null, etaSecs: null }) }
        render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
        expect(screen.getByText('Serving #41 from FalkorDB · #42 being written')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })

    it('adds nothing for a fork too far from its parent, whose reads its parent’s update doesn’t move', () => {
        wm = { ...BEHIND, served: null, readsFrom: 'postgres', readRoute: { main: 'postgres', drafts: 'overlay' }, progress: progressOf() }
        render(<ReadRouteChip workspaceId="ws1" graphId="g1" isDraft={false} />)
        expect(screen.getByText('Serving from Postgres (far from its parent)')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })
})

describe('ProjectionHealthCard', () => {
    const renderCard = () => render(<MemoryRouter><ProjectionHealthCard wsId="ws1" graphId="g1" /></MemoryRouter>)

    it('shows the update in flight: its phase, sentence, bar and figures', () => {
        wm = { ...BEHIND, progress: progressOf({ phase: 'loading' }) }
        renderCard()
        expect(screen.getByText('Version 42: 63% loaded, about 4 min left')).toBeInTheDocument()
        expect(screen.getByRole('progressbar', { name: 'Loading progress' })).toHaveAttribute('aria-valuenow', '63')
        expect(screen.getByText(/6,300 of 10,000 rows · 25 rows a second/)).toBeInTheDocument()
    })

    it('shows no update while none is in flight', () => {
        wm = { ...BEHIND, fresh: true, status: 'idle', projected: 42 }
        renderCard()
        expect(screen.getByText('Fast read layer')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).toBeNull()
    })
})
