/**
 * EdgeResultsList — a Connections search's edges, each source → type →
 * target with the container each end sits in; the exact count of each edge
 * type, a chip narrowing Through to it; a row showing both its ends on the
 * canvas. NoConnections — what to change when nothing joins the two ends.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EdgeEnd, EdgeHit, EdgesPredicate, Predicate } from '@/types/search'

import { EDGE_ROW_ID_PREFIX, EdgeResultsList, NoConnections, revealEdge } from '../EdgeResultsList'


// How many entities meet From and To, as counted.
const ends = vi.hoisted(() => ({ counts: [55, 16] }))
vi.mock('../counts/useCounts', () => ({
    useCounts: (_viewId: string, items: ReadonlyArray<{ id: string }>) => ({
        counts: new Map(items.map((item, i) => [item.id, { count: ends.counts[i], complete: true }])),
        status: 'done',
    }),
}))


function end(urn: string, displayName: string, entityType: string, parent?: string): EdgeEnd {
    const container = parent ? { urn: `urn:${parent}`, displayName: parent, entityType: 'container' } : null
    return { urn, displayName, entityType, parent: container, ancestorPath: container ? [container] : [] }
}

const AMOUNT: EdgeHit = {
    key: 'k1', id: 'e1', edgeType: 'TRANSFORMS', properties: { logic: 'cast' },
    source: end('urn:amount', 'amount', 'schemaField', 'raw_orders'),
    target: end('urn:amount_usd', 'amount_usd', 'schemaField', 'clean_orders'),
}
const CUSTOMER: EdgeHit = {
    key: 'k2', id: 'e2', edgeType: 'DEFINED_BY', properties: {},
    source: end('urn:clean_customers', 'clean_customers', 'dataset', 'SILVER'),
    target: end('urn:customer', 'Customer', 'glossaryTerm'),
}
const COLUMNS: Predicate = { kind: 'entityType', op: 'in', values: ['schemaField'] }
const FINANCE: Predicate = { kind: 'tag', op: 'hasAny', values: ['Finance'] }

function list(over: Partial<React.ComponentProps<typeof EdgeResultsList>> = {}) {
    const props = {
        edges: [AMOUNT, CUSTOMER],
        typeCounts: { TRANSFORMS: 15, DEFINED_BY: 4 },
        draft: { kind: 'edges', sourceWhere: COLUMNS } as EdgesPredicate,
        onRefine: vi.fn(),
        onReveal: vi.fn(),
        onOpen: vi.fn(),
        scrollElementRef: createRef<HTMLElement>(),
        ...over,
    }
    render(<EdgeResultsList {...props} />)
    return props
}


describe('EdgeResultsList', () => {
    it('lists each edge source → type → target, each end in its container', () => {
        list()
        const row = within(document.getElementById(`${EDGE_ROW_ID_PREFIX}k1`)!)
        expect(row.getByRole('button', { name: 'amount' })).toBeInTheDocument()
        expect(row.getByText('in raw_orders')).toBeInTheDocument()
        expect(row.getByText('Transforms')).toBeInTheDocument()
        expect(row.getByRole('button', { name: 'amount_usd' })).toBeInTheDocument()
        expect(row.getByText('in clean_orders')).toBeInTheDocument()
        // An end in no container says none.
        const second = document.getElementById(`${EDGE_ROW_ID_PREFIX}k2`)!
        expect(second).toHaveTextContent(/^clean_customersin SILVERDefined byCustomer$/)
    })

    it('opens either end', async () => {
        const user = userEvent.setup()
        const { onOpen } = list()
        await user.click(screen.getByRole('button', { name: 'amount_usd' }))
        expect(onOpen).toHaveBeenCalledWith('urn:amount_usd')
    })

    it('counts each edge type exactly; a chip narrows Through to it, and again, back', async () => {
        const user = userEvent.setup()
        const { onRefine } = list()
        const chips = within(screen.getByRole('group', { name: 'Narrow by edge type' }))
        await user.click(chips.getByRole('button', { name: 'Only Defined by: 4' }))
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'edges', sourceWhere: COLUMNS, edgeTypes: ['DEFINED_BY'] })
    })

    it('takes a chip already narrowed to back to every link', async () => {
        const user = userEvent.setup()
        const { onRefine } = list({ draft: { kind: 'edges', sourceWhere: COLUMNS, edgeTypes: ['TRANSFORMS'] } })
        const chip = screen.getByRole('button', { name: 'Every link again, not only Transforms: 15' })
        expect(chip).toHaveAttribute('aria-pressed', 'true')
        await user.click(chip)
        expect(onRefine).toHaveBeenLastCalledWith({ kind: 'edges', sourceWhere: COLUMNS })
    })

    it('has no chips for a single edge type', () => {
        list({ edges: [AMOUNT], typeCounts: { TRANSFORMS: 1 } })
        expect(screen.queryByRole('group', { name: 'Narrow by edge type' })).not.toBeInTheDocument()
    })

    it('shows both ends on the canvas, coming to rest on the source', async () => {
        const user = userEvent.setup()
        const onReveal = vi.fn()
        list({ onReveal })
        await user.click(screen.getByRole('button', { name: 'Show amount and amount_usd on the canvas' }))
        expect(onReveal.mock.calls).toEqual([
            ['urn:amount_usd', AMOUNT.target.ancestorPath],
            ['urn:amount', AMOUNT.source.ancestorPath],
        ])
    })

    it('reveals the target before the source starts', async () => {
        const order: string[] = []
        let land!: () => void
        const reveal = vi.fn((urn: string) => {
            order.push(urn)
            return urn === 'urn:amount_usd' ? new Promise<void>((r) => { land = r }) : undefined
        })
        const done = revealEdge(AMOUNT, reveal)
        expect(order).toEqual(['urn:amount_usd'])
        land()
        await done
        expect(order).toEqual(['urn:amount_usd', 'urn:amount'])
    })
})


describe('NoConnections', () => {
    beforeEach(() => { ends.counts = [55, 16] })

    const none = (query: EdgesPredicate) => {
        const onRefine = vi.fn()
        render(<NoConnections query={query} viewId="view-1" onRefine={onRefine} />)
        return onRefine
    }

    it('says no edge joins the two ends, each counted, and offers either way', async () => {
        const user = userEvent.setup()
        const onRefine = none({ kind: 'edges', sourceWhere: COLUMNS, targetWhere: FINANCE })
        expect(screen.getByText(/No edge joins what From and To find/)).toBeInTheDocument()
        expect(screen.getByText('55 entities')).toBeInTheDocument()
        expect(screen.getByText('16 entities')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /^Either way/ }))
        expect(onRefine).toHaveBeenLastCalledWith(
            { kind: 'edges', sourceWhere: COLUMNS, targetWhere: FINANCE, direction: 'either' })
    })

    it('offers any link and no edge condition, where those narrowed it', async () => {
        const user = userEvent.setup()
        const onRefine = none({
            kind: 'edges', sourceWhere: COLUMNS, direction: 'either', edgeTypes: ['PRODUCES'],
            edgePredicate: { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.8 },
        })
        expect(screen.queryByRole('button', { name: /^Either way/ })).not.toBeInTheDocument()
        expect(screen.getByText('any entity')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Through any link' }))
        expect(onRefine).toHaveBeenLastCalledWith(expect.not.objectContaining({ edgeTypes: expect.anything() }))
        await user.click(screen.getByRole('button', { name: 'Without the edge condition' }))
        expect(onRefine).toHaveBeenLastCalledWith(
            { kind: 'edges', sourceWhere: COLUMNS, direction: 'either', edgeTypes: ['PRODUCES'] })
    })

    it('says when nothing meets an end, to loosen it rather than the edges', () => {
        ends.counts = [0, 16]
        none({ kind: 'edges', sourceWhere: COLUMNS, targetWhere: FINANCE })
        expect(screen.getByText(/Nothing meets From, so no edge can start there/)).toBeInTheDocument()
        expect(screen.queryByText('Try')).not.toBeInTheDocument()
    })
})
