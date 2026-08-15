import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { OvernightLedger } from './OvernightLedger'
import { groupLedgerBySweep } from './reconcileHealth'
import type { ReconcileActivityItem } from '@/services/freshnessService'

const item = (over: Partial<ReconcileActivityItem>): ReconcileActivityItem => ({
    runId: 'rcn_a',
    runStartedAt: '2026-08-15T02:14:00Z',
    ts: '2026-08-15T02:14:00Z',
    dataSourceId: 'ds-1',
    name: 'Sol Xlarge',
    reason: 'overlay_missing',
    mode: 'auto',
    outcome: 'rebuilt',
    jobId: 'agg_1',
    evidence: {},
    ...over,
})

describe('groupLedgerBySweep', () => {
    it('keeps run order and groups findings under each sweep', () => {
        const items = [
            item({ runId: 'rcn_new', dataSourceId: 'a' }),
            item({ runId: 'rcn_new', dataSourceId: 'b', name: 'Payments', outcome: 'held', skip: 'cap', jobId: null }),
            item({ runId: 'rcn_old', dataSourceId: 'c', name: 'Older' }),
        ]
        const groups = groupLedgerBySweep(items)
        expect(groups.map(g => g.runId)).toEqual(['rcn_new', 'rcn_old'])
        expect(groups[0].items.map(i => i.dataSourceId)).toEqual(['a', 'b'])
        expect(groups[1].items).toHaveLength(1)
    })
})

describe('OvernightLedger', () => {
    it('groups by sweep and links a rebuilt finding to its job', async () => {
        const user = userEvent.setup()
        const onOpen = vi.fn()
        render(
            <MemoryRouter>
                <OvernightLedger
                    items={[
                        item({}),
                        item({
                            dataSourceId: 'ds-2', name: 'Payments',
                            reason: 'raw_drift', outcome: 'held', skip: 'cap', jobId: null,
                        }),
                    ]}
                    isError={false}
                    isLoading={false}
                    onOpenSource={onOpen}
                />
            </MemoryRouter>,
        )
        expect(screen.getByText('Sol Xlarge')).toBeInTheDocument()
        expect(screen.getByText('Payments')).toBeInTheDocument()
        expect(screen.getByText('Held (Cap)')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /job/i })).toHaveAttribute(
            'href', expect.stringContaining('search=agg_1'),
        )
        await user.click(screen.getByText('Sol Xlarge'))
        expect(onOpen).toHaveBeenCalledWith('ds-1')
    })

    it('uses the horizon empty copy', () => {
        render(
            <MemoryRouter>
                <OvernightLedger
                    items={[]}
                    isError={false}
                    isLoading={false}
                    onOpenSource={() => {}}
                    emptyLabel="No drift findings in the last 3 hours."
                />
            </MemoryRouter>,
        )
        expect(screen.getByText('No drift findings in the last 3 hours.')).toBeInTheDocument()
    })

    it('falls back to the reconcile trigger filter when a rebuild has no job id', () => {
        render(
            <MemoryRouter>
                <OvernightLedger
                    items={[item({ jobId: null })]}
                    isError={false}
                    isLoading={false}
                    onOpenSource={() => {}}
                />
            </MemoryRouter>,
        )
        expect(screen.getByRole('link', { name: /job/i })).toHaveAttribute(
            'href', expect.stringContaining('triggerSource=reconcile'),
        )
    })
})
