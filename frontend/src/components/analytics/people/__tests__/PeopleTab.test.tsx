/**
 * PeopleTab — draws what the server sent for the reader's lens, and nothing it withheld.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PEOPLE_FIXTURES, peopleLines, scopeDay } from '@/harness/peopleFixtures'
import { peopleActivityService } from '@/services/peopleActivityService'
import { PeopleTab } from '../PeopleTab'

vi.mock('@/services/peopleActivityService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/peopleActivityService')>()
    return { ...actual, peopleActivityService: { roster: vi.fn(), person: vi.fn(), calendar: vi.fn(), day: vi.fn(), events: vi.fn(), lines: vi.fn(), scopeDay: vi.fn() } }
})

beforeAll(() => {
    window.matchMedia = window.matchMedia ?? (((query: string) => ({
        matches: query.includes('min-width'), media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(),
        removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia)
})

const roster = vi.mocked(peopleActivityService.roster)
const lines = vi.mocked(peopleActivityService.lines)
const day = vi.mocked(peopleActivityService.scopeDay)

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
    beforeEach(() => {
        roster.mockClear()
        lines.mockReset()
        lines.mockImplementation(async (ids) => peopleLines(ids))
        day.mockReset()
        day.mockImplementation(async (d) => scopeDay(d))
    })

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

    it('draws every person’s activity line, and compares the ones ticked', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        await screen.findByText('Everyone, in detail')
        const [first, second] = PEOPLE_FIXTURES.privileged.people
        expect(screen.getByRole('img', { name: new RegExp(`^${first.name}, actions per period`) })).toBeInTheDocument()
        await userEvent.click(screen.getByRole('checkbox', { name: `Compare ${first.name}` }))
        await userEvent.click(screen.getByRole('checkbox', { name: `Compare ${second.name}` }))
        expect(await screen.findByText('Compare activity lines')).toBeInTheDocument()
        await waitFor(() => expect(lines).toHaveBeenLastCalledWith(
            [first.userId, second.userId], expect.anything(), null))
        expect(screen.getByRole('button', { name: `Stop comparing ${second.name}` })).toBeInTheDocument()
    })

    it('compares at most six people at once', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        await screen.findByText('Everyone, in detail')
        const boxes = screen.getAllByRole('checkbox', { name: /^Compare / })
        for (const box of boxes.slice(0, 6)) await userEvent.click(box)
        expect(boxes[6]).toBeDisabled()
        await userEvent.click(boxes[0])
        expect(boxes[6]).not.toBeDisabled()
    })

    it('shows the page as a grid of lines, each linked to the person', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        await screen.findByText("Who's active, day by day")
        await userEvent.click(screen.getByRole('radio', { name: /Lines/ }))
        expect(screen.getByText('Everyone’s activity line')).toBeInTheDocument()
        const top = PEOPLE_FIXTURES.privileged.people[0]
        const tiles = screen.getAllByRole('link', { name: new RegExp(top.name) })
        expect(tiles.some((a) => a.getAttribute('href')?.startsWith(`/analytics/people/${top.userId}`))).toBe(true)
        expect(screen.getByText(/One scale for every line/)).toBeInTheDocument()
    })

    it('opens a day and lists exactly who was around', async () => {
        roster.mockResolvedValue(PEOPLE_FIXTURES.privileged)
        renderTab()
        await screen.findByText("Who's active, day by day")
        const lastDay = PEOPLE_FIXTURES.privileged.series.buckets.at(-1)!
        const opener = screen.getAllByRole('button', { name: /^Open / }).at(-1)!
        await userEvent.click(opener)
        await waitFor(() => expect(day).toHaveBeenCalledWith(lastDay, null))
        const dialog = await screen.findByRole('dialog', { name: /Activity on/ })
        const expected = scopeDay(lastDay)
        expect(await within(dialog).findByText(`${expected.active} active`, { exact: false })).toBeInTheDocument()
    })
})
