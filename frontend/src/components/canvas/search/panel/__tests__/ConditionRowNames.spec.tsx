/**
 * A row naming entities holds several controls — a picker per name, pin,
 * "Use its name", remove — so it is a group, not a <label>: a label hands a
 * click anywhere inside it to its first control, and a click on a pinned
 * entity's name unpinned it.
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchResolveResult } from '@/types/search'

import { ConditionRow } from '../ConditionRow'
import { RelationContext } from '../relationContext'


const resolveSearchRefs = vi.fn<(...args: unknown[]) => Promise<SearchResolveResult>>(async () => ({
    results: [{ count: 1, matches: [{ urn: 'urn:orders', displayName: 'orders', entityType: 'dataset',
                                      ancestorPath: [{ urn: 'urn:sales', displayName: 'Sales', entityType: 'domain' }] }] }],
}))
const provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { resolveSearchRefs })

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))

vi.mock('framer-motion', () => ({
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    motion: new Proxy({}, {
        get: (_t, tag: string) => React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
            function MotionStub(props, ref) { return React.createElement(tag, { ...props, ref }) }),
    }),
}))


describe('a row naming entities', () => {
    it('shows a pinned entity in a group, and a click on its name leaves it pinned', async () => {
        const onChange = vi.fn()
        render(
            <RelationContext.Provider value={{ depth: 0, rule: false, viewId: 'v1' }}>
                <ConditionRow
                    value={{ kind: 'is', refs: [{ urn: 'urn:orders' }] }}
                    discovery={{ allKeys: [], keysByEntityType: {}, tagValues: [], getValueSamples: () => [] }}
                    knownEntityTypes={[]} activeEntityTypes={[]} discoveredLayers={[]} isRunning={false}
                    onChange={onChange} onRemove={vi.fn()} onOpenAdvanced={vi.fn()}
                />
            </RelationContext.Provider>,
        )
        expect(await screen.findByRole('button', { name: 'Use its name' })).toBeInTheDocument()
        expect(screen.getByRole('group', { name: 'Entities' })).toBeInTheDocument()
        fireEvent.click(screen.getByText('orders'))
        fireEvent.click(screen.getByText('Entities'))
        expect(resolveSearchRefs).toHaveBeenCalledTimes(1)
        expect(onChange).not.toHaveBeenCalled()
    })
})
