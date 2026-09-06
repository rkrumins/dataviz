/**
 * The workspace Aggregation card is the surface an analyst's admin lands on
 * after a rebuild "succeeded". The batch job DID succeed — the stored status
 * is genuinely ``ready`` — so the one thing that can contradict it here is the
 * live projector reading, and the banner that carries it shipped with no test
 * at all: its gate could be neutralised entirely, in either direction, and the
 * whole suite stayed green.
 *
 * ``null`` is the reading these tests care about most. It means "not
 * versioned, or the projection store could not be read" — UNKNOWN — and every
 * sibling surface has an explicit guard against a future ``!== true``
 * simplification painting every external source red. This was the one that
 * did not.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkspaceAggregationDashboard } from './WorkspaceAggregationDashboard'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'

const DS = {
    id: 'ds-1', name: 'Orders', aggregationStatus: 'ready',
} as unknown as DataSourceResponse

function readiness(over: Partial<DataSourceReadinessResponse>): DataSourceReadinessResponse {
    return {
        dataSourceId: 'ds-1', isReady: true, aggregationStatus: 'ready',
        canCreateViews: true, driftDetected: false, ...over,
    } as unknown as DataSourceReadinessResponse
}

function renderCard(over: Partial<DataSourceReadinessResponse>) {
    return render(
        <WorkspaceAggregationDashboard
            dataSources={[DS]}
            readinessMap={{ 'ds-1': readiness(over) }}
            onReaggregate={async () => {}}
            onPurge={async () => {}}
        />,
    )
}

describe('WorkspaceAggregationDashboard — connections not up to date', () => {
    it('contradicts a "ready" card when the projector is behind, and says how far', () => {
        renderCard({ projectorCurrent: false, projectionCommitsBehind: 902 })

        expect(screen.getByText(/Connections not up to date/)).toHaveTextContent(
            'Connections not up to date — 902 published changes behind',
        )
        // The action, and the action NOT to take: this card's own primary
        // button is Re-aggregate, and it is the one thing that cannot help.
        expect(screen.getByText(/Re-aggregating will not fix it/)).toBeInTheDocument()
    })

    it('counts one change in the singular', () => {
        renderCard({ projectorCurrent: false, projectionCommitsBehind: 1 })
        expect(screen.getByText(/Connections not up to date/)).toHaveTextContent(
            'Connections not up to date — 1 published change behind',
        )
    })

    it('drops the count clause rather than printing "0 changes behind"', () => {
        renderCard({ projectorCurrent: false, projectionCommitsBehind: 0 })
        const line = screen.getByText(/Connections not up to date/)
        expect(line).toHaveTextContent('Connections not up to date')
        expect(line).not.toHaveTextContent(/behind/)
    })

    it('stays silent while the projector is current', () => {
        renderCard({ projectorCurrent: true, projectionCommitsBehind: 0 })
        expect(screen.queryByText(/Connections not up to date/)).not.toBeInTheDocument()
    })

    it('says nothing at all on an UNKNOWN reading — null is not a wedge', () => {
        // The gate is ``=== false``, never ``!== true``. A null reading here
        // is an unversioned source, a graph pinned to no target, or a store
        // that could not be read; painting those red puts most of the fleet
        // permanently in the wrong.
        renderCard({ projectorCurrent: null, projectionCommitsBehind: null })
        expect(screen.queryByText(/Connections not up to date/)).not.toBeInTheDocument()
        expect(screen.queryByText(/Re-aggregating will not fix it/)).not.toBeInTheDocument()
    })

    it('carries a different glyph from the drift warning it stacks above', () => {
        // The two banners can render together and prescribe OPPOSITE actions
        // ("Re-aggregating will not fix it" vs "Re-trigger to reconcile"). With
        // the same triangle on both, only red-vs-amber separated them — the one
        // channel DriftStateBadge's own contract rules out, and the shape an
        // operator has already learned on the five other surfaces where this
        // verdict is always Unplug.
        const { container } = renderCard({
            projectorCurrent: false, projectionCommitsBehind: 902,
            driftDetected: true,
        })
        expect(screen.getByText(/Re-trigger to reconcile/)).toBeInTheDocument()
        expect(container.querySelector('.lucide-unplug')).not.toBeNull()
    })
})
