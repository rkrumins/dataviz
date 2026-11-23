/**
 * The Overview's Recent changes: the latest few only — never the whole log growing with every change —
 * and how many more there are, one click from where they all are.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ViewActivityEntry } from '@/services/viewApiService'

const entries: ViewActivityEntry[] = Array.from({ length: 25 }, (_, i) => ({
    id: `act_${i}`, viewId: `v_${i}`, action: 'updated', actor: 'usr_ada', actorName: 'Ada Okafor', actorEmail: null,
    summary: null, changes: null, createdAt: new Date(Date.now() - i * 3_600_000).toISOString(), viewName: `View ${i}`,
    workspaceId: 'ws1',
} as ViewActivityEntry))

vi.mock('@/hooks/useViewActivity', () => ({
    useWorkspaceViewActivity: () => ({ data: entries, isLoading: false }),
}))

import { WorkspaceActivityFeed } from '../WorkspaceActivityFeed'

describe('the workspace’s recent changes', () => {
    it('shows only the latest few, and how many more there are', async () => {
        const onSeeAll = vi.fn()
        render(<MemoryRouter><WorkspaceActivityFeed workspaceId="ws1" limit={6} onSeeAll={onSeeAll} /></MemoryRouter>)
        expect(screen.getAllByText(/^View \d+$/)).toHaveLength(6)
        expect(screen.getByText('View 0')).toBeInTheDocument()
        expect(screen.queryByText('View 6')).toBeNull()
        await userEvent.click(screen.getByRole('button', { name: /See 19 more changes/ }))
        expect(onSeeAll).toHaveBeenCalledOnce()
    })

    it('shows them all, with no “more”, where it is the whole feed', () => {
        render(<MemoryRouter><WorkspaceActivityFeed workspaceId="ws1" /></MemoryRouter>)
        expect(screen.getAllByText(/^View \d+$/)).toHaveLength(25)
        expect(screen.queryByRole('button', { name: /more change/ })).toBeNull()
    })
})
