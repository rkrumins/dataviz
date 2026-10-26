/**
 * VisualQueryBuilder — the store-agnostic flat builder shared by the
 * Advanced-Search QueryCard and the Property Manager rule editor. These
 * tests pin the contract both callers rely on:
 *
 *   • value edits route to ``onSeed`` (history-free) — NOT ``onCommit``
 *   • structural changes (add / remove) route to ``onCommit``
 *   • without ``enableRowSelection`` rows expose no bulk-select checkbox
 *
 * framer-motion is mocked (cached per tag) so the AddFilterPalette portal
 * popover renders and controlled inputs keep their keystrokes.
 */
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import { VisualQueryBuilder } from '../VisualQueryBuilder'


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


const textPredicate: Predicate = {
    kind: 'text', value: '', target: 'name', match: 'substring',
    caseSensitive: false, boost: 1,
}

function baseProps(over: Partial<React.ComponentProps<typeof VisualQueryBuilder>> = {}) {
    return {
        predicate: textPredicate,
        onSeed: vi.fn(),
        onCommit: vi.fn(),
        discovery: {
            allKeys: [], keysByEntityType: {}, tagValues: ['PII'],
            getValueSamples: () => [],
        },
        knownEntityTypes: ['dataset'],
        discoveredLayers: [],
        ...over,
    }
}


