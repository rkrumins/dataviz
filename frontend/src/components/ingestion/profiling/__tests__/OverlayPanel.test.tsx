/**
 * The seam between "what happened" and "what do I press".
 *
 * Profiling owns the overlay's HISTORY — the Aggregated series is the only
 * place a drop and its recovery are both visible. The Freshness cockpit owns
 * the verdict and the verbs. This panel joins them, and the things worth
 * pinning are the ones that would mislead: a dedicated projection reading as
 * a wipe, a permission gap reading as an error, and the case where the answer
 * is emphatically NOT a rebuild.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSourceDoc = vi.fn()
vi.mock('@/services/freshnessService', () => ({
    freshnessService: { getSourceDoc: (...a: unknown[]) => getSourceDoc(...a) },
    FRESHNESS_KEYS: {
        doc: (id: string, probe: boolean) => ['freshness', 'doc', id, probe],
    },
}))

import { OverlayPanel } from '../OverlayPanel'

const doc = (over: Record<string, unknown> = {}) => ({
    dataSourceId: 'ds_a',
    driftState: 'inSync',
    observedAggregatedEdges: 2_000_000,
    expectedAggregatedEdges: 2_000_000,
    statsAsOf: '2026-09-14T06:00:00Z',
    lastFindingReason: null,
    ...over,
})

function renderIt() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <OverlayPanel dataSourceId="ds_a" />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('OverlayPanel', () => {
    beforeEach(() => getSourceDoc.mockReset())

    it('names the overlay as ours, not as the customer relationships', async () => {
        getSourceDoc.mockResolvedValue(doc())
        renderIt()
        expect(await screen.findByText('Aggregated lineage')).toBeInTheDocument()
        expect(
            screen.getByText(/not\s+relationships anyone ingested/i),
        ).toBeInTheDocument()
    })

    it('offers the rebuild where the rollups are the thing at fault', async () => {
        getSourceDoc.mockResolvedValue(doc({
            driftState: 'overlayMissing',
            observedAggregatedEdges: 0,
            lastFindingReason: 'overlay_missing',
        }))
        renderIt()
        const cta = await screen.findByRole('link', { name: /rebuild the rollups/i })
        // Straight to the cockpit's drawer for THIS source, where the verbs
        // and their permission checks already live.
        expect(cta).toHaveAttribute('href', '/ingestion?tab=freshness&fds=ds_a')
        expect(screen.getByText('Rollups were missing')).toBeInTheDocument()
    })

    it('does not urge a rebuild when the RAW data is what moved', async () => {
        // `drifting` means the source changed underneath us. A rebuild
        // follows that; it does not fix it, and painting the panel red would
        // send someone to press a button for the wrong reason.
        getSourceDoc.mockResolvedValue(doc({ driftState: 'drifting' }))
        renderIt()
        expect(
            await screen.findByRole('link', { name: /check or rebuild the rollups/i }),
        ).toBeInTheDocument()
    })

    it('says a dedicated projection is invisible rather than missing', async () => {
        // THE trap. A dedicated projection writes its rollups into a graph no
        // collection lane profiles, so the Aggregated series is structurally
        // zero forever. Reading that as a wipe would send operators to rebuild
        // an overlay that is fine.
        getSourceDoc.mockResolvedValue(doc({
            driftState: 'unobservable',
            observedAggregatedEdges: 0,
            expectedAggregatedEdges: 4_000,
        }))
        renderIt()
        expect(
            await screen.findByText(/projects its rollups into a separate graph/i),
        ).toBeInTheDocument()
        // The neutral CTA, never the at-fault one: the cockpit can still
        // rebuild this source, but nothing here says anything is wrong.
        expect(
            screen.getByRole('link', { name: /check or rebuild the rollups/i }),
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('link', { name: /^rebuild the rollups/i }),
        ).not.toBeInTheDocument()
    })

    it('is absent rather than broken when the cockpit has nothing to say', async () => {
        // Profiling and the cockpit are gated separately, and the cockpit's
        // doc can also simply not be there yet. Either way someone who came
        // for the history gets the history — never a red box about a panel
        // they did not ask for. Same `return null` guard covers the error
        // branch beside it.
        getSourceDoc.mockResolvedValue(undefined)
        const { container } = renderIt()
        await waitFor(() => expect(getSourceDoc).toHaveBeenCalled())
        expect(container.querySelector('section')).toBeNull()
    })
})
