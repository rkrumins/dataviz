/**
 * RelationshipEditor — the body of a relationship row: how many relatives
 * must match, which relatives, how far, and the relative's own conditions
 * (a nested builder). framer-motion is mocked (cached per tag) so the
 * portal menus render synchronously.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate, RelatedPredicate } from '@/types/search'

import { RelationContext } from '../relationContext'
import { RelationshipEditor } from '../RelationshipEditor'


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


const DOMAIN: Predicate = { kind: 'entityType', op: 'in', values: ['domain'] }

function editor(value: RelatedPredicate, { depth = 0, rule = false } = {}) {
    const onChange = vi.fn()
    render(
        <RelationContext.Provider value={{ depth, rule }}>
            <RelationshipEditor
                value={value}
                onChange={onChange}
                discovery={{ allKeys: [], keysByEntityType: {}, tagValues: [], getValueSamples: () => [] }}
                knownEntityTypes={['dataset', 'domain']}
                discoveredLayers={[]}
                isRunning={false}
            />
        </RelationContext.Provider>,
    )
    return onChange
}


describe('RelationshipEditor', () => {
    it('edits the relative’s conditions in a nested builder', () => {
        editor({ kind: 'related', axis: 'parent', where: DOMAIN })
        expect(screen.getByText('Where the parent…')).toBeInTheDocument()
        expect(screen.getByText('domain')).toBeInTheDocument()
    })

    it('says that no condition means any relative', () => {
        editor({ kind: 'related', axis: 'child' })
        expect(screen.getByText(/No condition: any child will do/)).toBeInTheDocument()
    })

    it('turns the relationship into a count', async () => {
        const user = userEvent.setup()
        const onChange = editor({ kind: 'related', axis: 'child', quantifier: 'all', where: DOMAIN })
        await user.click(screen.getByRole('button', { name: 'How many relatives' }))
        await user.click(screen.getByRole('option', { name: /^Count/ }))
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'child', where: DOMAIN,
            count: { op: 'gte', value: 1 } })
    })

    it('keeps what still applies when the axis changes, within the server’s reach', async () => {
        const user = userEvent.setup()
        const onChange = editor({ kind: 'related', axis: 'ancestor', maxHops: 15, where: DOMAIN })
        await user.click(screen.getByRole('button', { name: 'Which relatives' }))
        await user.click(screen.getByRole('option', { name: /^Source \(upstream\)/ }))
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            axis: 'upstream', maxHops: 3, where: DOMAIN }))
    })

    it('offers edge filters only along lineage', () => {
        editor({ kind: 'related', axis: 'upstream' })
        expect(screen.getByText('Through edges')).toBeInTheDocument()
    })

    it('stops nesting at the deepest relationship the server takes', () => {
        editor({ kind: 'related', axis: 'parent', where: { kind: 'related', axis: 'parent' } }, { depth: 2 })
        expect(screen.getByText(/Relationships nest 3 deep at most/)).toBeInTheDocument()
    })

    it('holds a display rule’s lineage to one hop', () => {
        editor({ kind: 'related', axis: 'downstream' }, { rule: true })
        expect(screen.getByLabelText('Most hops')).toHaveAttribute('max', '1')
    })
})