describe('VisualQueryBuilder', () => {
    it('routes a row value edit to onSeed, not onCommit', async () => {
        const user = userEvent.setup()
        const onSeed = vi.fn()
        const onCommit = vi.fn()
        render(<VisualQueryBuilder {...baseProps({ onSeed, onCommit })} />)

        await user.type(screen.getByPlaceholderText(/type to search/i), 'a')

        expect(onSeed).toHaveBeenCalled()
        expect(onCommit).not.toHaveBeenCalled()
    })

    it('routes "add filter" to onCommit', async () => {
        const user = userEvent.setup()
        const onSeed = vi.fn()
        const onCommit = vi.fn()
        render(<VisualQueryBuilder {...baseProps({ onSeed, onCommit })} />)

        await user.click(screen.getByRole('button', { name: /add filter/i }))
        await user.click(screen.getByText(/Tag is/i))

        expect(onCommit).toHaveBeenCalledTimes(1)
        expect(onSeed).not.toHaveBeenCalled()
    })

    it('routes a row removal to onCommit', async () => {
        const user = userEvent.setup()
        const onCommit = vi.fn()
        render(<VisualQueryBuilder {...baseProps({ onCommit })} />)

        await user.click(screen.getByRole('button', { name: /remove this filter/i }))

        expect(onCommit).toHaveBeenCalledTimes(1)
    })

    const near = {
        kind: 'withinHops', urns: ['urn:x'], hops: 2, direction: 'both',
    } as Predicate

    it('shows a condition only Code edits as such, never as unsupported', async () => {
        const onOpenAdvanced = vi.fn()
        render(<VisualQueryBuilder {...baseProps({ predicate: near, onOpenAdvanced })} />)

        expect(screen.getByText('Within N hops')).toBeInTheDocument()
        expect(screen.queryByText('unsupported')).not.toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: /Open in Code/ }))
        expect(onOpenAdvanced).toHaveBeenCalled()
    })

    it('edits an edge count in the Form: how many, which way, through which edges', () => {
        render(<VisualQueryBuilder {...baseProps({ predicate: {
            kind: 'degree', direction: 'out', op: 'gte', value: 3, edgeClass: 'links',
        } as Predicate })} />)

        expect(screen.getByText('Number of edges')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'How many edges' })).toHaveTextContent('at least')
        expect(screen.getByLabelText('Number of edges')).toHaveValue(3)
        expect(screen.getByRole('radio', { name: 'Outgoing' })).toBeChecked()
        expect(screen.getByRole('button', { name: 'Through which edges' })).toHaveTextContent('Any link')
    })

    it('compares a property with another of the same entity', () => {
        render(<VisualQueryBuilder {...baseProps({ predicate: {
            kind: 'property', key: 'freshnessHours', op: 'gt', valueKey: 'slaHours',
        } as Predicate })} />)
        expect(screen.getByRole('radio', { name: 'Another property' })).toBeChecked()
        expect(screen.getByText('Other property')).toBeInTheDocument()
        expect(screen.getByText('slaHours')).toBeInTheDocument()
        expect(screen.queryByText(/Include entities without/)).not.toBeInTheDocument()
    })

    it('turns a comparison with a value into one with another property', async () => {
        const onSeed = vi.fn()
        render(<VisualQueryBuilder {...baseProps({ onSeed, predicate: {
            kind: 'property', key: 'rows', op: 'gt', value: 5, valueType: 'number',
        } as Predicate })} />)
        await userEvent.setup().click(screen.getByRole('radio', { name: 'Another property' }))
        expect(onSeed).toHaveBeenLastCalledWith(expect.objectContaining({
            kind: 'property', key: 'rows', op: 'gt', valueKey: '' }))
        expect(onSeed.mock.lastCall?.[0]).not.toHaveProperty('value')
    })

    it('names a graph shape for the edges it counts', () => {
        render(<VisualQueryBuilder {...baseProps({ predicate: {
            kind: 'isRoot', edgeClass: 'links',
        } as Predicate })} />)

        expect(screen.getByText('Nothing links into it')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Through which edges' })).toHaveTextContent('Any link')
    })

    it('offers no hand-off where there is no Code mode, and says where it is edited', () => {
        render(<VisualQueryBuilder {...baseProps({ predicate: near })} />)

        expect(screen.getByText(/edited as JSON in Advanced Search/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Open in Code/ })).not.toBeInTheDocument()
    })

    it('shows every entity as a condition with nothing to fill in', () => {
        render(<VisualQueryBuilder {...baseProps({ predicate: { kind: 'all' } as Predicate })} />)

        expect(screen.getByText('Every entity')).toBeInTheDocument()
        expect(screen.queryByText('unsupported')).not.toBeInTheDocument()
    })

    it('follows lineage past 3 steps only from the query’s top-level AND', async () => {
        const feeds: Predicate = { kind: 'related', axis: 'downstream', maxHops: 3 }
        const steps = async () => {
            await userEvent.setup().click(screen.getByRole('button', { name: /More options/ }))
            return within(screen.getByRole('radiogroup', { name: 'How many steps' }))
                .getAllByRole('radio').map((r) => r.textContent)
        }
        const all: Predicate = { kind: 'group', op: 'and', children: [textPredicate, feeds] }
        const { unmount } = render(<VisualQueryBuilder {...baseProps({ predicate: all })} />)
        expect(await steps()).toEqual(['1 step', 'Up to 2', 'Up to 3', 'Up to 5', 'Up to 10'])
        unmount()
        for (const predicate of [
            { kind: 'group', op: 'or', children: [textPredicate, feeds] },
            { kind: 'group', op: 'and', children: [textPredicate, { kind: 'group', op: 'not', children: [feeds] }] },
        ] as Predicate[]) {
            const view = render(<VisualQueryBuilder {...baseProps({ predicate })} />)
            expect(await steps()).toEqual(['1 step', 'Up to 2', 'Up to 3'])
            view.unmount()
        }
    })

    it('renders no bulk-select checkbox when row selection is disabled', () => {
        render(<VisualQueryBuilder {...baseProps()} />)
        expect(screen.queryByLabelText(/select filter row/i)).not.toBeInTheDocument()
    })

    it('exposes the bulk-select checkbox when enableRowSelection is set', () => {
        render(<VisualQueryBuilder {...baseProps({ enableRowSelection: true })} />)
        expect(screen.getByLabelText(/select filter row/i)).toBeInTheDocument()
    })
})
