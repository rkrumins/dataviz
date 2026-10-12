/**
 * A record as written, made readable: open to a depth, every branch foldable,
 * all of it one click from open, long lists and strings paged, and the
 * document — exactly as JSON — one click from the clipboard.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { JSON_PAGE, JSON_STRING_CUT, JsonTree } from '../JsonTree'

const DOC = {
    actor_id: 'usr_ana',
    count: 3,
    ok: true,
    gone: null,
    details: { jobId: 'agg_1', limits: { timeout: 10 } },
}

describe('JsonTree', () => {
    it('shows the first levels open and folds deeper ones, saying how much they hold', () => {
        render(<JsonTree value={DOC} label="event payload" />)
        const tree = screen.getByRole('group', { name: 'event payload' })
        expect(tree).toHaveTextContent('"actor_id": "usr_ana"')
        expect(tree).toHaveTextContent('"count": 3')
        expect(tree).toHaveTextContent('"ok": true')
        expect(tree).toHaveTextContent('"gone": null')
        expect(tree).toHaveTextContent('"jobId": "agg_1"')
        // Depth two is folded: its size, not its contents.
        expect(within(tree).getByRole('button', { name: 'limits — 1 key' }))
            .toHaveAttribute('aria-expanded', 'false')
        expect(tree).not.toHaveTextContent('"timeout"')
    })

    it('opens and shuts a branch, and opens or folds everything at once', async () => {
        const u = userEvent.setup()
        render(<JsonTree value={DOC} label="event payload" />)
        const tree = screen.getByRole('group', { name: 'event payload' })
        await u.click(within(tree).getByRole('button', { name: 'limits — 1 key' }))
        expect(tree).toHaveTextContent('"timeout": 10')

        // Folded to the top level: its own values, and the size of each branch.
        await u.click(screen.getByRole('button', { name: /Collapse/ }))
        expect(tree).toHaveTextContent('"actor_id": "usr_ana"')
        expect(tree).not.toHaveTextContent('"jobId"')
        expect(within(tree).getByRole('button', { name: 'details — 2 keys' })).toHaveAttribute('aria-expanded', 'false')
        await u.click(screen.getByRole('button', { name: /Expand all/ }))
        expect(tree).toHaveTextContent('"timeout": 10')
    })

    it('pages a long list and cuts a long string until asked', async () => {
        const u = userEvent.setup()
        const items = Array.from({ length: JSON_PAGE + 7 }, (_, i) => i)
        render(<JsonTree value={{ items, note: 'y'.repeat(JSON_STRING_CUT + 10) }} label="doc" openDepth={3} />)
        const tree = screen.getByRole('group', { name: 'doc' })
        expect(tree).not.toHaveTextContent(`${JSON_PAGE + 6}`)
        await u.click(within(tree).getByRole('button', { name: 'Show 7 more of 7' }))
        expect(within(tree).queryByRole('button', { name: /Show .* more/ })).not.toBeInTheDocument()

        await u.click(within(tree).getByRole('button', { name: '+10 characters' }))
        expect(tree).toHaveTextContent('y'.repeat(JSON_STRING_CUT + 10))
    })

    it('copies the document exactly, as JSON', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        render(<JsonTree value={DOC} label="event payload" />)
        await userEvent.click(screen.getByRole('button', { name: 'Copy event payload as JSON' }))
        expect(writeText).toHaveBeenCalledWith(JSON.stringify(DOC, null, 2))
    })
})
