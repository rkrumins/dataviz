import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { HistoryExplainer } from './HistoryExplainer'

describe('HistoryExplainer', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('offers itself collapsed, so it never competes with the chart', () => {
        render(<HistoryExplainer />)
        expect(screen.getByText(/reading this history/i)).toBeInTheDocument()
        expect(screen.queryByText(/observations are event-driven/i)).toBeNull()
    })

    it('explains the four things the chart cannot say on its own', async () => {
        render(<HistoryExplainer />)
        await userEvent.click(screen.getByRole('button', { name: /show/i }))

        expect(screen.getByText(/observations are event-driven/i)).toBeInTheDocument()
        expect(screen.getByText(/history starts at the first capture/i)).toBeInTheDocument()
        expect(screen.getByText(/relative to this source/i)).toBeInTheDocument()
        expect(screen.getByText(/a failed collection records nothing/i)).toBeInTheDocument()
    })

    it('quotes this source’s real baseline rather than a generic one', async () => {
        render(<HistoryExplainer baseline={4200} />)
        await userEvent.click(screen.getByRole('button', { name: /show/i }))
        expect(screen.getByText(/about 4,200 entities here/i)).toBeInTheDocument()
    })

    it('stays dismissed on this browser once dismissed', async () => {
        const { unmount } = render(<HistoryExplainer />)
        await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
        expect(screen.queryByText(/reading this history/i)).toBeNull()

        unmount()
        render(<HistoryExplainer />)
        expect(screen.queryByText(/reading this history/i)).toBeNull()
    })

    it('renders when storage is unreadable rather than throwing', () => {
        // A private window or blocked site data throws on ACCESS, not on read.
        const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { throw new Error('blocked') },
        })
        try {
            render(<HistoryExplainer />)
            expect(screen.getByText(/reading this history/i)).toBeInTheDocument()
        } finally {
            if (original) Object.defineProperty(window, 'localStorage', original)
        }
    })
})
