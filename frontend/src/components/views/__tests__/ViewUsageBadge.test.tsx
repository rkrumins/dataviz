/**
 * The badge's three states, and the one that matters most.
 *
 * "Nobody has opened this" is the single most useful thing a view's author can
 * learn, and it is exactly the state a naive counter renders as "0" — which
 * reads as a broken widget rather than as a finding.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

    it('reports opens and the people behind them', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 1840, uniqueViewers: 214,
                lastOpenedAt: '2026-06-15T09:00:00+00:00',
                trend: [3, 9, 4, 12, 7], windowDays: 30,
            },
        })
        renderBadge()
        expect(await screen.findByText('1.8k')).toBeInTheDocument()
        expect(screen.getByText('214')).toBeInTheDocument()
    })

    it('calls out a view nobody opens rather than showing a zero', async () => {
        vi.mocked(service.getViewUsage).mockResolvedValue({
            v1: {
                viewId: 'v1', opens: 0, uniqueViewers: 0, lastOpenedAt: null,
                trend: [0, 0, 0], windowDays: 30,
            },
        })
        renderBadge()
        expect(await screen.findByText(/not opened recently/i)).toBeInTheDocument()
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
