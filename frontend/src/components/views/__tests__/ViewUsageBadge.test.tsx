/**
 * The metrics line's three states, and the rule that binds them: every figure
 * says what it is ON THE SURFACE.
 *
 * This used to render `👁 1.8k  👤 214` and hide "1,840 opens by 214 people in
 * the last 30 days" in a native `title`, so both numbers were unreadable until
 * hovered and the sparkline beside them never said what it plotted. The
 * assertions below pin the unit against the number and the window against the
 * pair, because that is the part a redesign is most likely to quietly drop.
 *
 * "Nobody has opened this" is still the single most useful thing a view's
 * author can learn, and it is exactly the state a naive counter renders as
 * "0" — which reads as a broken widget rather than as a finding.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewUsageBadge } from '../ViewUsageBadge'
import * as service from '@/services/contentInsightsService'

vi.mock('@/services/contentInsightsService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/contentInsightsService')>()),
    getViewUsage: vi.fn(),
}))

function renderBadge(viewId = 'v1') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <ViewUsageBadge viewId={viewId} />
        </QueryClientProvider>,
    )
}

describe('ViewUsageBadge', () => {
    beforeEach(() => vi.clearAllMocks())

    it('says what each number is, and over what window', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 1840, uniqueViewers: 214,
                lastOpenedAt: '2026-06-15T09:00:00+00:00',
                trend: [3, 9, 4, 12, 7], windowDays: 30, lifetimeOpens: 0, onlyAuthor: false,
            yourOpens: 0, yourLastOpenedAt: null,
            },
        })
        renderBadge()
        // People lead — the number that says whether a view is load-bearing.
        const people = await screen.findByText('214')
        expect(people.parentElement?.textContent).toBe('214 people')
        expect(screen.getByText('1.8k').parentElement?.textContent).toBe('1.8k opens')
        expect(screen.getByText('last 30 days')).toBeInTheDocument()
    })

    it('says "1 person" and "1 open", not "1 persons"', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 1, uniqueViewers: 1,
                lastOpenedAt: '2026-06-15T09:00:00+00:00',
                trend: [0, 0, 1], windowDays: 30, lifetimeOpens: 1, onlyAuthor: true,
            yourOpens: 1, yourLastOpenedAt: '2026-06-15T09:00:00+00:00',
            },
        })
        renderBadge()
        const [people, opens] = await screen.findAllByText('1')
        expect(people.parentElement?.textContent).toBe('1 person')
        expect(opens.parentElement?.textContent).toBe('1 open')
    })

    it('names what the sparkline plots, for a reader who cannot see it', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 35, uniqueViewers: 4, lastOpenedAt: null,
                trend: [3, 9, 4, 12, 7], windowDays: 30, lifetimeOpens: 35, onlyAuthor: false,
            yourOpens: 0, yourLastOpenedAt: null,
            },
        })
        renderBadge()
        expect(await screen.findByText('opens per day')).toBeInTheDocument()
        expect(
            screen.getByText(/opens per day over the last 30 days/i),
        ).toHaveClass('sr-only')
    })

    it('explains the trend in the app\u2019s own tooltip, not in OS chrome', async () => {
        // The chart used to name itself with an SVG <title> holding all thirty
        // plotted values — an unreadable accessible name AND a native pill that
        // paints over the header, inside a row whose other two figures already
        // used HoverTip. The shape gets a real tip like everything else here.
        const user = userEvent.setup()
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 35, uniqueViewers: 4, lastOpenedAt: null,
                trend: [3, 9, 4, 12, 7], windowDays: 30, lifetimeOpens: 35, onlyAuthor: false,
            yourOpens: 0, yourLastOpenedAt: null,
            },
        })
        const { container } = renderBadge()
        const caption = await screen.findByText('opens per day')
        expect(container.querySelector('svg > title')).toBeNull()

        await user.hover(caption)
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('12 opens on the busiest day')
        // The figure is not on the surface, so the tip earns its keep.
        expect(tip).toHaveTextContent(/No opens at all on|Opened on every one/)
    })

    it('calls out a view nobody opens — and names the window it looked at', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 0, uniqueViewers: 0, lastOpenedAt: null,
                trend: [0, 0, 0], windowDays: 30, lifetimeOpens: 0, onlyAuthor: false,
            yourOpens: 0, yourLastOpenedAt: null,
            },
        })
        renderBadge()
        expect(await screen.findByText(/not opened in the last 30 days/i)).toBeInTheDocument()
        expect(screen.queryByText('0')).toBeNull()
    })

    it('renders nothing when usage cannot be fetched', async () => {
        // A view page must never break because a decoration failed.
        vi.mocked(service.getViewUsage).mockRejectedValue(new Error('403'))
        const { container } = renderBadge()
        await waitFor(() => expect(service.getViewUsage).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing for a view the server did not answer for', async () => {
        // An unreadable id comes back absent, which is also what a made-up id
        // does — the badge must treat both as "no answer", not as zero usage.
        vi.mocked(service.getViewUsage).mockResolvedValue({})
        const { container } = renderBadge('v-unreadable')
        await waitFor(() => expect(service.getViewUsage).toHaveBeenCalled())
        expect(container).toBeEmptyDOMElement()
    })
})
