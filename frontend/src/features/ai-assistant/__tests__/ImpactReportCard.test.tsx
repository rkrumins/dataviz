/**
 * The impact report: how serious, how much and of what kind, who uses the end of the line (or,
 * upstream, where it starts), whom to tell, why (the paths, with what each link does), when,
 * and what the walk could not see. Open trace takes the trace there — on the canvas when it is
 * that view's, by link otherwise.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeTraceShare } from '@/hooks/lib/traceShareCodec'
import { registerCanvasActions, type CanvasActions } from '@/store/canvasActionsBridge'

import type { ImpactData } from '../api/types'
import { ImpactReportCard } from '../components/blocks/ImpactReportCard'

const col = (urn: string, name: string, type = 'schemaField') => ({ urn, name, type, path: ['Snowflake', 'sales'] })

const IMPACT: ImpactData = {
    direction: 'downstream',
    target: col('urn:first_name', 'first_name'),
    change: 'drop',
    severity: 'high',
    severityReasons: ['Feeds 3 dashboards'],
    summary: 'Dropping first_name breaks 3 dashboards and 12 columns in 4 tables.',
    totals: { entities: 47, exact: true, byType: [
        { type: 'schemaField', label: 'Column', count: 40 }, { type: 'dashboard', label: 'Dashboard', count: 3 },
    ] },
    byContainer: [{ entity: col('urn:customers', 'customers', 'dataset'), count: 12 }],
    consumers: [{ ...col('urn:dash', 'Customer 360', 'dashboard'), hops: 3 }],
    owners: [{ owner: 'data-platform-team', property: 'owner', count: 9, assets: [col('urn:customers', 'customers', 'dataset')] }],
    paths: [{
        nodes: [col('urn:first_name', 'first_name'), col('urn:full_name', 'full_name'), col('urn:dash', 'Customer 360', 'dashboard')],
        edges: [{ type: 'TRANSFORMS', detail: "concat(first_name,' ',last_name)" }, { type: 'CONSUMES', detail: null }],
    }],
    timing: { schedules: [{ job: col('urn:job', 'nightly_customers', 'dataJob'), schedule: '0 4 * * *', human: 'daily at 04:00 UTC' }],
        note: 'The first job that reads it runs daily at 04:00 UTC.' },
    grain: 'coarse',
    truncated: true,
    notes: ['Two tables have no owner property.'],
    trace: { urn: 'urn:first_name', direction: 'downstream', depth: 10 },
    query: { predicate: { kind: 'entityType', op: 'in', values: ['dashboard'] }, scopeMode: 'data_source' },
    viewId: 'v1',
}

function Where() {
    const loc = useLocation()
    return <output data-testid="where">{loc.pathname}{loc.search}</output>
}

function renderCard(data: ImpactData) {
    return render(
        <MemoryRouter initialEntries={['/dashboard']}>
            <ImpactReportCard data={data} />
            <Where />
        </MemoryRouter>,
    )
}

const unregister: Array<() => void> = []
afterEach(() => { while (unregister.length) unregister.pop()!() })

describe('ImpactReportCard', () => {
    it('leads with how serious it is and what would break', () => {
        renderCard(IMPACT)
        const card = screen.getByRole('region', { name: 'What breaks if first_name is dropped' })
        expect(within(card).getByText('High impact')).toBeInTheDocument()
        expect(within(card).getByText('Feeds 3 dashboards')).toBeInTheDocument()
        expect(within(card).getByText(IMPACT.summary)).toBeInTheDocument()
        expect(within(card).getByText('affected').parentElement).toHaveTextContent('affected47')
    })

    it('shows the totals by type, the consumers, and the owners to notify', () => {
        renderCard(IMPACT)
        expect(screen.getByText('Affected, by type')).toBeInTheDocument()
        expect(screen.getByText('Column')).toBeInTheDocument()
        expect(screen.getByText('Consumers')).toBeInTheDocument()
        expect(screen.getByText('3 hops')).toBeInTheDocument()
        expect(screen.getByText('Owners to notify')).toBeInTheDocument()
        expect(screen.getByText('data-platform-team')).toBeInTheDocument()
    })

    it('says why — each path a chain, what each link does under it — and when', () => {
        renderCard(IMPACT)
        const path = screen.getByRole('listitem', { name: 'Path 1: first_name to full_name to Customer 360' })
        expect(within(path).getByText('transforms')).toBeInTheDocument()
        expect(within(path).getByText("concat(first_name,' ',last_name)")).toBeInTheDocument()
        expect(screen.getByText('The first job that reads it runs daily at 04:00 UTC.')).toBeInTheDocument()
        expect(screen.getByText('daily at 04:00 UTC')).toBeInTheDocument()
    })

    it('ends on what the walk could not see', () => {
        renderCard(IMPACT)
        expect(screen.getByText(/Traced through rolled-up lineage/)).toBeInTheDocument()
        expect(screen.getByText(/The walk stopped before the end/)).toBeInTheDocument()
        expect(screen.getByText('Two tables have no owner property.')).toBeInTheDocument()
    })

    it('reads a plain trace without the "what breaks" framing, and upstream as where it comes from', () => {
        const { unmount } = renderCard({ ...IMPACT, change: null })
        expect(screen.getByRole('region', { name: 'What depends on first_name' })).toBeInTheDocument()
        expect(screen.queryByText('High impact')).not.toBeInTheDocument()
        unmount()
        renderCard({ ...IMPACT, direction: 'upstream', change: null, owners: [] })
        expect(screen.getByRole('region', { name: 'Where first_name comes from' })).toBeInTheDocument()
        expect(screen.getByText('Sources')).toBeInTheDocument()
        expect(screen.queryByText('Consumers')).not.toBeInTheDocument()
        expect(screen.queryByText(/Owners/)).not.toBeInTheDocument()
    })

    it('opens the trace by link when that view’s canvas is not the one open', () => {
        renderCard(IMPACT)
        fireEvent.click(screen.getByRole('button', { name: 'Open trace' }))
        const where = new URL(screen.getByTestId('where').textContent!, 'http://x')
        expect(where.pathname).toBe('/views/v1')
        expect(decodeTraceShare(where.searchParams.get('trace')!)).toMatchObject({
            urn: 'urn:first_name', up: false, down: true, depthDown: 10,
        })
    })

    it('starts the trace on the canvas when it is showing that view', () => {
        const canvas: CanvasActions = {
            viewId: 'v1', reveal: vi.fn(), locateMany: vi.fn(), startTrace: vi.fn(), runSearch: vi.fn(), openCypher: vi.fn(),
            getContext: () => ({ viewId: 'v1', selectedUrns: [] }),
        }
        unregister.push(registerCanvasActions(canvas))
        renderCard(IMPACT)
        fireEvent.click(screen.getByRole('button', { name: 'Open trace' }))
        expect(canvas.startTrace).toHaveBeenCalledWith(['urn:first_name'], { direction: 'downstream', depth: 10 })
        expect(screen.getByTestId('where')).toHaveTextContent('/dashboard')
        fireEvent.click(screen.getByRole('button', { name: 'Open in Advanced Search' }))
        expect(canvas.runSearch).toHaveBeenCalledWith(IMPACT.query!.predicate)
    })
})
