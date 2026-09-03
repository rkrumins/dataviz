import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { automationChip, FreshnessRow } from './FreshnessRow'
import { holdLabel, overrideWarning, rowHold } from './holds'
import type { FreshnessRow as FreshnessRowData } from '@/services/freshnessService'

describe('automationChip', () => {
    it('says nothing about a healthy watched source', () => {
        // Absence is the signal — a chip on every row is what made the old
        // Last activity column unreadable.
        expect(automationChip({ driftState: 'inSync', autoReconcile: true })).toBeNull()
    })

    it('names a snooze, with how long is left', () => {
        const chip = automationChip({
            driftState: 'drifting', pausedUntil: new Date(Date.now() + 3 * 3600_000).toISOString(),
        })
        expect(chip?.label).toBe('Paused · 3h')
        expect(chip?.facet).toBe('held')
    })

    it('shows a pause on a source that is currently fine — that is the one an operator forgets', () => {
        // The old chip needed a live drift verdict before it would admit a
        // pause existed, so a paused-but-healthy row looked like automation
        // working normally. It is the pause, not the drift, that was set.
        expect(automationChip({
            driftState: 'inSync', pausedUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toMatch(/^Paused/)
    })

    it('prefers the breaker over a plain drift verdict', () => {
        expect(automationChip({ driftState: 'suspended' })?.label).toBe('Needs a person')
    })

    it('prefers the breaker over a hold — a person is needed regardless', () => {
        expect(automationChip({
            driftState: 'suspended', heldBy: 'fleet', heldKind: 'stopped',
        })?.label).toBe('Needs a person')
    })

    it('names a deliberate opt-out as a stop — the same word the wider scopes use', () => {
        expect(automationChip({ driftState: 'inSync', autoReconcile: false })?.label)
            .toBe('Stopped')
    })

    it('names the scope that is holding the row, because that is where it is released', () => {
        expect(automationChip({
            driftState: 'drifting', heldBy: 'provider', heldKind: 'stopped',
        })?.label).toBe('Stopped by provider')
        expect(automationChip({
            driftState: 'inSync', heldBy: 'fleet', heldKind: 'paused',
            heldUntil: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        })?.label).toBe('Paused fleet-wide · 2d')
        expect(automationChip({ heldBy: 'provider', heldKind: 'stopped' })?.title)
            .toMatch(/provider row/)
    })

    it('trusts the server-resolved hold over the source\'s own switches', () => {
        // The server applies most-restrictive-wins and reports the WIDEST
        // scope; a paused source under a stopped provider says "provider".
        expect(rowHold({
            autoReconcile: true, pausedUntil: '2999-01-01T00:00:00+00:00',
            heldBy: 'provider', heldKind: 'stopped',
        })).toEqual({ scope: 'provider', kind: 'stopped', until: null })
    })

    it('leaves the cooldown to FreshnessBadges rather than saying it twice', () => {
        // "Next rebuild in Xm" already renders from this same `cooldownUntil`
        // one column across, so a chip here would duplicate the signal.
        expect(automationChip({ driftState: 'drifting' })).toBeNull()
    })

    it('prefers the opt-out over a snooze — Act stays off regardless of when the snooze lapses', () => {
        // Drifting + paused + opted-out all at once, on a backend that
        // predates the resolved hold: "Paused" would wrongly imply this
        // source resumes on its own once the snooze expires.
        expect(automationChip({
            driftState: 'drifting', autoReconcile: false,
            pausedUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Stopped')
    })
})

describe('hold copy', () => {
    it('drops the scope suffix on the scope\'s own surface', () => {
        expect(holdLabel({ scope: 'provider', kind: 'stopped', until: null }, 'provider')).toBe('Stopped')
        expect(holdLabel({ scope: 'fleet', kind: 'stopped', until: null }, 'provider')).toBe('Stopped fleet-wide')
    })

    it('tells a person overriding a hold that the hold stays', () => {
        expect(overrideWarning({ scope: 'provider', kind: 'stopped', until: null }))
            .toBe('Automatic rebuilds are stopped for every source under this provider. Rebuilding now runs once; automation stays off.')
        expect(overrideWarning({ scope: 'source', kind: 'paused', until: null }))
            .toMatch(/^Automatic rebuilds are paused for this source\. Rebuilding now runs once; the pause stays\.$/)
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

    it('makes a held chip a filter to the held facet', async () => {
        const user = userEvent.setup()
        const onFilterStatus = vi.fn()
        renderRow(
            { dataSourceId: 'ds-off', aggregationStatus: 'ready', driftState: 'inSync', autoReconcile: false },
            { onFilterStatus },
        )
        await user.click(screen.getByRole('button', { name: /^Stopped$/ }))
        expect(onFilterStatus).toHaveBeenCalledWith('held')
    })
})

describe('FreshnessRow — a wedged projection is never a healthy row', () => {
    it('never reads "Up to date" while the rolled-up connections are missing', () => {
        // The source's last aggregation job succeeded and no marker is set, so
        // every existing signal says healthy. It is not: main reads are
        // falling back to the version log, which carries no rolled-up
        // connections at all.
        renderRow({
            dataSourceId: 'ds-wedged', name: 'Wedged Source',
            aggregationStatus: 'ready', driftState: 'projectionStalled',
            platformMastered: true,
        })
        expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
        expect(screen.getByText('Connections not up to date')).toBeInTheDocument()
    })

    it('says automation will not rescue it, rather than staying silent', () => {
        const chip = automationChip({ driftState: 'projectionStalled' })
        expect(chip?.label).toBe("Rebuild won't fix this")
        expect(chip?.facet).toBe('projectionStalled')
        expect(chip?.title).toMatch(/version control/i)
    })

    it('reads the live projector, not only the sweep stamp', () => {
        // One row, two clocks. ``driftState`` is written by the reconciliation
        // sweep at most once per check interval (shipped default 3600s);
        // ``projectorCurrent`` on the SAME row is read live on every request.
        // For up to a whole interval after a wedge starts the payload says
        // ``managed`` and ``projectorCurrent: false`` at once — and this row
        // rendered the green badge over a live wedge, while Insights (which
        // reads the live bit) rendered red and said "open Freshness".
        renderRow({
            dataSourceId: 'ds-onset', name: 'Onset Source',
            aggregationStatus: 'ready', driftState: 'managed',
            platformMastered: true, projectorCurrent: false,
        })
        expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
        expect(screen.getByText('Connections not up to date')).toBeInTheDocument()
    })

    it('leaves an unknown projector reading as unknown, never as a wedge', () => {
        // ``null`` is UNKNOWN — an unversioned source, a graph pinned to no
        // target, an unreadable store. It must render as neither verdict.
        renderRow({
            dataSourceId: 'ds-unknown', name: 'Unknown Source',
            aggregationStatus: 'ready', driftState: 'inSync',
            projectorCurrent: null,
        })
        expect(screen.queryByText('Connections not up to date')).not.toBeInTheDocument()
        expect(screen.getByText('Up to date')).toBeInTheDocument()
    })

    it('warns automation off a live wedge the stamp has not caught up with', () => {
        expect(automationChip({ driftState: 'managed', projectorCurrent: false })?.label)
            .toBe("Rebuild won't fix this")
        // ...and still says nothing when the live reading is unknown.
        expect(automationChip({ driftState: 'managed', projectorCurrent: null })).toBeNull()
    })
})
