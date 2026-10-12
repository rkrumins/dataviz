/**
 * The Activity explorer: who did what, where, when and why.
 *
 * Carried over from the audit log it replaces, unchanged as a rule: SHOW THE
 * PERSON, KEEP THE ID, NEVER INVENT EITHER. A resolved person reads as their
 * name; an id the server could not name stays the id; a deleted account is
 * still named and marked.
 *
 * New here: the reason is part of the row (and its absence is said out loud
 * where one is expected), repeats fold, every filter lives in the URL, the
 * leaderboards drill in, and a workspace admin never receives a raw payload.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/activityService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/activityService')>()
    return {
        ...actual,
        activityService: {
            ...actual.activityService,
            listEvents: vi.fn(),
            countNewer: vi.fn(),
            getEvent: vi.fn(),
            getSummary: vi.fn(),
            getCatalogue: vi.fn(),
        },
    }
})

// The spotlight names its person from the directory, like any PersonChip.
vi.mock('@/services/userDirectoryService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/userDirectoryService')>()),
    peopleById: vi.fn(async (ids: string[]) => ids
        .filter((id) => id === 'usr_ana')
        .map((id) => ({ id, displayName: 'Ana Lyst', email: 'ana@example.com', deleted: false }))),
}))

import { ActivityExplorer } from '../ActivityExplorer'
import {
    activityService,
    type ActivityEvent,
    type ActivityScope,
    type ActivitySummary,
} from '@/services/activityService'

const service = vi.mocked(activityService)

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const NOW = new Date().toISOString()
const PLATFORM: ActivityScope = { kind: 'platform' }

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
        id: 'evt_1',
        eventType: 'aggregation.job.triggered',
        label: 'Triggered aggregation',
        category: 'operations',
        severity: 'info',
        outcome: 'success',
        summary: 'Triggered aggregation of Ledger',
        occurredAt: NOW,
        recordedAt: NOW,
        actorKind: 'user',
        actor: { id: 'usr_ana', name: 'Ana Lyst', email: 'ana@example.com', deleted: false },
        subject: null,
        target: { type: 'data_source', id: 'ds_1', label: 'Ledger' },
        workspaceId: 'ws_1',
        workspaceName: 'Finance',
        dataSourceId: 'ds_1',
        dataSourceName: 'Ledger',
        statedReason: 'Reload after the upstream fix',
        correlationId: 'req-1',
        details: { jobId: 'agg_1', triggerSource: 'manual' },
        resolvedNames: {},
        payload: { actor_id: 'usr_ana', extra: 'kept' },
        ...over,
    }
}

const BUCKETS = ['2026-10-09', '2026-10-10', '2026-10-11']

function summary(over: Partial<ActivitySummary> = {}): ActivitySummary {
    return {
        window: {
            days: 30, start: '2026-09-12', end: NOW, granularity: 'day',
            buckets: BUCKETS, previousStart: '2026-08-13',
        },
        totals: {
            events: { current: 120, previous: 100, delta: 0.2 },
            people: { current: 7, previous: 7, delta: 0 },
            operations: { current: 12, previous: 8, delta: 0.5 },
            reasons: { given: 9, of: 12, share: 0.75 },
        },
        volume: [
            { category: 'operations', values: [3, 4, 5] },
            { category: 'access', values: [1, 0, 2] },
        ],
        punchcard: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 1 && h === 14 ? 9 : 0))),
        topPeople: [{ id: 'usr_ana', count: 40, name: 'Ana Lyst', email: 'ana@example.com', deleted: false }],
        topTargets: [],
        topActions: [{ type: 'aggregation.job.triggered', count: 12, label: 'Triggered aggregation', category: 'operations' }],
        handsOnSources: [{
            dataSourceId: 'ds_1', workspaceId: 'ws_1', count: 6, lastAt: NOW,
            medianGapHours: 72, name: 'Ledger', workspaceName: 'Finance',
        }],
        topReasons: [{ reason: 'Reload after the upstream fix', count: 4 }],
        cadenceCapped: false,
        ...over,
    }
}

const LEDGER = { pending: 0, pendingCapped: false, lagSeconds: 0, backfilling: false, watermark: NOW }

beforeEach(() => {
    vi.clearAllMocks()
    service.listEvents.mockResolvedValue({ events: [ev()], nextCursor: null, ledger: LEDGER })
    service.countNewer.mockResolvedValue({ count: 0, capped: false })
    service.getSummary.mockResolvedValue(summary())
    service.getCatalogue.mockResolvedValue({
        categories: ['operations', 'access', 'identity', 'data', 'content', 'platform'],
        eventTypes: [
            { type: 'aggregation.job.triggered', label: 'Triggered aggregation', category: 'operations', severity: 'info', workspaceVisible: true },
            { type: 'rbac.group.member_added', label: 'Added to a group', category: 'access', severity: 'info', workspaceVisible: false },
        ],
    })
    service.getEvent.mockResolvedValue({ event: ev(), sameRequest: [], sameTarget: [] })
})

function LocationProbe() {
    return <output data-testid="location">{useLocation().search}</output>
}

function renderExplorer(scope: ActivityScope = PLATFORM, path = '/admin/audit') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="*" element={<><ActivityExplorer scope={scope} /><LocationProbe /></>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const lastQuery = () => service.listEvents.mock.calls.at(-1)?.[1]
const urlParams = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '')
/** The timeline only: a person is also named in the leaderboards above it. */
const timeline = () => within(screen.getByRole('region', { name: 'Activity timeline' }))
const loaded = () => screen.findByText('Triggered aggregation of Ledger')

