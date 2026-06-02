/**
 * PropertyOperationDialog — verifies the in-session staging contract: an
 * update-mode dialog (key preset, target seeded with hasProperty) emits a
 * well-formed `PropertyOp` into propertyDraftStore on confirm.
 *
 * Data deps mocked: discovery, the graph provider, and the match-count
 * service. framer-motion is stubbed (cached per tag) so the embedded
 * VisualQueryBuilder + portal render and inputs keep keystrokes.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { PropertyOperationDialog } from '../PropertyOperationDialog'
import { usePropertyDraftStore } from '@/store/propertyDraftStore'


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

vi.mock('@/components/canvas/search/builder/useDiscovery', () => ({
    useDiscovery: () => ({
        allKeys: ['owner'], keysByEntityType: {}, tagValues: [],
        getValueSamples: () => [], edgeTypes: [], keysByEdgeType: {},
        getEdgeValueSamples: () => [], isInitialLoading: false, error: null,
    }),
}))

vi.mock('@/providers/GraphProviderContext', () => {
    // Stable reference — a fresh object each call would make the dialog's
    // count effect re-run every render (a render loop that drops keystrokes).
    const provider = {}
    return { useGraphProvider: () => provider }
})

vi.mock('@/services/propertyInsights', () => ({
    countMatches: vi.fn(async () => 5),
    countPropertyUsageWithinTarget: vi.fn(async () => 0),
    getValueDistribution: vi.fn(async () => ({ values: [], truncated: false })),
    getAffectedSample: vi.fn(async () => ({ entities: [], truncated: false })),
}))

beforeEach(() => usePropertyDraftStore.setState({ pendingOps: [] }))


describe('PropertyOperationDialog', () => {
    it('stages a "set" op (preset key + seeded target) on confirm', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        render(
            <PropertyOperationDialog
                viewId="v1"
                mode="update"
                initialKey="owner"
                knownEntityTypes={['dataset']}
                knownLayers={[]}
                onClose={onClose}
            />,
        )

        // Key is preset and locked in update mode.
        expect(screen.getByDisplayValue('owner')).toBeInTheDocument()

        // Type a value, then stage.
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        await user.click(screen.getByRole('button', { name: /stage change/i }))

        const ops = usePropertyDraftStore.getState().pendingOps
        expect(ops).toHaveLength(1)
        expect(ops[0]).toMatchObject({
            kind: 'set', key: 'owner', value: 'alice', valueType: 'string',
        })
        expect(ops[0].predicate).toMatchObject({ kind: 'hasProperty', key: 'owner' })
        expect(onClose).toHaveBeenCalled()
    })
})
