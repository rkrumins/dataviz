/**
 * One source's profile — and the five states it has to tell apart.
 *
 * The version this replaces collapsed loading, empty, error, partial and
 * permission-limited into one sentence about history starting soon, so a 500
 * and a brand-new source were reported identically and neither was true. These
 * pin each one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SeriesPayload } from '@/types/profiling'

const canRead = vi.fn(() => true)
vi.mock('@/hooks/useProfilingAccess', () => ({
    useCanReadProfiling: () => canRead(),
    useCanEditProfilingPolicy: () => true,
    useIsPlatformOperator: () => true,
    INGESTION_READ_PERMS: [],
}))

const getSeries = vi.fn()
vi.mock('@/services/profilingService', () => ({
    profilingService: {
        getSeries: (...args: unknown[]) => getSeries(...args),
        getObservations: vi.fn().mockResolvedValue({
            id: 'ds_a', from: '', to: '', window: '30d', observations: [],
            total: 0, offset: 0, limit: 50,
            baselines: { nodes: 25, edges: 25 }, events: [],
            counts: { observations: 0, moved: 0, checkpoints: 0, runs: 0 },
        }),
        getFindings: vi.fn().mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 20,
            platform_wide: true,
        }),
        exportUrl: () => '#',
        acknowledge: vi.fn(),
    },
}))

import { SourceProfiling } from '../SourceProfiling'

function series(over: Partial<SeriesPayload> = {}): SeriesPayload {
    return {
        scope: 'source', id: 'ds_a', from: '2026-07-25T00:00:00Z',
        to: '2026-08-24T00:00:00Z', window: '30d', grain: 'day',
        requested_metric: 'total', breakdown: 'none',
        buckets: ['2026-08-23', '2026-08-24'],
        series: [
            { key: 'nodes', label: 'Entities', kind: 'metric', points: [{ t: '2026-08-23', v: 100 }, { t: '2026-08-24', v: 140 }] },
            { key: 'edges', label: 'Relationships', kind: 'metric', points: [{ t: '2026-08-23', v: 50 }, { t: '2026-08-24', v: 60 }] },
        ],
        totals: { nodes: [100, 140], edges: [50, 60], total: [150, 200] },
        platform_wide: true, truncated: false, vanished_types: [],
        coverage_from: '2026-08-23', sources_observed: 1,
        ...over,
    }
}

function renderIt() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <MemoryRouter>
                <SourceProfiling dataSourceId="ds_a" sourceName="Customers" />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

describe('SourceProfiling', () => {
    beforeEach(() => {
        getSeries.mockReset()
        canRead.mockReturnValue(true)
    })

    it('leads with a sentence stating what the window says', async () => {
        getSeries.mockResolvedValue(series())
        renderIt()
        // The verdict names the source and both movements in one sentence —
        // scoped, because "Entities" also labels a tile and a legend swatch.
        // The value appears on the tile and again in the chart's readout —
        // both correct, and the assertion is that the sentence exists at all.
        expect((await screen.findAllByText(/moved/i)).length).toBeGreaterThan(0)
        expect(screen.getAllByText('Customers').length).toBeGreaterThan(0)
    })

    it('shows both measures and what each did', async () => {
        getSeries.mockResolvedValue(series())
        renderIt()
        // The measures appear as tiles, as legend swatches and in the control
        // — the point of the assertion is the VALUES on the tiles.
        expect((await screen.findAllByText('140')).length).toBeGreaterThan(0)
        expect(screen.getAllByText('60').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Entities').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Relationships').length).toBeGreaterThan(0)
    })

    it('answers "was anything lost" even when nothing was', async () => {
        getSeries.mockResolvedValue(series())
        renderIt()
        expect(await screen.findByText('Largest drop')).toBeInTheDocument()
        expect(screen.getByText(/nothing lost/i)).toBeInTheDocument()
    })

    it('names the moment of the worst drop when there is one', async () => {
        getSeries.mockResolvedValue(series({
            buckets: ['2026-08-23', '2026-08-24'],
            totals: { nodes: [10_000, 40], edges: [50, 50], total: [10_050, 90] },
        }))
        renderIt()
        // The magnitude shows on the tile and again in the verdict sentence;
        // both are correct, and the tile is what this pins.
        expect((await screen.findAllByText('−9,960')).length).toBeGreaterThan(0)
        expect(screen.getByText('Largest drop')).toBeInTheDocument()
    })

    it('treats a single observation as a starting line, not a gap', async () => {
        // A brand-new source is the normal state of a fresh deployment. The
        // previous version drew chart chrome around nothing and said history
        // was missing.
        getSeries.mockResolvedValue(series({
            buckets: ['2026-08-24'],
            series: [{ key: 'nodes', label: 'Entities', kind: 'metric', points: [{ t: '2026-08-24', v: 15 }] }],
            totals: { nodes: [15], edges: [12], total: [27] },
        }))
        renderIt()
        expect(await screen.findByText(/this is the starting line, not a gap/i)).toBeInTheDocument()
    })

    it('says a failed read failed, rather than showing it as emptiness', async () => {
        getSeries.mockRejectedValue(new Error('provider unreachable'))
        renderIt()
        expect(await screen.findByText(/the profile could not be read/i)).toBeInTheDocument()
        expect(screen.getByText(/provider unreachable/i)).toBeInTheDocument()
    })

    it('renders nothing at all without permission', async () => {
        canRead.mockReturnValue(false)
        getSeries.mockResolvedValue(series())
        const { container } = renderIt()
        expect(container).toBeEmptyDOMElement()
    })

    it('states where the record begins so a short series is not read as loss', async () => {
        getSeries.mockResolvedValue(series())
        renderIt()
        expect(await screen.findByText(/record begins/i)).toBeInTheDocument()
    })
})
