/**
 * PersonActivityPage — one person's year, a day at a time, and everything they did.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PersonActivityPage } from '@/pages/PersonActivityPage'
import { personCalendar, personDay, personDoc, personFeed } from '@/harness/peopleFixtures'
import { peopleActivityService } from '@/services/peopleActivityService'

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
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn()
})

const svc = vi.mocked(peopleActivityService)

function renderAt(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/analytics/people/:userId" element={<PersonActivityPage />} />
                    <Route path="/me/activity" element={<PersonActivityPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('PersonActivityPage', () => {
    beforeEach(() => {
        svc.person.mockResolvedValue(personDoc())
        svc.calendar.mockResolvedValue(personCalendar())
        svc.day.mockImplementation(async (_id, d) => personDay(d))
        svc.events.mockResolvedValue(personFeed())
    })

    it('tells their story: who, since when, and where they stand', async () => {
        renderAt('/analytics/people/usr_ada?range=30')
        expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument()
        expect(screen.getByText(/More active than 86% of people/)).toBeInTheDocument()
        expect(screen.getByText('Where they work, and since when')).toBeInTheDocument()
        expect(screen.getByText(/2 failed sign-in attempts/)).toBeInTheDocument()
        expect(svc.person).toHaveBeenCalledWith('usr_ada', { kind: 'preset', days: 30 }, null)
    })

    it('opens a day from the calendar, in sessions', async () => {
        renderAt('/analytics/people/usr_ada')
        await screen.findByRole('heading', { name: 'Ada Lovelace' })
        const cells = await screen.findAllByRole('button', { name: /actions/ })
        await userEvent.click(cells[cells.length - 1])
        const dialog = await screen.findByRole('dialog', { name: /Activity on/ })
        expect(await within(dialog).findByText('Session 1')).toBeInTheDocument()
        expect(within(dialog).getByText('Session 3')).toBeInTheDocument()
        expect(within(dialog).getAllByText('Revenue lineage').length).toBeGreaterThan(0)
    })

    it('lists everything they did, and filters it by kind', async () => {
        renderAt('/analytics/people/usr_ada?tab=activity')
        expect(await screen.findByText('Everything they did')).toBeInTheDocument()
        expect((await screen.findAllByText('Started an aggregation')).length).toBeGreaterThan(0)
        await userEvent.click(screen.getByRole('button', { name: 'Traced lineage' }))
        expect(svc.events).toHaveBeenLastCalledWith('usr_ada', expect.objectContaining({ kinds: ['trace'] }))
    })

    it('reads the caller as “me” at /me/activity', async () => {
        renderAt('/me/activity')
        await screen.findByRole('heading', { name: 'Ada Lovelace' })
        expect(svc.person).toHaveBeenCalledWith('me', expect.anything(), null)
    })

    it('explains a refusal instead of breaking', async () => {
        svc.person.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }))
        renderAt('/analytics/people/usr_ada')
        expect(await screen.findByText('This activity is not yours to see')).toBeInTheDocument()
    })
})
