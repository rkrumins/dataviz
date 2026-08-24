/**
 * Counts by type — and the rule that a column earns its place by varying.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SeriesPayload } from '@/types/profiling'

const getSeries = vi.fn()
vi.mock('@/services/profilingService', () => ({
    profilingService: { getSeries: (...a: unknown[]) => getSeries(...a) },
}))

import { TypeLedger } from '../TypeLedger'

function payload(
    types: { key: string; values: number[] }[], buckets: string[],
): SeriesPayload {
    return {
        scope: 'source', id: 'ds_a', from: '', to: '', window: '30d',
        grain: 'day', requested_metric: 'total', breakdown: 'entity_type',
        buckets,
        series: types.map((t) => ({
            key: t.key, label: t.key, kind: 'type' as const,
            points: t.values.map((v, i) => ({ t: buckets[i], v })),
        })),
        totals: { nodes: [], edges: [], total: [] },
        platform_wide: true, truncated: false, vanished_types: [],
        coverage_from: null, sources_observed: 1,
    }
}

function renderIt() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <TypeLedger scope="source" id="ds_a" window="30d" />
        </QueryClientProvider>,
    )
}

describe('TypeLedger', () => {
    beforeEach(() => getSeries.mockReset())

    it('drops the columns that carry no information when nothing moved', async () => {
        // Start and Now hold the same number in every row, Change is a column
        // of dashes, Trend has too few points to draw — four columns carrying
        // one fact.
        getSeries.mockResolvedValue(payload([
            { key: 'schemaField', values: [55_365, 55_365] },
            { key: 'dataset', values: [6_060, 6_060] },
        ], ['2026-08-23', '2026-08-24']))
        renderIt()

        expect(await screen.findByText('schemaField')).toBeInTheDocument()
        expect(screen.queryByRole('columnheader', { name: /start/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('columnheader', { name: /change/i })).not.toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: /count/i })).toBeInTheDocument()
    })

    it('answers "what is in this" with share when it cannot answer "what changed"', async () => {
        getSeries.mockResolvedValue(payload([
            { key: 'schemaField', values: [750, 750] },
            { key: 'dataset', values: [250, 250] },
        ], ['2026-08-23', '2026-08-24']))
        renderIt()

        expect(await screen.findByRole('columnheader', { name: /share/i })).toBeInTheDocument()
        expect(screen.getByText('75%')).toBeInTheDocument()
        expect(screen.getByText('25%')).toBeInTheDocument()
    })

    it('restores the movement columns as soon as something moved', async () => {
        getSeries.mockResolvedValue(payload([
            { key: 'schemaField', values: [1_000, 1_400] },
        ], ['2026-08-23', '2026-08-24']))
        renderIt()

        expect(await screen.findByRole('columnheader', { name: /start/i })).toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: /change/i })).toBeInTheDocument()
        expect(screen.getByText('+400')).toBeInTheDocument()
    })

    it('says what the ordering means when nothing moved', async () => {
        getSeries.mockResolvedValue(payload([
            { key: 'a', values: [10, 10] },
        ], ['2026-08-23', '2026-08-24']))
        renderIt()

        expect(
            await screen.findByText(/this is what the source holds/i),
        ).toBeInTheDocument()
    })

    it('opens one type at full size on its own axis', async () => {
        getSeries.mockResolvedValue(payload([
            { key: 'schemaField', values: [1_000, 1_200, 1_400] },
        ], ['2026-08-22', '2026-08-23', '2026-08-24']))
        renderIt()

        await userEvent.click(await screen.findByText('schemaField'))
        // The heading and the chart's own accessible name both say it — the
        // assertion is that the focused view opened at all.
        expect(
            await screen.findByRole('heading', { name: /schemaField over time/i }),
        ).toBeInTheDocument()
        expect(screen.getByText(/its own axis/i)).toBeInTheDocument()
    })
})

describe('TypeLedger expansion', () => {
    beforeEach(() => getSeries.mockReset())

    it('keeps every column visible while a row is expanded', async () => {
        // The regression: an expansion `colSpan` that disagreed with the
        // header count made the browser reflow a phantom column, and Count
        // and Share dropped out of every row the moment one was opened.
        getSeries.mockResolvedValue(payload([
            { key: 'schemaField', values: [55_365, 55_365, 55_365] },
            { key: 'dataset', values: [6_060, 6_060, 6_060] },
        ], ['2026-08-22', '2026-08-23', '2026-08-24']))
        renderIt()

        await userEvent.click(await screen.findByText('schemaField'))

        expect(screen.getByRole('columnheader', { name: /count/i })).toBeInTheDocument()
        expect(screen.getByRole('columnheader', { name: /share/i })).toBeInTheDocument()
        // The row's own Count cell survives — that is the column that vanished.
        const row = screen.getByText('dataset').closest('tr')
        expect(within(row!).getByText('6,060')).toBeInTheDocument()
        expect(within(row!).getByText(/%$/)).toBeInTheDocument()
    })

    it('spans exactly the visible columns', async () => {
        getSeries.mockResolvedValue(payload([
            { key: 'a', values: [10, 10, 10] },
        ], ['2026-08-22', '2026-08-23', '2026-08-24']))
        renderIt()

        await userEvent.click(await screen.findByText('a'))
        const expansion = document.querySelector('td[colspan]')
        expect(expansion).not.toBeNull()
        // Scoped to the LEDGER's table: the expanded view carries a ChartTable
        // of its own, whose headers are not this table's columns.
        const ledgerTable = expansion!.closest('table')
        const headers = within(ledgerTable as HTMLElement)
            .getAllByRole('columnheader')
            .filter((h) => h.closest('table') === ledgerTable)
        expect(Number(expansion!.getAttribute('colspan'))).toBe(headers.length)
    })

    it('does not let the expanded chart set the table width', async () => {
        // The chart measures its container and falls back to 720px; inside an
        // auto-layout table that transient width becomes the cell width, the
        // observer then measures 720, and the table stays wider than the
        // drawer for good. A zero-width box breaks the loop.
        getSeries.mockResolvedValue(payload([
            { key: 'a', values: [10, 20, 30] },
        ], ['2026-08-22', '2026-08-23', '2026-08-24']))
        renderIt()

        await userEvent.click(await screen.findByText('a'))
        const expansion = document.querySelector('td[colspan] > div')
        expect(expansion).not.toBeNull()
        expect(expansion!.className).toContain('w-0')
        expect(expansion!.className).toContain('min-w-full')
    })
})