describe('a row is a sentence: who, what, and why', () => {
    it('names the person and quotes their reason, keeping the id off the row', async () => {
        renderExplorer()
        await loaded()
        expect(timeline().getByText('Ana Lyst')).toBeInTheDocument()
        expect(timeline().getByText('“Reload after the upstream fix”')).toBeInTheDocument()
        expect(timeline().getByText('Finance')).toBeInTheDocument()
        expect(screen.queryByText('usr_ana')).not.toBeInTheDocument()
    })

    it('says "No reason given" only where a reason is expected', async () => {
        service.listEvents.mockResolvedValue({
            events: [
                ev({ id: 'evt_op', statedReason: null }),
                ev({
                    id: 'evt_in', eventType: 'user.logged_in', category: 'identity', label: 'Signed in',
                    summary: 'Signed in via local', statedReason: null, target: null,
                    workspaceId: null, workspaceName: null, dataSourceId: null,
                }),
            ],
            nextCursor: null, ledger: LEDGER,
        })
        renderExplorer()
        await screen.findByText('Signed in via local')
        // The rebuild should have said why; the sign-in never needs to.
        expect(timeline().getAllByText('No reason given')).toHaveLength(1)
    })

    it('keeps an unresolved id as the id, and never says "unknown user"', async () => {
        service.listEvents.mockResolvedValue({
            events: [ev({ actor: { id: 'usr_never_existed', deleted: false }, workspaceId: 'ws_gone', workspaceName: null })],
            nextCursor: null, ledger: LEDGER,
        })
        renderExplorer()
        await loaded()
        expect(timeline().getByText('usr_never_existed')).toBeInTheDocument()
        expect(timeline().getByText('ws_gone')).toBeInTheDocument()
        expect(screen.queryByText(/unknown user/i)).not.toBeInTheDocument()
    })

    it('folds a run of identical events into one row', async () => {
        const signIn = (id: string) => ev({
            id, eventType: 'user.logged_in', category: 'identity', label: 'Signed in',
            summary: 'Signed in via local', statedReason: null, target: null, details: {},
        })
        service.listEvents.mockResolvedValue({
            events: [signIn('e1'), signIn('e2'), signIn('e3'), ev({ id: 'e4' })],
            nextCursor: null, ledger: LEDGER,
        })
        renderExplorer()
        expect(await screen.findByText('×3')).toBeInTheDocument()
        expect(screen.getAllByText('Signed in via local')).toHaveLength(1)
    })
})

