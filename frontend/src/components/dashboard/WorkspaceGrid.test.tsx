/**
 * The "Your business areas" header and each workspace card read the server's
 * workspace summary. They used to add up a workspace list loaded once at
 * sign-in and count views from whichever workspace happened to be open.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { WorkspaceResponse, WorkspaceSummary } from '@/services/workspaceService'
import { WorkspaceGrid } from './WorkspaceGrid'

function ws(id: string, name: string, dsIds: string[]): WorkspaceResponse {
    return {
        id, name, isDefault: false, isActive: true, createdAt: '', updatedAt: '',
        dataSources: dsIds.map(dsId => ({ id: dsId, workspaceId: id, graphName: dsId, isPrimary: false, isActive: true })),
    } as unknown as WorkspaceResponse
}

const WORKSPACES = [ws('ws_fin', 'Finance', ['ds_a', 'ds_b']), ws('ws_ops', 'Operations', ['ds_c'])]

const SUMMARY: WorkspaceSummary = {
    coverage: 'all',
    totals: {
        workspaces: 2, dataSources: 3, activeDataSources: 2, pendingDataSources: 0,
        nodes: 500, edges: 90, entityTypes: [], views: 12, sharedGraphs: 0,
    },
    workspaces: [
        {
            id: 'ws_fin', name: 'Finance', isDefault: false, dataSources: 2, activeDataSources: 1,
            pendingDataSources: 0, nodes: 400, edges: 80, entityTypes: [], views: 9,
            sources: {
                ds_a: { nodes: 400, edges: 80, pending: false, views: 9 },
                ds_b: { nodes: 0, edges: 0, pending: false, views: 0 },
            },
        },
        {
            id: 'ws_ops', name: 'Operations', isDefault: false, dataSources: 1, activeDataSources: 1,
            pendingDataSources: 0, nodes: 100, edges: 10, entityTypes: [], views: 3,
            sources: { ds_c: { nodes: 100, edges: 10, pending: false, views: 3 } },
        },
    ],
}

function renderGrid(summary?: WorkspaceSummary) {
    return render(
        <MemoryRouter>
            <WorkspaceGrid workspaces={WORKSPACES} summary={summary} />
        </MemoryRouter>,
    )
}

describe('WorkspaceGrid', () => {
    it('totals from the summary, saying how many sources are active only when some are paused', () => {
        renderGrid(SUMMARY)
        expect(screen.getByText('2 workspaces · 3 data sources (2 active)')).toBeInTheDocument()
        expect(screen.queryByText(/1 active$/)).not.toBeInTheDocument()
    })

    it('counts every workspace’s views, not just the open one’s', () => {
        renderGrid(SUMMARY)
        // Finance: 9 views; Operations: 3 — each on its own card.
        expect(screen.getAllByText('9').length).toBeGreaterThan(0)
        expect(screen.getAllByText('3').length).toBeGreaterThan(0)
    })

    it('says when a workspace has paused sources instead of claiming all are active', () => {
        renderGrid(SUMMARY)
        expect(screen.getByText('Online · 1 of 2 sources active')).toBeInTheDocument()
        expect(screen.getByText('Online · All sources active')).toBeInTheDocument()
    })

    it('flags sources still being counted', () => {
        renderGrid({ ...SUMMARY, totals: { ...SUMMARY.totals, pendingDataSources: 1 } })
        expect(screen.getByText('· counting…')).toBeInTheDocument()
    })

    it('a known zero reads as 0; a dash means still being counted', () => {
        const noViews = SUMMARY.workspaces.map(w => ({ ...w, views: 0 }))
        renderGrid({ ...SUMMARY, workspaces: noViews })
        // Both cards: Views is a real zero, not "unknown".
        expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2)
        expect(screen.queryByText('—')).not.toBeInTheDocument()
    })

    it('waits for the numbers rather than inventing them', () => {
        renderGrid(undefined)
        expect(screen.getByText('Counting your workspaces…')).toBeInTheDocument()
    })

    it('pages four at a time, so a wide screen shows one full row', () => {
        const six = ['Finance', 'Operations', 'Sales', 'Marketing', 'People', 'Legal']
            .map((name, i) => ws(`ws_${i}`, name, []))
        render(<MemoryRouter><WorkspaceGrid workspaces={six} /></MemoryRouter>)
        const shown = () => six.map(w => w.name).filter(name => screen.queryByText(name))
        expect(shown()).toEqual(['Finance', 'Operations', 'Sales', 'Marketing'])

        fireEvent.click(screen.getByRole('button', { name: /Next/ }))
        expect(shown()).toEqual(['People', 'Legal'])
    })
})
