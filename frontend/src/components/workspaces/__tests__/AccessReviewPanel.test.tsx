/**
 * An access review on the Members tab: started with a due date, each grant
 * kept or removed (removal confirmed, then the bindings refresh), the
 * people it can't cover counted, and completed only once all are decided.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reviews, notify } = vi.hoisted(() => ({
    reviews: { list: vi.fn(), get: vi.fn(), start: vi.fn(), decide: vi.fn(), complete: vi.fn(), cancel: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/accessReviewsService', () => ({ accessReviewsService: reviews }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/hooks/usePerson', () => ({ usePersonLookup: () => ({ data: null, isLoading: false }) }))

import { AccessReviewPanel } from '../AccessReviewPanel'
import type { AccessReview, AccessReviewItem } from '@/services/accessReviewsService'

function item(over: Partial<AccessReviewItem>): AccessReviewItem {
    return {
        id: 'rvi_x', subject: { type: 'user', id: 'usr_x', displayName: 'X', secondary: null },
        role: 'workspace_member', bindingId: 'bnd_x', origin: 'direct', grantedAt: '2026-01-01T00:00:00Z',
        expiresAt: null, lastLoginAt: null, current: true, decision: null, decidedBy: null, decidedAt: null, note: null,
        ...over,
    }
}

function review(items: AccessReviewItem[], over: Partial<AccessReview> = {}): AccessReview {
    const decided = (d: string) => items.filter(i => i.decision === d).length
    return {
        id: 'rev_1', workspaceId: 'ws_fin', status: 'open', startedBy: 'usr_wanda',
        startedAt: '2026-10-19T00:00:00Z', dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        completedAt: null, completedBy: null,
        counts: { total: items.length, kept: decided('keep'), removed: decided('remove'), undecided: items.filter(i => !i.decision).length },
        items, notReviewed: { identityProvider: 2, organizationWide: 1 },
        ...over,
    }
}

const MAX = item({ id: 'rvi_max', subject: { type: 'user', id: 'usr_max', displayName: 'Max', secondary: 'max@x.io' } })
const TEAM = item({ id: 'rvi_team', subject: { type: 'group', id: 'grp_a', displayName: 'Auditors', secondary: '4 members' }, role: 'workspace_viewer', origin: 'team' })

function renderPanel(onChanged = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <AccessReviewPanel workspaceId="ws_fin" onChanged={onChanged} />
        </QueryClientProvider>,
    )
    return { onChanged }
}

beforeEach(() => vi.clearAllMocks())

describe('AccessReviewPanel', () => {
    it('starts a review due when chosen, and lists the earlier ones', async () => {
        const user = userEvent.setup()
        reviews.list.mockResolvedValue([
            review([], { id: 'rev_0', status: 'completed', completedAt: '2026-07-01T00:00:00Z', counts: { total: 9, kept: 7, removed: 2, undecided: 0 } }),
        ])
        reviews.start.mockResolvedValue(review([MAX]))
        renderPanel()

        expect(await screen.findByText(/7 kept, 2 removed/)).toBeInTheDocument()
        await user.click(screen.getByRole('radio', { name: '30 days' }))
        await user.click(screen.getByRole('button', { name: /Start a review/ }))
        await waitFor(() => expect(reviews.start).toHaveBeenCalledWith('ws_fin', 30))
    })

    it('keeps and removes grants, and completes once every one is decided', async () => {
        const user = userEvent.setup()
        reviews.list.mockResolvedValue([review([MAX, TEAM])])
        reviews.get.mockResolvedValue(review([MAX, TEAM]))
        const { onChanged } = renderPanel()

        expect(await screen.findByText('2 of 2 still to decide')).toBeInTheDocument()
        expect(screen.getByText(/2 through your identity provider and 1 with an organization-wide role/)).toBeInTheDocument()
        const complete = screen.getByRole('button', { name: /Complete review/ })
        expect(complete).toBeDisabled()

        reviews.decide.mockResolvedValueOnce(review([{ ...MAX, decision: 'keep' }, TEAM]))
        await user.click(screen.getByRole('button', { name: 'Keep Max’s Member access' }))
        await waitFor(() => expect(reviews.decide).toHaveBeenCalledWith('ws_fin', 'rev_1', 'rvi_max', { decision: 'keep' }))

        const team = screen.getByText('Auditors').closest('li') as HTMLElement
        await user.click(within(team).getByRole('button', { name: 'Remove Auditors’s Viewer access' }))
        expect(within(team).getByText(/Remove now\? Its members lose it./)).toBeInTheDocument()
        reviews.decide.mockResolvedValueOnce(review([{ ...MAX, decision: 'keep' }, { ...TEAM, decision: 'remove', current: false }]))
        await user.click(within(team).getByRole('button', { name: 'Remove' }))
        await waitFor(() => expect(reviews.decide).toHaveBeenLastCalledWith('ws_fin', 'rev_1', 'rvi_team', { decision: 'remove' }))
        expect(onChanged).toHaveBeenCalled()

        expect(await screen.findByText('Nothing left to decide — complete the review.')).toBeInTheDocument()
        reviews.complete.mockResolvedValue(review([], { status: 'completed' }))
        await user.click(screen.getByRole('button', { name: /Complete review/ }))
        await waitFor(() => expect(reviews.complete).toHaveBeenCalledWith('ws_fin', 'rev_1'))
        expect(notify).toHaveBeenCalledWith('success', 'Access review completed.')
    })
})
