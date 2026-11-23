/**
 * The Overview's Recent changes: it opens on the latest few — never the whole log growing with
 * every change — and the reader expands it in place, a few more at a time, fetching older changes
 * a page at a time once everything loaded is showing, and folds it back.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewActivityEntry } from '@/services/viewApiService'

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }))
vi.mock('@/services/viewApiService', async (orig) => ({
    ...(await orig<typeof import('@/services/viewApiService')>()),
    getWorkspaceViewActivity: fetchPage,
}))

import { WorkspaceActivityFeed } from '../WorkspaceActivityFeed'

/** The workspace's whole log, newest first: `total` changes, served by limit and offset. */
function logOf(total: number) {
    const all: ViewActivityEntry[] = Array.from({ length: total }, (_, i) => ({
        id: `act_${i}`, viewId: `v_${i}`, action: 'updated', actor: 'usr_ada', actorName: 'Ada Okafor', actorEmail: null,
        summary: null, changes: null, createdAt: new Date(Date.now() - i * 3_600_000).toISOString(), viewName: `View ${i}`,
        workspaceId: 'ws1',
    } as ViewActivityEntry))
    fetchPage.mockImplementation(async (_ws: string, { limit = 25, offset = 0 } = {}) => all.slice(offset, offset + limit))
}

function renderFeed(limit?: number) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><WorkspaceActivityFeed workspaceId="ws1" limit={limit} /></MemoryRouter>
        </QueryClientProvider>,
    )
}

const names = () => screen.getAllByText(/^View \d+$/).map((n) => n.textContent)

beforeEach(() => fetchPage.mockReset())

describe('the workspace’s recent changes', () => {
    it('opens on the latest few, and expands in place as far back as the log goes', async () => {
        logOf(40)
        renderFeed(6)
        await waitFor(() => expect(names()).toHaveLength(6))
        expect(names()[0]).toBe('View 0')
        expect(fetchPage).toHaveBeenCalledTimes(1)
        expect(fetchPage).toHaveBeenLastCalledWith('ws1', { limit: 25, offset: 0 })

        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: /Show 10 more/ }))
        expect(names()).toHaveLength(16)
        await user.click(screen.getByRole('button', { name: /Show 9 more|Show older changes/ }))
        // 25 were loaded; asking past them fetches the next page, and the list grows when it lands.
        await waitFor(() => expect(names()).toHaveLength(26))
        expect(fetchPage).toHaveBeenLastCalledWith('ws1', { limit: 25, offset: 25 })
        await user.click(screen.getByRole('button', { name: /Show 10 more/ }))
        await user.click(screen.getByRole('button', { name: /Show 4 more/ }))
        expect(names()).toHaveLength(40)
        expect(names().at(-1)).toBe('View 39')
        // The whole log is showing: nothing more to ask for, only the way back.
        expect(screen.queryByRole('button', { name: /more|older/ })).toBeNull()
        await user.click(screen.getByRole('button', { name: /Show less/ }))
        expect(names()).toHaveLength(6)
    })

    it('says nothing about more where the log is short', async () => {
        logOf(4)
        renderFeed(6)
        await waitFor(() => expect(names()).toHaveLength(4))
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('shows a page in the full feed, and fetches older ones on asking', async () => {
        logOf(30)
        renderFeed()
        await waitFor(() => expect(names()).toHaveLength(25))
        await userEvent.setup().click(screen.getByRole('button', { name: /Show older changes/ }))
        await waitFor(() => expect(names()).toHaveLength(30))
        expect(screen.queryByRole('button')).toBeNull()                // nothing folds in the full feed
    })
})
