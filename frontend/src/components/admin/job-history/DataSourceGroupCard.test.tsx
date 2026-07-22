/**
 * DataSourceGroupCard — regression test for the app-wide click freeze.
 *
 * Bug: the "..." actions menu was a modal Radix DropdownMenu. Radix's
 * DismissableLayer sets `document.body.style.pointerEvents = 'none'` while a
 * MODAL layer is open and only restores it on effect cleanup. This card
 * re-renders on the Job History poll/SSE, so a modal menu open during a
 * re-render/unmount left `<body>` stuck at `pointer-events: none` — freezing
 * every click across the whole application.
 *
 * Fix: `modal={false}`, which never touches body pointer-events. This test
 * opens the menu and asserts the body is never locked, guarding against a
 * regression to modal mode.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { DataSourceGroupCard, type DataSourceGroup } from './DataSourceGroupCard'

// jsdom lacks the pointer-capture + scroll APIs Radix calls when a menu opens.
beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
    Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})
})

const group: DataSourceGroup = {
    dataSourceId: 'ds-1',
    meta: {
        label: 'Perf-Load-Test-Layered-Lineage',
        workspaceId: 'ws-1',
        workspaceName: 'Major Refactor Agg',
        providerId: 'p-1',
        providerName: 'Falkor Docker',
        providerType: 'falkordb',
        graphName: 'gv_ds1',
        projectionMode: 'in_source',
    },
    jobs: [],
    totalRuns: 0,
    successRate: null,
    avgDuration: null,
    lastRunAt: null,
    lastStatus: null,
    failedCount: 0,
    isActive: false,
    sparklineData: [],
    durationTrend: null,
}

function renderCard() {
    return render(
        <DataSourceGroupCard
            group={group}
            expanded={false}
            onToggle={vi.fn()}
            onCancel={vi.fn()}
            onResume={vi.fn()}
            onRetrigger={vi.fn()}
            onDelete={vi.fn()}
            onPurge={vi.fn()}
            onTriggerAggregation={vi.fn()}
            onPurgeDataSource={vi.fn()}
            onShowAllJobs={vi.fn()}
            expandedRowId={null}
            onToggleRow={vi.fn()}
            purgeConfirm={null}
            setPurgeConfirm={vi.fn()}
            actionLoading={null}
        />,
        { wrapper: MemoryRouter },
    )
}

describe('DataSourceGroupCard actions menu', () => {
    it('does not lock document.body pointer-events when opened (non-modal)', async () => {
        const user = userEvent.setup()
        renderCard()

        expect(document.body.style.pointerEvents).not.toBe('none')

        await user.click(screen.getByLabelText('Data source actions'))

        // Menu is open and its items are reachable...
        expect(await screen.findByText('Trigger Aggregation')).toBeInTheDocument()
        // ...and the rest of the app is still clickable (the freeze bug).
        expect(document.body.style.pointerEvents).not.toBe('none')
    })

    it('invokes the trigger handler when an item is clicked', async () => {
        const user = userEvent.setup()
        const onTrigger = vi.fn()
        render(
            <DataSourceGroupCard
                group={group}
                expanded={false}
                onToggle={vi.fn()}
                onCancel={vi.fn()}
                onResume={vi.fn()}
                onRetrigger={vi.fn()}
                onDelete={vi.fn()}
                onPurge={vi.fn()}
                onTriggerAggregation={onTrigger}
                onPurgeDataSource={vi.fn()}
                onShowAllJobs={vi.fn()}
                expandedRowId={null}
                onToggleRow={vi.fn()}
                purgeConfirm={null}
                setPurgeConfirm={vi.fn()}
                actionLoading={null}
            />,
            { wrapper: MemoryRouter },
        )

        await user.click(screen.getByLabelText('Data source actions'))
        await user.click(await screen.findByText('Trigger Aggregation'))

        expect(onTrigger).toHaveBeenCalledWith('ds-1')
        expect(document.body.style.pointerEvents).not.toBe('none')
    })
})
