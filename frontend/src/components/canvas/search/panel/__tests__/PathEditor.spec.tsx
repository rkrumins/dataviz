/**
 * PathEditor — each end named entities or a condition, and a reach the
 * server allows for those ends. framer-motion is mocked (cached per tag)
 * so the portal menus render synchronously.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { PathPredicate } from '@/types/search'

import { PathEditor } from '../PathEditor'


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


const NAMED: PathPredicate = {
    kind: 'path', sourceUrns: ['urn:li:dataset:orders'], targetUrns: [],
    targetRefs: [{ path: ['Finance', 'revenue'] }], maxHops: 6, direction: 'outgoing',
}

function editor(value: PathPredicate) {
    const onChange = vi.fn()
    render(
        <PathEditor
            value={value}
            onChange={onChange}
            discovery={{ allKeys: [], keysByEntityType: {}, tagValues: [], getValueSamples: () => [] }}
            knownEntityTypes={['dataset', 'dashboard']}
            discoveredLayers={[]}
            isRunning={false}
        />,
    )
    return onChange
}


describe('PathEditor', () => {
    it('shows each named end, URNs and name paths alike', () => {
        editor(NAMED)
        const inputs = screen.getAllByLabelText('Entity by name path or URN')
        expect(inputs.map((i) => (i as HTMLInputElement).value)).toEqual([
            'urn:li:dataset:orders', 'Finance / revenue'])
    })

    it('turns an end into a condition, cutting the reach to what the server allows', async () => {
        const user = userEvent.setup()
        const onChange = editor(NAMED)
        await user.click(screen.getByRole('button', { name: 'To: named or a condition' }))
        await user.click(screen.getByRole('option', { name: /^Any entity where/ }))
        const next = onChange.mock.calls.at(-1)![0] as PathPredicate
        expect(next.targetWhere).toEqual({ kind: 'entityType', op: 'in', values: [] })
        expect(next.targetRefs).toBeUndefined()
        expect(next.targetUrns).toEqual([])
        expect(next.sourceUrns).toEqual(['urn:li:dataset:orders'])
        expect(next.maxHops).toBe(4)
    })

    it('caps hops at three when both ends are conditions', () => {
        editor({ kind: 'path', sourceUrns: [], targetUrns: [], maxHops: 3,
            sourceWhere: { kind: 'all' }, targetWhere: { kind: 'entityType', op: 'in', values: ['dashboard'] } })
        expect(screen.getByLabelText('Most hops')).toHaveAttribute('max', '3')
        expect(screen.getByText('dashboard')).toBeInTheDocument()
    })
})
