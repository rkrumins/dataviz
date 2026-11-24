/**
 * PeopleTab — draws what the server sent for the reader's lens, and nothing it withheld.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PEOPLE_FIXTURES } from '@/harness/peopleFixtures'
import { peopleActivityService } from '@/services/peopleActivityService'
import { PeopleTab } from '../PeopleTab'

vi.mock('@/services/peopleActivityService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/peopleActivityService')>()
    return { ...actual, peopleActivityService: { roster: vi.fn(), person: vi.fn(), calendar: vi.fn(), day: vi.fn(), events: vi.fn() } }
})

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(),
        removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const roster = vi.mocked(peopleActivityService.roster)

function renderTab(workspaceId: string | null = null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <PeopleTab range={{ kind: 'preset', days: 30 }} onRangeChange={vi.fn()} workspaceId={workspaceId} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('PeopleTab', () => {
    // mockClear, not mockReset: each test sets its own result, and under vitest 4 a
    // reset mock that is then given a rejection fails the test it is used in.
    beforeEach(() => { roster.mockClear() })

    it('shows an analytics administrator everyone, sign-ins included', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        expect(await screen.findByText('Active people')).toBeInTheDocument()
        expect(screen.getAllByText('Signed in').length).toBeGreaterThan(0)
        expect(screen.getByText('Idle sign-ins')).toBeInTheDocument()
        expect(screen.getByText("Who's active, day by day")).toBeInTheDocument()
        const top = PEOPLE_FIXTURES.privileged.people[0]
        expect(screen.getAllByRole('link', { name: new RegExp(top.name) })[0])
            .toHaveAttribute('href', expect.stringContaining(`/analytics/people/${top.userId}`))
    })

    it('shows a workspace admin their workspace, with no sign-ins and quiet members named', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.workspaceAdmin)
        renderTab('ws_atlas')
        expect((await screen.findAllByText('Quiet members')).length).toBeGreaterThan(0)
        expect(screen.queryByText('Idle sign-ins')).toBeNull()
        expect(screen.queryByText('Last signed in')).toBeNull()
        expect(screen.getByText('Rosalind Franklin')).toBeInTheDocument()
        expect(roster).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: 'ws_atlas' }))
    })

    it('says so, and points at their own activity, when the reader may not look', async () => {
        roster.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }))
        renderTab()
        expect(await screen.findByText('People activity is not open to you here')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /See your own activity/ })).toHaveAttribute('href', '/me/activity')
    })

    it('asks the server to sort and search, a page at a time', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        await screen.findByText('Everyone, in detail')
        await userEvent.click(screen.getByRole('button', { name: /^Active days/ }))
        await waitFor(() => expect(roster).toHaveBeenLastCalledWith(
            expect.anything(), expect.objectContaining({ sort: 'activeDays', order: 'desc', offset: 0 })))
        await userEvent.type(screen.getByPlaceholderText('Find a person…'), 'ada')
        await waitFor(() => expect(roster).toHaveBeenLastCalledWith(
            expect.anything(), expect.objectContaining({ q: 'ada' })))
    })
})
