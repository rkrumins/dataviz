/**
 * Folding "What changed" must not fold away the reason to read it.
 *
 * A disclosure that hides "two things need attention" behind the word
 * "expand" is how a dashboard grows an unread alarm, so the collapsed header
 * keeps the tally and the most significant headline.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InsightStrip } from '../InsightStrip'
import type { Insight } from '@/services/analyticsService'

const INSIGHTS: Insight[] = [
    { key: 'a', tone: 'bad', headline: 'Traces come back empty', detail: '24% of them.', tab: 'engagement' },
    { key: 'b', tone: 'bad', headline: 'Access requests pending', detail: 'Oldest is 6 days.', tab: null },
    { key: 'c', tone: 'good', headline: 'Sign-ups up 35%', detail: '96 this period.', tab: 'growth' },
] as never

beforeEach(() => window.localStorage.clear())
afterEach(() => window.localStorage.clear())

function renderStrip() {
    return render(<InsightStrip insights={INSIGHTS} rangeLabel="Last 30 days" />)
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
            <InsightStrip insights={[]} rangeLabel="Last 30 days" />,
        )
        expect(container).toBeEmptyDOMElement()
    })
})