describe('the drawer has the rest', () => {
    it('opens on a row with who, why, ids to copy, links and the raw payload', async () => {
        service.getEvent.mockResolvedValue({
            event: ev({
                subject: { id: 'usr_gone', name: 'Grace Hopper', email: 'grace@example.com', deleted: true },
                resolvedNames: { grp_ab12: 'Use Case A' },
            }),
            sameRequest: [ev({ id: 'evt_2', summary: 'Revoked 2 sessions', statedReason: null })],
            sameTarget: [],
        })
        const u = userEvent.setup()
        renderExplorer()
        await u.click(await loaded())

        const dialog = await screen.findByRole('dialog', { name: 'Activity event' })
        expect(urlParams().get('act_event')).toBe('evt_1')
        await within(dialog).findByText('ana@example.com')
        expect(within(dialog).getByText('Ana Lyst').closest('a')).toHaveAttribute('href', '/admin/users?user=usr_ana')
        // A deleted account is still named, and marked.
        expect(within(dialog).getByText('Grace Hopper')).toBeInTheDocument()
        expect(within(dialog).getByText('Deleted')).toBeInTheDocument()
        expect(within(dialog).getByText('“Reload after the upstream fix”')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Copy Actor id' })).toBeInTheDocument()
        expect(within(dialog).getByText('usr_ana')).toBeInTheDocument()
        expect(within(dialog).getByText('Named in this event')).toBeInTheDocument()
        expect(within(dialog).getByText('grp_ab12')).toBeInTheDocument()
        expect(within(dialog).getByText('Revoked 2 sessions')).toBeInTheDocument()
        expect(within(dialog).getByRole('link', { name: /Open the run in Job History/ }))
            .toHaveAttribute('href', expect.stringContaining('search=agg_1'))
        expect(within(dialog).getByText('Raw event payload')).toBeInTheDocument()
        expect(within(dialog).getByRole('group', { name: 'event payload as JSON' })).toHaveTextContent('"extra": "kept"')
        expect(within(dialog).getByRole('button', { name: 'Copy event payload as JSON' })).toBeInTheDocument()
    })

    it('shows a workspace admin no raw payload — the server sends none', async () => {
        service.getEvent.mockResolvedValue({ event: ev({ payload: null }), sameRequest: [], sameTarget: [] })
        const u = userEvent.setup()
        renderExplorer({ kind: 'workspace', workspaceId: 'ws_1' }, '/workspaces/ws_1?tab=activity')
        await u.click(await loaded())
        const dialog = await screen.findByRole('dialog', { name: 'Activity event' })
        await within(dialog).findByText('ana@example.com')
        expect(within(dialog).queryByText('Raw event payload')).not.toBeInTheDocument()
    })

    it('says plainly when no reason was given for a change that wanted one', async () => {
        service.getEvent.mockResolvedValue({ event: ev({ statedReason: null }), sameRequest: [], sameTarget: [] })
        renderExplorer(PLATFORM, '/admin/audit?act_event=evt_1')
        const dialog = await screen.findByRole('dialog', { name: 'Activity event' })
        expect(await within(dialog).findByText('No reason given.')).toBeInTheDocument()
    })
})

describe('every filter is in the URL, and in the request', () => {
    it('a lens asks for its categories', async () => {
        const u = userEvent.setup()
        renderExplorer()
        await loaded()
        await u.click(screen.getByRole('button', { name: 'Operations' }))
        await waitFor(() => expect(lastQuery()?.categories).toEqual(['operations']))
        expect(urlParams().get('act_lens')).toBe('operations')
    })

    it('Security includes the refusals that Everything leaves out', async () => {
        const u = userEvent.setup()
        renderExplorer()
        await loaded()
        await u.click(screen.getByRole('button', { name: 'Security' }))
        await waitFor(() => expect(lastQuery()).toMatchObject({
            categories: ['identity', 'access'], includeNoise: true,
        }))
    })

    it('a person can be typed as a name, an email or an id', async () => {
        const u = userEvent.setup()
        renderExplorer()
        await loaded()
        await u.type(screen.getByLabelText('Filter by person'), 'john')
        await waitFor(() => expect(lastQuery()?.person).toBe('john'))
        expect(urlParams().get('act_person')).toBe('john')
        expect(screen.getByLabelText('Filter by person'))
            .toHaveAttribute('placeholder', expect.stringMatching(/name, email or user ID/i))
    })

    it('a link reopens the same selection', async () => {
        renderExplorer(PLATFORM, '/admin/audit?act_lens=access&act_days=7&act_reason=missing&act_outcome=denied')
        await loaded()
        expect(lastQuery()).toMatchObject({
            categories: ['access'], hasReason: false, outcome: 'denied',
            // A refusal is what "Everything" hides as noise; asking for one
            // has to include them.
            includeNoise: true,
            range: { kind: 'preset', days: 7 },
        })
    })

    it('search is offered only over a window the server will search', async () => {
        renderExplorer(PLATFORM, '/admin/audit?act_days=180')
        await loaded()
        expect(screen.getByLabelText('Search activity')).toBeDisabled()
    })
})

describe('the insight band drills in', () => {
    it('a hands-on source narrows everything to it, and the chip says which', async () => {
        const u = userEvent.setup()
        renderExplorer()
        const row = await screen.findByText('every ~3 days', { exact: false })
        await u.click(row.closest('button')!)
        await waitFor(() => expect(lastQuery()?.dataSourceId).toBe('ds_1'))
        const chips = await screen.findByRole('list', { name: 'Active filters' })
        expect(within(chips).getByText('Ledger')).toBeInTheDocument()
        // Back to the selection already on screen (and in the cache).
        await u.click(within(chips).getByRole('button', { name: 'Remove the data source filter' }))
        await waitFor(() => expect(urlParams().get('act_ds')).toBeNull())
        expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument()
    })

    it('shows the delta as a percentage of the previous period', async () => {
        renderExplorer()
        expect(await screen.findByText('+20.0%')).toBeInTheDocument()
        expect(screen.getByText('9 of 12 changes said why')).toBeInTheDocument()
    })
})

describe('live and honest', () => {
    it('counts what arrived since the page loaded, and shows it on request', async () => {
        service.countNewer.mockResolvedValue({ count: 3, capped: false })
        const u = userEvent.setup()
        renderExplorer()
        const pill = await screen.findByRole('button', { name: /3 new events/ })
        const calls = service.listEvents.mock.calls.length
        await u.click(pill)
        await waitFor(() => expect(service.listEvents.mock.calls.length).toBeGreaterThan(calls))
    })

    it('says when history is still being imported, and does not count it as new', async () => {
        service.listEvents.mockResolvedValue({
            events: [ev()], nextCursor: null,
            ledger: { ...LEDGER, pending: 50_000, backfilling: true },
        })
        renderExplorer()
        expect(await screen.findByText(/Importing earlier activity/)).toBeInTheDocument()
        expect(service.countNewer).not.toHaveBeenCalled()
    })

    it('offers to clear filters when nothing matches them', async () => {
        service.listEvents.mockResolvedValue({ events: [], nextCursor: null, ledger: LEDGER })
        const u = userEvent.setup()
        renderExplorer(PLATFORM, '/admin/audit?act_person=nobody')
        await u.click(await screen.findByRole('button', { name: 'Clear filters' }))
        await waitFor(() => expect(urlParams().get('act_person')).toBeNull())
    })
})

describe('the log says what it keeps', () => {
    it('ends the list with how long activity is kept', async () => {
        service.listEvents.mockResolvedValue({ events: [ev()], nextCursor: null, ledger: { ...LEDGER, retentionDays: 730 } })
        renderExplorer()
        expect(await timeline().findByText('The end of this range. The log keeps 2 years of activity.')).toBeInTheDocument()
    })

    it('says nothing about it while there are older events to show, or when everything is kept', async () => {
        service.listEvents.mockResolvedValue({ events: [ev()], nextCursor: 'c', ledger: { ...LEDGER, retentionDays: 730 } })
        const { unmount } = renderExplorer()
        await loaded()
        expect(screen.queryByText(/The log keeps/)).not.toBeInTheDocument()
        unmount()
        service.listEvents.mockResolvedValue({ events: [ev()], nextCursor: null, ledger: { ...LEDGER, retentionDays: null } })
        renderExplorer()
        await loaded()
        expect(screen.queryByText(/The log keeps/)).not.toBeInTheDocument()
    })

    it('explains a missing comparison rather than inventing one', async () => {
        service.getSummary.mockResolvedValue(summary({
            window: { ...summary().window, keptFrom: '2024-10-13T00:00:00+00:00' },
            totals: {
                events: { current: 120, previous: null, delta: null },
                people: { current: 7, previous: null, delta: null },
                operations: { current: 12, previous: null, delta: null },
                reasons: { given: 9, of: 12, share: 0.75 },
            },
        }))
        renderExplorer()
        expect(await screen.findByText(/No change is shown: the log keeps activity from/)).toBeInTheDocument()
        expect(screen.queryByText(/^[+-]\d/)).not.toBeInTheDocument()
    })
})

describe('the insight band says who, and what needs a look', () => {
    it('shows who keeps operating each hands-on source', async () => {
        service.getSummary.mockResolvedValue(summary({
            handsOnSources: [{
                ...summary().handsOnSources[0],
                people: [
                    { id: 'usr_ana', count: 4, name: 'Ana Lyst', deleted: false },
                    { id: 'usr_ben', count: 2, name: 'Ben Ops', deleted: false },
                ],
            }],
        }))
        renderExplorer()
        expect(await screen.findByText('Run by Ana Lyst, Ben Ops')).toBeInTheDocument()
    })

    it('calls out a source run by hand every few hours, and narrows to it in one click', async () => {
        service.getSummary.mockResolvedValue(summary({
            handsOnSources: [{ ...summary().handsOnSources[0], medianGapHours: 5 }],
        }))
        const u = userEvent.setup()
        renderExplorer()
        const callouts = await screen.findByRole('region', { name: 'Needs attention' })
        await u.click(within(callouts).getByRole('button', { name: /Ledger is run by hand every ~5h/ }))
        await waitFor(() => expect(lastQuery()?.dataSourceId).toBe('ds_1'))
    })

    it('says nothing when nothing needs a look', async () => {
        service.getSummary.mockResolvedValue(summary({
            totals: { ...summary().totals, operations: { current: 12, previous: 11, delta: 0.09 } },
        }))
        renderExplorer()
        await screen.findByText('9 of 12 changes said why')
        expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument()
    })
})

describe('a person in focus', () => {
    it('shows who they are, when they are busiest and what they do most', async () => {
        const u = userEvent.setup()
        renderExplorer(PLATFORM, '/admin/audit?act_person=usr_ana&act_role=actor')
        const spot = await screen.findByRole('region', { name: 'Person in focus' })
        expect(await within(spot).findByText('Ana Lyst')).toBeInTheDocument()
        expect(within(spot).getByText('What they did')).toBeInTheDocument()
        expect(await within(spot).findByText('Tuesdays, 14:00 UTC')).toBeInTheDocument()

        await u.click(within(spot).getByRole('button', { name: /Triggered aggregation/ }))
        await waitFor(() => expect(urlParams().get('act_type')).toBe('aggregation.job.triggered'))

        await u.click(within(spot).getByRole('button', { name: 'Clear the person filter' }))
        await waitFor(() => expect(urlParams().get('act_person')).toBeNull())
        expect(screen.queryByRole('region', { name: 'Person in focus' })).not.toBeInTheDocument()
    })

    it('is not shown for typed text, which may match several people', async () => {
        renderExplorer(PLATFORM, '/admin/audit?act_person=ana')
        await loaded()
        expect(screen.queryByRole('region', { name: 'Person in focus' })).not.toBeInTheDocument()
    })
})

describe('from the keyboard', () => {
    const EVENTS = [
        ev({ id: 'evt_1', summary: 'Triggered aggregation of Ledger' }),
        ev({ id: 'evt_2', summary: 'Refreshed Ledger' }),
        ev({ id: 'evt_3', summary: 'Reconciled Ledger' }),
    ]
    const row = (text: string) => timeline().getByText(text).closest('button')!

    beforeEach(() => {
        service.listEvents.mockResolvedValue({ events: EVENTS, nextCursor: null, ledger: LEDGER })
        service.getEvent.mockImplementation(async (_scope, id) => ({
            event: EVENTS.find((e) => e.id === id)!, sameRequest: [], sameTarget: [],
        }))
    })

    it('walks the rows with j and k, and opens one with Enter', async () => {
        const u = userEvent.setup()
        renderExplorer()
        await loaded()
        await u.keyboard('j')
        expect(row('Triggered aggregation of Ledger')).toHaveFocus()
        await u.keyboard('jj')
        expect(row('Reconciled Ledger')).toHaveFocus()
        await u.keyboard('{ArrowUp}')
        expect(row('Refreshed Ledger')).toHaveFocus()
        await u.keyboard('{Enter}')
        await screen.findByRole('dialog', { name: 'Activity event' })
        expect(urlParams().get('act_event')).toBe('evt_2')
    })

    it('steps through events in the drawer, and Esc lands on the last one read', async () => {
        const u = userEvent.setup()
        renderExplorer(PLATFORM, '/admin/audit?act_event=evt_1')
        const dialog = await screen.findByRole('dialog', { name: 'Activity event' })
        await loaded()
        expect(within(dialog).getByRole('button', { name: 'Newer event' })).toBeDisabled()
        await u.keyboard('j')
        await waitFor(() => expect(urlParams().get('act_event')).toBe('evt_2'))
        await u.click(within(dialog).getByRole('button', { name: 'Older event' }))
        await waitFor(() => expect(urlParams().get('act_event')).toBe('evt_3'))
        expect(within(dialog).getByRole('button', { name: 'Older event' })).toBeDisabled()
        await u.keyboard('{ArrowLeft}')
        await waitFor(() => expect(urlParams().get('act_event')).toBe('evt_2'))

        await u.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Activity event' })).not.toBeInTheDocument())
        expect(row('Refreshed Ledger')).toHaveFocus()
    })

    it('leaves the arrows to a region that scrolls sideways, such as the raw payload', async () => {
        const u = userEvent.setup()
        renderExplorer(PLATFORM, '/admin/audit?act_event=evt_1')
        const dialog = await screen.findByRole('dialog', { name: 'Activity event' })
        await loaded()
        const raw = await within(dialog).findByText('Raw event payload')
        await u.click(raw)
        const tree = within(dialog).getByRole('group', { name: 'event payload as JSON' })
        Object.defineProperty(tree, 'scrollWidth', { configurable: true, value: 900 })
        Object.defineProperty(tree, 'clientWidth', { configurable: true, value: 400 })
        tree.focus()
        await u.keyboard('{ArrowRight}')
        expect(urlParams().get('act_event')).toBe('evt_1')
        await u.keyboard('j')
        await waitFor(() => expect(urlParams().get('act_event')).toBe('evt_2'))
    })

    it('/ goes to search and ? lists the keys, but not while typing', async () => {
        const u = userEvent.setup()
        renderExplorer()
        await loaded()
        await u.keyboard('/')
        expect(screen.getByLabelText('Search activity')).toHaveFocus()
        await u.keyboard('j?')
        expect(screen.getByLabelText('Search activity')).toHaveValue('j?')
        expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()

        await u.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
        const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
        expect(within(sheet).getByText('Next event')).toBeInTheDocument()
        await u.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument())
        ;(document.activeElement as HTMLElement | null)?.blur()
        await u.keyboard('?')
        expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    })
})
