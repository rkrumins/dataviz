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
import { render, screen } from '@testing-library/react'
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

    it('renders no bulk-select checkbox when row selection is disabled', () => {
        render(<VisualQueryBuilder {...baseProps()} />)
        expect(screen.queryByLabelText(/select filter row/i)).not.toBeInTheDocument()
    })

    it('exposes the bulk-select checkbox when enableRowSelection is set', () => {
        render(<VisualQueryBuilder {...baseProps({ enableRowSelection: true })} />)
        expect(screen.getByLabelText(/select filter row/i)).toBeInTheDocument()
    })
})
