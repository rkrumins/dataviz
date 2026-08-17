import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { automationChip, FreshnessRow } from './FreshnessRow'
import type { FreshnessRow as FreshnessRowData } from '@/services/freshnessService'

describe('automationChip', () => {
    it('says nothing about a healthy watched source', () => {
        // Absence is the signal — a chip on every row is what made the old
        // Last activity column unreadable.
        expect(automationChip({ driftState: 'inSync', autoReconcile: true })).toBeNull()
    })

    it('names a snooze', () => {
        expect(automationChip({
            driftState: 'drifting', pausedUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Paused')
    })

    it('prefers the breaker over a plain drift verdict', () => {
        expect(automationChip({ driftState: 'suspended' })?.label).toBe('Needs a person')
    })

    it('names a deliberate opt-out', () => {
        expect(automationChip({ driftState: 'inSync', autoReconcile: false })?.label)
            .toBe('Automation off')
    })

    it('names the cooldown holding a drifting source back', () => {
        expect(automationChip({
            driftState: 'drifting',
            cooldownUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Held by cooldown')
    })

    it('says nothing about a cooldown on a healthy source', () => {
        // A source that was just rebuilt is not a state worth interrupting
        // the scan for — the cooldown only explains something when there is
        // a finding it is holding back.
        expect(automationChip({
            driftState: 'inSync',
            cooldownUntil: '2999-01-01T00:00:00+00:00',
        })).toBeNull()
    })

    it('prefers a deliberate snooze over the throttle', () => {
        // Same ordering as the server's hold reasons: the deliberate one wins.
        expect(automationChip({
            driftState: 'drifting',
            pausedUntil: '2999-01-01T00:00:00+00:00',
            cooldownUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Paused')
    })

    it('prefers the opt-out over a snooze — Act stays off regardless of when the snooze lapses', () => {
        // Drifting + paused + opted-out all at once: "Paused" would wrongly
        // imply this source resumes on its own once the snooze expires.
        expect(automationChip({
            driftState: 'drifting', autoReconcile: false,
            pausedUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Automation off')
    })
})

// The unit tests above prove the decision logic; these prove it actually
// reaches the screen the way the row is expected to render it.
function renderRow(row: FreshnessRowData, extra: Record<string, unknown> = {}) {
    return render(
        <table><tbody>
            <FreshnessRow row={row} colSpan={7} onOpenDrawer={() => {}} onRefresh={() => {}} {...extra} />
        </tbody></table>,
        { wrapper: MemoryRouter },
    )
}

describe('FreshnessRow — quiet activity + automation chip', () => {
    it('renders a routine check as quiet text, never the old shouting pill', () => {
        renderRow({
            dataSourceId: 'ds-quiet', aggregationStatus: 'ready',
            lastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
        })
        expect(screen.queryByText(/reconcile check/i)).not.toBeInTheDocument()
        expect(screen.getByText(/checked/i)).toBeInTheDocument()
    })

    it('makes the suspended chip a clickable status filter', async () => {
        const user = userEvent.setup()
        const onFilterStatus = vi.fn()
        renderRow(
            { dataSourceId: 'ds-susp', aggregationStatus: 'ready', driftState: 'suspended' },
            { onFilterStatus },
        )
        await user.click(screen.getByRole('button', { name: /Needs a person/i }))
        expect(onFilterStatus).toHaveBeenCalledWith('suspended')
    })

    it('renders "Automation off" as a plain label, not a dead filter button', () => {
        renderRow(
            { dataSourceId: 'ds-off', aggregationStatus: 'ready', driftState: 'inSync', autoReconcile: false },
            { onFilterStatus: vi.fn() },
        )
        expect(screen.getByText('Automation off')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Automation off/i })).not.toBeInTheDocument()
    })
})
