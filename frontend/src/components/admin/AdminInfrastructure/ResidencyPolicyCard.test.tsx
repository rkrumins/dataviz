/**
 * The "Residency & eviction" card on Admin → Infrastructure → Versioned graphs (doc 17): every
 * residency value with the one in force, its default and its unit, Reset to default (which saves
 * ``-1``), each master's memory drawn with the start and stop marks, who changed the values last,
 * and Save behind a confirmation that says what the next capacity pass would do with them. A value
 * the server refuses (422) is shown next to the field it names.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { residencyPolicy, saveResidencyPolicy, previewResidencyPolicy } = vi.hoisted(() => ({
    residencyPolicy: vi.fn(),
    saveResidencyPolicy: vi.fn(),
    previewResidencyPolicy: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return {
        ...actual,
        systemStatusService: { ...actual.systemStatusService, residencyPolicy, saveResidencyPolicy, previewResidencyPolicy },
    }
})

import { ResidencyPolicyCard } from './ResidencyPolicyCard'
import type { ResidencyPolicy, ResidencyPreview } from '@/services/systemStatusService'

const GB = 1024 ** 3

function value<T>(def: T, saved: T | null = null) {
    return { saved, default: def, effective: saved ?? def }
}

function policy(over: Partial<ResidencyPolicy['values']> = {}, rest: Partial<ResidencyPolicy> = {}): ResidencyPolicy {
    return {
        enabled: true,
        values: {
            evictionEnabled: value(true),
            defaultResidency: value('standard' as const),
            standardIdleSecs: value(604800),
            coldlineIdleSecs: value(3600),
            highWaterPct: value(80, 75),
            lowWaterPct: value(70),
            loadMarginPct: value(130),
            bytesPerEntity: value(550),
            coldlineCanvasLoadAbove: value(500000),
            capacityIntervalSecs: value(60),
            ...over,
        },
        ranges: { highWaterPct: { min: 50, max: 95 }, lowWaterPct: { min: 30, max: 90 } },
        updatedBy: 'usr_ops', updatedAt: '2026-10-30T10:00:00Z',
        ...rest,
    }
}

function preview(over: Partial<ResidencyPreview> = {}): ResidencyPreview {
    return {
        values: {} as ResidencyPreview['values'],
        masters: [
            { endpoint: '10.0.0.1:6379', usedBytes: 4 * GB, maxBytes: 8 * GB, reservedBytes: 0, usedAfterBytes: 4 * GB,
              hold: null, evictions: [], loads: [], waits: [] },
            { endpoint: '10.0.0.2:6379', usedBytes: 7 * GB, maxBytes: 8 * GB, reservedBytes: 0, usedAfterBytes: 5.5 * GB,
              hold: null, loads: [], waits: [],
              evictions: [
                  { graphId: 'g1', dataSourceId: 'ds1', label: 'Orders', bytes: 1 * GB, reason: 'pressure' },
                  { graphId: 'g2', dataSourceId: 'ds2', label: 'Lake', bytes: 0.5 * GB, reason: 'idle_standard' },
              ] },
        ],
        evictions: 2, evictedBytes: 1.5 * GB, loads: 0,
        ...over,
    }
}

function renderCard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><ResidencyPolicyCard /></QueryClientProvider>)
}

const field = (name: string) => screen.getByRole('group', { name })

beforeEach(() => {
    residencyPolicy.mockReset().mockResolvedValue(policy())
    saveResidencyPolicy.mockReset()
    previewResidencyPolicy.mockReset().mockResolvedValue(preview({ evictions: 0, evictedBytes: 0, masters: preview().masters.map(m => ({ ...m, evictions: [] })) }))
})

describe('ResidencyPolicyCard', () => {
    it('shows every value in force, with its default and its unit, and who changed them last', async () => {
        renderCard()
        await screen.findByRole('group', { name: 'Start mark' })

        expect(field('Unload unread Standard graphs after')).toHaveTextContent('Default: 7 days')
        expect(field('Unload unread Coldline graphs after')).toHaveTextContent('Default: 1 hour')
        expect(within(field('Start mark')).getByRole('spinbutton')).toHaveValue(75)
        expect(field('Start mark')).toHaveTextContent('%')
        expect(field('Start mark')).toHaveTextContent('Default: 80 %')
        expect(field('Stop mark')).toHaveTextContent('Default: 70 %')
        expect(field('Load headroom')).toHaveTextContent('Default: ×1.3')
        expect(field('Size of an entity never measured')).toHaveTextContent('Default: 550 bytes')
        expect(field('Coldline: load on a canvas read above')).toHaveTextContent('Default: 500,000 entities')
        expect(field('Capacity pass every')).toHaveTextContent('Default: 60 seconds')
        expect(field('Automatic eviction')).toHaveTextContent('Default: On')
        expect(field('Class of a new graph')).toHaveTextContent('Default: Standard')
        expect(screen.getByText(/Last changed by usr_ops/)).toBeInTheDocument()
    })

    it('says when residency is off on this deployment', async () => {
        residencyPolicy.mockResolvedValue(policy({}, { enabled: false }))
        renderCard()
        expect(await screen.findByText(/Residency is off on this deployment/)).toBeInTheDocument()
    })

    it("draws each master's memory with the start and stop marks on it", async () => {
        renderCard()
        const gauge = await screen.findByRole('meter', { name: 'Memory of 10.0.0.2:6379' })
        expect(gauge).toHaveAttribute('aria-valuenow', '88')
        expect(within(gauge).getByTitle('Start mark 75 %')).toBeInTheDocument()
        expect(within(gauge).getByTitle('Stop mark 70 %')).toBeInTheDocument()
        expect(screen.getByRole('meter', { name: 'Memory of 10.0.0.1:6379' })).toHaveAttribute('aria-valuenow', '50')
        expect(previewResidencyPolicy).toHaveBeenCalledWith({})
    })

    it('saves behind a confirmation that says what the next pass would do', async () => {
        renderCard()
        const start = within(await screen.findByRole('group', { name: 'Start mark' })).getByRole('spinbutton')
        await userEvent.clear(start)
        await userEvent.type(start, '60')
        previewResidencyPolicy.mockResolvedValueOnce(preview())
        saveResidencyPolicy.mockResolvedValue(policy({ highWaterPct: value(80, 60) }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        const dialog = await screen.findByRole('dialog')
        expect(previewResidencyPolicy).toHaveBeenLastCalledWith({ highWaterPct: 60 })
        expect(dialog).toHaveTextContent('Saving evicts 2 graphs, 1.5 GB, on master 10.0.0.2:6379')
        expect(saveResidencyPolicy).not.toHaveBeenCalled()
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(saveResidencyPolicy).toHaveBeenCalledWith({ highWaterPct: 60 })
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('converts a duration when its unit changes, and an untouched one stays unedited', async () => {
        // Review finding 8: switching the unit kept the number, so 7 days became 7 hours, edited.
        renderCard()
        const standard = await screen.findByRole('group', { name: 'Unload unread Standard graphs after' })
        await userEvent.selectOptions(within(standard).getByRole('combobox'), 'hours')
        expect(within(standard).getByRole('spinbutton')).toHaveValue(168)
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
        // An edit is converted too: 2 days in hours is 48.
        await userEvent.selectOptions(within(standard).getByRole('combobox'), 'days')
        const days = within(standard).getByRole('spinbutton')
        await userEvent.clear(days)
        await userEvent.type(days, '2')
        await userEvent.selectOptions(within(standard).getByRole('combobox'), 'hours')
        expect(within(standard).getByRole('spinbutton')).toHaveValue(48)
    })

    it('says a size is unknown rather than 0 bytes, and when the new values take effect', async () => {
        renderCard()
        const start = within(await screen.findByRole('group', { name: 'Start mark' })).getByRole('spinbutton')
        await userEvent.clear(start)
        await userEvent.type(start, '60')
        const unsized = preview().masters.map(m => ({
            ...m, evictions: m.evictions.map((e, i) => (i === 0 ? e : { ...e, bytes: null })) }))
        previewResidencyPolicy.mockResolvedValueOnce(preview({
            masters: unsized, values: { capacityIntervalSecs: 300 } as ResidencyPreview['values'] }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('Saving evicts 2 graphs, 1 GB and 1 of unknown size, on master 10.0.0.2:6379')
        expect(dialog).toHaveTextContent('within 30 seconds')
        expect(dialog).toHaveTextContent('every 5 minutes')
        expect(dialog).not.toHaveTextContent('within a minute')
    })

    it('resets a value to its default by saving -1', async () => {
        renderCard()
        await userEvent.click(within(await screen.findByRole('group', { name: 'Start mark' })).getByRole('button', { name: 'Reset to default' }))
        expect(within(field('Start mark')).getByRole('spinbutton')).toHaveValue(80)
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('Saving evicts nothing now')
        saveResidencyPolicy.mockResolvedValue(policy({ highWaterPct: value(80) }))
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(saveResidencyPolicy).toHaveBeenCalledWith({ highWaterPct: -1 })
    })

    it('shows a refused value next to the field it names', async () => {
        renderCard()
        const stop = within(await screen.findByRole('group', { name: 'Stop mark' })).getByRole('spinbutton')
        await userEvent.clear(stop)
        await userEvent.type(stop, '74')
        previewResidencyPolicy.mockRejectedValueOnce(Object.assign(new Error('422'), {
            status: 422,
            detail: { type: 'invalid_residency_policy', field: 'lowWaterPct',
                message: 'the stop mark (74%) must be at least 5 points under the start mark (75%)' },
        }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(await within(field('Stop mark')).findByText('the stop mark (74%) must be at least 5 points under the start mark (75%)')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(saveResidencyPolicy).not.toHaveBeenCalled()
    })
})
