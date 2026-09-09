/**
 * The fleet Defaults dialog: seeds from the stored row over the live env
 * defaults, labels every value by where it came from, clears with an
 * explicit null (the server merges), guards a dirty close, and shows the
 * capacity what-if moving as the reserve is edited.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAggregationSettings, putAggregationSettings, getFleetCapacity, permissionFn, notify } = vi.hoisted(() => ({
    getAggregationSettings: vi.fn(),
    putAggregationSettings: vi.fn(),
    getFleetCapacity: vi.fn(),
    permissionFn: vi.fn(),
    notify: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => permissionFn(perm),
}))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getAggregationSettings, putAggregationSettings, getFleetCapacity },
    }
})

import { DefaultsDialog } from './DefaultsDialog'

const GB = 2 ** 30

const SETTINGS = {
    tuning: { shardReservePct: 10, scanRangeWidth: 300_000, maxCubeEdges: 2_000_000 },
    envMaterializeFinePairs: 'true',
    envTuningDefaults: {
        scanRangeWidth: 200_000, maxPendingPairs: 50_000_000, applyChunk: 20_000, deleteChunk: 10_000,
        writePacingRatio: 1, extractConcurrency: 1, materializeLeafPairs: false, materializeFinePairs: 'true',
        maxMaterializedEdges: 25_000_000, shardReservePct: 20, bytesPerEdge: 512,
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, budgetRecheckEdges: 1_000_000,
    },
}

const CAPACITY = {
    limits: {
        shardReservePct: { value: 10, source: 'global' }, bytesPerEdge: { value: 512, source: 'default' },
        maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
    },
    shards: [{
        endpoint: '10.0.0.1:6379', used: 10 * GB, maxmemory: 40 * GB, policy: 'noeviction', measurable: true,
        usedPct: 25, reservePct: 10, reserveBytes: 4 * GB, availableBytes: 26 * GB, allowedGrowthEdges: Math.floor(26 * GB / 512),
        governedBy: 'shard', staticCap: 25_000_000, sources: [],
    }],
    unresolved: [], sourcesTotal: 1, truncated: false, measuredAt: '2026-09-08T10:00:00Z', cacheAgeMs: 0,
}

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
    getAggregationSettings.mockResolvedValue(SETTINGS)
    getFleetCapacity.mockResolvedValue(CAPACITY)
    putAggregationSettings.mockImplementation(async (tuning: unknown) => ({ ...SETTINGS, tuning }))
})

describe('DefaultsDialog', () => {
    it('seeds from the stored row and labels each value by where it came from', async () => {
        wrap(<DefaultsDialog open onClose={() => {}} />)

        const reserve = await screen.findByLabelText(/^Shard memory reserve/) as HTMLInputElement
        expect(reserve.value).toBe('10')
        expect(screen.getByText('Set here: 10 (environment default 20)')).toBeInTheDocument()
        // An unset knob shows the live env default, not a bundled guess.
        const bpe = screen.getByLabelText(/^Bytes per rollup edge/) as HTMLInputElement
        expect(bpe.value).toBe('')
        expect(bpe.placeholder).toBe('512')
        expect(screen.getByText('Environment default: 512')).toBeInTheDocument()
        // Auto's cube ceiling and the estimate margin are fleet knobs now: editable, labelled by source.
        const cube = screen.getByLabelText(/^Auto’s cube ceiling/) as HTMLInputElement
        expect(cube.value).toBe('2000000')
        expect(screen.getByText('Set here: 2,000,000 (environment default 8,000,000)')).toBeInTheDocument()
        const margin = screen.getByLabelText(/^Estimate margin/) as HTMLInputElement
        expect(margin.value).toBe('')
        expect(margin.placeholder).toBe('25')
        // Only the recheck interval is still the deployment's.
        expect(screen.getByText(/re-measured every 1\.0M edges/)).toBeInTheDocument()
        expect(screen.queryByText(/cube ceiling 8\.0M edges/)).not.toBeInTheDocument()
    })

    it('Reset on Auto’s cube ceiling sends an explicit null like any other knob', async () => {
        wrap(<DefaultsDialog open onClose={() => {}} />)
        await screen.findByLabelText(/^Auto’s cube ceiling/)

        await userEvent.click(screen.getByRole('button', { name: 'Reset Auto’s cube ceiling to the environment default' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }))

        await waitFor(() => expect(putAggregationSettings).toHaveBeenCalledTimes(1))
        expect(putAggregationSettings.mock.calls[0][0].maxCubeEdges).toBeNull()
    })

    it('Reset sends an explicit null so the server clears the stored key', async () => {
        wrap(<DefaultsDialog open onClose={() => {}} />)
        await screen.findByLabelText(/^Shard memory reserve/)

        await userEvent.click(screen.getByRole('button', { name: 'Reset Shard memory reserve to the environment default' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save defaults' }))

        await waitFor(() => expect(putAggregationSettings).toHaveBeenCalledTimes(1))
        const sent = putAggregationSettings.mock.calls[0][0]
        expect(sent.shardReservePct).toBeNull()
        expect(sent.scanRangeWidth).toBe(300_000)        // untouched keys travel as stored
        expect(notify).toHaveBeenCalledWith('success', expect.stringMatching(/Defaults saved/))
    })

    it('moves the what-if as the reserve is edited, before anything is saved', async () => {
        wrap(<DefaultsDialog open onClose={() => {}} />)
        const reserve = await screen.findByLabelText(/^Shard memory reserve/)
        const whatIf = await screen.findByTestId('defaults-what-if')
        // At the stored 10%: 40 − 4 − 10 = 26 GB free.
        expect(whatIf).toHaveTextContent('26.0 GB free after a 10% reserve')

        await userEvent.clear(reserve)
        await userEvent.type(reserve, '50')
        // At 50%: 40 − 20 − 10 = 10 GB free — and nothing was saved.
        await waitFor(() => expect(screen.getByTestId('defaults-what-if')).toHaveTextContent('10.0 GB free after a 50% reserve'))
        expect(putAggregationSettings).not.toHaveBeenCalled()
    })

    it('guards a dirty close and closes cleanly when nothing changed', async () => {
        const onClose = vi.fn()
        wrap(<DefaultsDialog open onClose={onClose} />)
        const reserve = await screen.findByLabelText(/^Shard memory reserve/)

        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalledTimes(1)

        await userEvent.clear(reserve)
        await userEvent.type(reserve, '30')
        await userEvent.click(screen.getByRole('button', { name: 'Close aggregation defaults' }))
        expect(await screen.findByText('Discard these default changes?')).toBeInTheDocument()
        expect(onClose).toHaveBeenCalledTimes(1)
        await userEvent.click(screen.getByRole('button', { name: /Discard/ }))
        expect(onClose).toHaveBeenCalledTimes(2)
    })

    it('is read-only without system:admin', async () => {
        permissionFn.mockReturnValue(false)
        wrap(<DefaultsDialog open onClose={() => {}} />)
        expect(await screen.findByLabelText(/^Shard memory reserve/)).toBeDisabled()
        expect(screen.getByText('Only platform admins can change these settings.')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Save defaults' })).not.toBeInTheDocument()
    })
})
