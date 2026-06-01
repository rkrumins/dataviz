/**
 * AddFilterPalette — verifies the two behaviours iteration 3 depends on:
 *
 *   1. The Advanced / Code-only entries (Path, Within N hops) are hidden
 *      when their handoff callback isn't wired — exactly the case in the
 *      Property Manager rule editor, which has no Advanced drawer / Code
 *      mode. The ``emit`` group entries stay so grouping still works.
 *   2. Pasting a DSL fragment emits the parsed predicates via onAddMany.
 *
 * framer-motion is mocked to plain elements so the portal popover renders
 * synchronously (its mount-time opacity/scale would otherwise hide it).
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AddFilterPalette } from '../AddFilterPalette'


vi.mock('framer-motion', () => {
    // Cache the stub per tag — a fresh forwardRef on every access makes
    // React treat each render as a new component type and remount the
    // subtree, which drops controlled-input keystrokes mid-type.
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


const baseProps = {
    counts: { entityTypes: 2, tags: 3, propertyKeys: 5, layers: 1 },
    onAdd: vi.fn(),
    onAddMany: vi.fn(),
}


describe('AddFilterPalette', () => {
    it('hides Code-only / Advanced entries when their callbacks are omitted', async () => {
        const user = userEvent.setup()
        render(<AddFilterPalette {...baseProps} />)

        await user.click(screen.getByRole('button', { name: /add filter/i }))

        // Code-only entries require onOpenCode → hidden here.
        expect(screen.queryByText(/Path from A to B/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/Within N hops of/i)).not.toBeInTheDocument()
        // Emit entries (incl. group authoring) always render.
        expect(screen.getByText(/AND group/i)).toBeInTheDocument()
        expect(screen.getByText(/Tag is/i)).toBeInTheDocument()
    })

    it('shows the Code-only entries when onOpenCode is provided', async () => {
        const user = userEvent.setup()
        render(<AddFilterPalette {...baseProps} onOpenCode={vi.fn()} />)

        await user.click(screen.getByRole('button', { name: /add filter/i }))

        expect(screen.getByText(/Path from A to B/i)).toBeInTheDocument()
        expect(screen.getByText(/Within N hops of/i)).toBeInTheDocument()
    })

    it('emits parsed predicates via onAddMany on a DSL paste', async () => {
        const user = userEvent.setup()
        const onAddMany = vi.fn()
        render(<AddFilterPalette {...baseProps} onAddMany={onAddMany} />)

        await user.click(screen.getByRole('button', { name: /add filter/i }))
        await user.type(
            screen.getByPlaceholderText(/paste DSL/i),
            'tag:PII type:dataset',
        )
        await user.click(screen.getByRole('button', { name: /Add 2 filters from DSL/i }))

        expect(onAddMany).toHaveBeenCalledTimes(1)
        const emitted = onAddMany.mock.calls[0][0]
        expect(emitted).toHaveLength(2)
        expect(emitted.map((p: { kind: string }) => p.kind).sort()).toEqual(['entityType', 'tag'])
    })
})
