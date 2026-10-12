/**
 * Folding "What changed" must not fold away the reason to read it.
 *
 * A disclosure that hides "two things need attention" behind the word
 * "expand" is how a dashboard grows an unread alarm, so the collapsed header
 * keeps the tally and the most significant headline.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InsightStrip } from '../InsightStrip'
import { useAuthStore } from '@/store/auth'
import type { Insight } from '@/services/analyticsService'

const INSIGHTS: Insight[] = [
    { key: 'trace-empty', tone: 'bad', headline: 'Traces come back empty', detail: '24% of them.', tab: 'engagement', spark: null },
    { key: 'access-backlog', tone: 'bad', headline: 'Access requests pending', detail: 'Oldest is 6 days.', tab: null, spark: null },
    { key: 'signups', tone: 'good', headline: 'Sign-ups up 35%', detail: '96 this period.', tab: 'growth', spark: [1, 4, 2, 7, 5] },
    { key: 'invite-acceptance', tone: 'watch', headline: 'Only 40% of invites accepted', detail: '10 sent, 4 redeemed.', tab: 'growth', spark: null },
]

function claims(global: string[] = []) {
    useAuthStore.setState({
        permissions: { sid: 'test', global, ws: {} },
        permissionsStatus: 'ready',
    } as never)
}

beforeEach(() => {
    window.localStorage.clear()
    claims()
})
afterEach(() => window.localStorage.clear())

function renderStrip(props: Partial<Parameters<typeof InsightStrip>[0]> = {}) {
    return render(
        <MemoryRouter>
            <InsightStrip insights={INSIGHTS} rangeLabel="Last 30 days" {...props} />
        </MemoryRouter>,
    )
}

describe('InsightStrip', () => {
    it('opens expanded, and folds away the cards on request', async () => {
        const user = userEvent.setup()
        renderStrip()

        const toggle = screen.getByRole('button', { name: /what changed/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Access requests pending')).toBeInTheDocument()

        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        // `display: none` takes them out of the accessibility tree too, rather
        // than leaving them readable to a screen reader and invisible to
        // everyone else.
        expect(screen.queryByText('Access requests pending')).not.toBeVisible()
    })

    it('keeps the tally and the lead finding on the folded header', async () => {
        const user = userEvent.setup()
        renderStrip()
        await user.click(screen.getByRole('button', { name: /what changed/i }))

        // Counted by tone, and the worst is named first.
        const header = screen.getByRole('button', { name: /what changed/i })
        expect(header).toHaveTextContent('2 needs attention')
        expect(header).toHaveTextContent('1 good news')
        // The server ranks by significance, so the first insight is the one
        // worth showing when there is room for exactly one.
        expect(header).toHaveTextContent('Traces come back empty')
    })

    it('remembers being folded, because saying so once is enough', async () => {
        const user = userEvent.setup()
        const { unmount } = renderStrip()
        await user.click(screen.getByRole('button', { name: /what changed/i }))
        unmount()

        renderStrip()
        expect(screen.getByRole('button', { name: /what changed/i }))
            .toHaveAttribute('aria-expanded', 'false')
    })

    it('says nothing at all when there is nothing to say', () => {
        const { container } = render(
            <MemoryRouter>
                <InsightStrip insights={[]} rangeLabel="Last 30 days" />
            </MemoryRouter>,
        )
        expect(container).toBeEmptyDOMElement()
    })

    // ── The next step ───────────────────────────────────────────────

    it('offers the screen that fixes a finding, when the reader can open it', () => {
        claims(['system:admin'])
        renderStrip()
        expect(screen.getByRole('link', { name: /review users and invitations/i }))
            .toHaveAttribute('href', '/admin/users')
    })

    it('withholds an action the reader cannot reach', () => {
        // A door that turns you away reads as a broken product rather than as
        // a scoped one, so it is not offered at all.
        renderStrip()
        expect(screen.queryByRole('link', { name: /review users and invitations/i }))
            .toBeNull()
        // One with no permission bar is still there.
        expect(screen.getByRole('link', { name: /open workspaces/i })).toBeInTheDocument()
    })

    // ── Clearing ────────────────────────────────────────────────────

    it('clears a finding into a count, never into thin air', async () => {
        const user = userEvent.setup()
        renderStrip()

        await user.click(screen.getByRole('button', { name: /^clear: access requests pending$/i }))
        expect(screen.queryByText('Oldest is 6 days.')).toBeNull()

        // Counted, and reversible: an alarm you silenced and cannot find again
        // is worse than one you never silenced.
        await user.click(screen.getByRole('button', { name: /1 cleared/i }))
        await user.click(screen.getByRole('button', { name: /restore: access requests pending/i }))
        expect(screen.getByText('Oldest is 6 days.')).toBeInTheDocument()
    })

    it('lets a dismissal lapse when the finding itself changes', async () => {
        const user = userEvent.setup()
        const { unmount } = renderStrip()
        await user.click(screen.getByRole('button', { name: /^clear: access requests pending$/i }))
        unmount()

        // Same rule, new sentence — "7 pending" cleared on Monday must not
        // keep "23 pending" quiet on Friday.
        const moved = INSIGHTS.map((i) => i.key === 'access-backlog'
            ? { ...i, headline: '23 access requests pending' }
            : i)
        renderStrip({ insights: moved })
        expect(screen.getByText('23 access requests pending')).toBeInTheDocument()
    })

    // ── Filtering and tracing ───────────────────────────────────────

    it('filters to one tone, and the chip is its own undo', async () => {
        const user = userEvent.setup()
        renderStrip()

        // The chip's accessible name is its count plus its tone — the
        // `title` is a tooltip, not a label.
        const goodChip = screen.getByRole('button', { name: /good news/i })
        await user.click(goodChip)
        expect(screen.getByText('96 this period.')).toBeInTheDocument()
        expect(screen.queryByText('24% of them.')).toBeNull()

        await user.click(goodChip)
        expect(screen.getByText('24% of them.')).toBeInTheDocument()
    })

    it('sends a finding to the chart that shows the working', async () => {
        const user = userEvent.setup()
        const onNavigate = vi.fn()
        const chart = document.createElement('section')
        chart.id = 'chart-value-moments'
        document.body.appendChild(chart)

        renderStrip({ onNavigate })
        await user.click(screen.getByRole('button', { name: /^traces come back empty$/i }))

        expect(onNavigate).toHaveBeenCalledWith('engagement')
        // Marked, so the reader can see which of six cards they were sent to.
        await vi.waitFor(() => expect(chart.getAttribute('data-revealed')).toBe('true'))
        chart.remove()
    })
})
