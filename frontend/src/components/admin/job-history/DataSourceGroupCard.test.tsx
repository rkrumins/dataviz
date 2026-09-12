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
        )

        await user.click(screen.getByLabelText('Data source actions'))
        await user.click(await screen.findByText('Trigger Aggregation'))

        expect(onTrigger).toHaveBeenCalledWith('ds-1')
        expect(document.body.style.pointerEvents).not.toBe('none')
    })
})

// ── where a source's runs go wrong ───────────────────────────────────────
//
// A column of red rows says runs fail. WHERE they fail is a different
// problem each time: a source that keeps dying in Apply is out of room on
// its shard, one dying in Extract has a scan it cannot finish.

type Job = DataSourceGroup['jobs'][number]

const failedIn = (id: string, at: string): Job => ({
    id: `job-${id}-${at}`,
    dataSourceId: 'ds-1',
    status: 'failed',
    triggerSource: 'manual',
    progress: 40,
    totalEdges: 0,
    processedEdges: 0,
    createdEdges: 0,
    batchSize: 1000,
    resumable: true,
    retryCount: 0,
    createdAt: at,
    startedAt: at,
    runStats: {
        steps: [{
            id, state: 'failed', started_at: at, ended_at: at,
            secs: 10, visits: 1, done: null, total: null, unit: null, waiting_for: null,
        }],
    },
}) as unknown as Job

function renderWithJobs(jobs: Job[]) {
    return render(
        <DataSourceGroupCard
            group={{ ...group, jobs }}
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
    )
}

describe('where a source keeps stopping', () => {
    it('names the stage most recent failures died in', () => {
        renderWithJobs([
            failedIn('applying', '2026-09-12T03:00:00Z'),
            failedIn('applying', '2026-09-12T02:00:00Z'),
            failedIn('extracting', '2026-09-12T01:00:00Z'),
        ])
        expect(screen.getByTestId('failure-pattern').textContent)
            .toBe('2 of the last 3 runs stopped in Apply')
    })

    it('stays quiet for a single failure — that is an incident, not a pattern', () => {
        renderWithJobs([failedIn('applying', '2026-09-12T03:00:00Z')])
        expect(screen.queryByTestId('failure-pattern')).toBeNull()
    })

    it('stays quiet for runs from before the ledger existed', () => {
        renderWithJobs([
            { ...failedIn('applying', '2026-09-12T03:00:00Z'), runStats: null },
            { ...failedIn('applying', '2026-09-12T02:00:00Z'), runStats: null },
        ])
        expect(screen.queryByTestId('failure-pattern')).toBeNull()
    })
})


describe('where the time went, run over run', () => {
    const ran = (id: string, extractS: number, applyS: number) => ({
        ...failedIn('applying', `2026-09-12T0${id}:00:00Z`),
        id: `run-${id}`,
        status: 'completed',
        runStats: {
            steps: [
                { id: 'extracting', state: 'done', started_at: null, ended_at: null, secs: extractS, visits: 1, done: null, total: null, unit: null, waiting_for: null },
                { id: 'applying', state: 'done', started_at: null, ended_at: null, secs: applyS, visits: 1, done: null, total: null, unit: null, waiting_for: null },
            ],
        },
    }) as unknown as Job

    it('draws a column per run so a growing stage reads as a trend', () => {
        renderWithJobs([ran('1', 10, 20), ran('2', 10, 40), ran('3', 10, 90)])
        const trend = screen.getByTestId('stage-trend')
        expect(trend.children).toHaveLength(3)
        // Each column is titled with its own total and split.
        expect(trend.children[2].getAttribute('title')).toContain('Extract 10%')
    })

    it('needs at least two runs to be a trend at all', () => {
        renderWithJobs([ran('1', 10, 20)])
        expect(screen.queryByTestId('stage-trend')).toBeNull()
    })

    it('draws nothing for runs from before the ledger existed', () => {
        renderWithJobs([
            { ...ran('1', 10, 20), runStats: null },
            { ...ran('2', 10, 40), runStats: null },
        ] as Job[])
        expect(screen.queryByTestId('stage-trend')).toBeNull()
    })
})
