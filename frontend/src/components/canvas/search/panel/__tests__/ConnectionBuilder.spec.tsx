/**
 * ConnectionBuilder — a Connections search in the Form: From and To each a
 * builder of its own, held to what one end of an edge may hold, with how
 * many entities meet it; Through, the edges between them, which way, and
 * what each must meet. framer-motion is mocked (cached per tag) so the
 * portal menus render synchronously.
 */
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EdgesPredicate, Predicate } from '@/types/search'

import { ConnectionBuilder, connectionSetOf, withConnectionSet, withEnd } from '../ConnectionBuilder'


vi.mock('framer-motion', () => {
    const cache = new Map<string, React.ComponentType<unknown>>()
    const passthrough = (tag: string) => {
        let cmp = cache.get(tag)
        if (!cmp) {
            cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
                function MotionStub(props, ref) {
                    return React.createElement(tag, { ...props, ref })
                },
            ) as unknown as React.ComponentType<unknown>
            cache.set(tag, cmp)
        }
        return cmp
    }
    return {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    }
})

// Each end counted exactly: From 55, To 16.
vi.mock('../counts/useCounts', () => ({
    useCounts: (_viewId: string, items: ReadonlyArray<{ id: string }>) => ({
        counts: new Map(items.map((item, i) => [item.id, { count: [55, 16][i], complete: true }])),
        status: 'done',
    }),
}))


const COLUMNS: Predicate = { kind: 'entityType', op: 'in', values: ['schemaField'] }
const FINANCE: Predicate = { kind: 'tag', op: 'hasAny', values: ['Finance'] }

function builder(value: EdgesPredicate) {
    const onSeed = vi.fn()
    const onCommit = vi.fn()
    render(
        <ConnectionBuilder
            value={value}
            onSeed={onSeed}
            onCommit={onCommit}
            viewId="view-1"
            discovery={{ allKeys: [], keysByEntityType: {}, tagValues: ['Finance'], getValueSamples: () => [] }}
            knownEntityTypes={['schemaField', 'dataset']}
            discoveredLayers={[]}
            isRunning={false}
        />,
    )
    return { onSeed, onCommit }
}

const end = (name: 'From' | 'To') => screen.getByRole('region', { name })


describe('ConnectionBuilder', () => {
    it('reads each end with how many entities meet it, an empty end any entity', () => {
        builder({ kind: 'edges', sourceWhere: COLUMNS, targetWhere: FINANCE })
        expect(within(end('From')).getByText('55 entities')).toBeInTheDocument()
        expect(within(end('To')).getByText('16 entities')).toBeInTheDocument()
    })

    it('says an empty end is any entity', () => {
        builder({ kind: 'edges', sourceWhere: COLUMNS })
        expect(within(end('To')).getByText('any entity — add a condition to narrow it')).toBeInTheDocument()
        expect(within(end('From')).getByText('entities that…')).toBeInTheDocument()
    })

    it("offers an end what an entity search's top level has, but no route", async () => {
        const user = userEvent.setup()
        builder({ kind: 'edges', sourceWhere: COLUMNS })
        await user.click(within(end('To')).getByRole('button', { name: /add filter/i }))
        expect(screen.getByText(/Inside a container named/i)).toBeInTheDocument()
        expect(screen.queryByText(/Paths from A to B/i)).not.toBeInTheDocument()
    })

    it('edits one end, keeping the other and the edges', async () => {
        const user = userEvent.setup()
        const { onCommit } = builder({ kind: 'edges', sourceWhere: COLUMNS, targetWhere: FINANCE, direction: 'either' })
        await user.click(within(end('From')).getByTitle('Remove this filter'))
        expect(onCommit).toHaveBeenLastCalledWith({ kind: 'edges', targetWhere: FINANCE, direction: 'either' })
    })

    it('goes either way, and back to From → To as the default it is', async () => {
        const user = userEvent.setup()
        const { onCommit } = builder({ kind: 'edges', sourceWhere: COLUMNS })
        await user.click(screen.getByRole('radio', { name: 'Either way' }))
        expect(onCommit).toHaveBeenLastCalledWith({ kind: 'edges', sourceWhere: COLUMNS, direction: 'either' })
    })

    it('says how either way reads its ends', () => {
        builder({ kind: 'edges', sourceWhere: COLUMNS, direction: 'either' })
        expect(screen.getByText(/From and To may be the source or the target/)).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Either way' })).toBeChecked()
    })

    it('walks any link unless told otherwise, and picks edge types from none', async () => {
        const user = userEvent.setup()
        const { onCommit } = builder({ kind: 'edges', sourceWhere: COLUMNS })
        const through = screen.getByRole('button', { name: /Through which edges/ })
        expect(through).toHaveTextContent('Any link')
        await user.click(through)
        await user.click(screen.getByRole('option', { name: /These edge types/ }))
        expect(onCommit).toHaveBeenLastCalledWith({ kind: 'edges', sourceWhere: COLUMNS, edgeTypes: [] })
    })
})


describe('Connections edits', () => {
    const base: EdgesPredicate = { kind: 'edges', sourceWhere: COLUMNS, edgeClass: 'lineage' }

    it('reads the edge set: types, a class, or any link unsaid', () => {
        expect(connectionSetOf({ kind: 'edges', edgeTypes: ['PRODUCES'] })).toBe('types')
        expect(connectionSetOf(base)).toBe('lineage')
        expect(connectionSetOf({ kind: 'edges' })).toBe('links')
    })

    it('changes the edge set, leaving any link unsaid', () => {
        expect(withConnectionSet(base, 'links')).toEqual({ kind: 'edges', sourceWhere: COLUMNS })
        expect(withConnectionSet(base, 'types')).toEqual({ kind: 'edges', sourceWhere: COLUMNS, edgeTypes: [] })
        expect(withConnectionSet({ kind: 'edges', edgeTypes: ['PRODUCES'] }, 'any'))
            .toEqual({ kind: 'edges', edgeClass: 'any' })
    })

    it('replaces one end, none meaning any entity', () => {
        expect(withEnd(base, 'targetWhere', FINANCE)).toEqual({ ...base, targetWhere: FINANCE })
        expect(withEnd(base, 'sourceWhere', null)).toEqual({ kind: 'edges', edgeClass: 'lineage' })
    })
})
