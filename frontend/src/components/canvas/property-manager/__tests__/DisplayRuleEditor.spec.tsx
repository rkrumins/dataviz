/**
 * DisplayRuleEditor — verifies the iteration-3 rewire onto the shared
 * VisualQueryBuilder:
 *
 *   • a seeded predicate renders as editable filter rows (the same flat
 *     builder as Advanced Search),
 *   • Save is gated until the rule has a (unique, non-empty) name,
 *   • onSave emits a well-formed DisplayRuleConfig — fresh id when the
 *     seed had none, predicate preserved (FE-only uiScope stripped).
 *
 * Data deps are mocked: discovery, the graph provider, the rule counter
 * (preview), and DynamicIcon. framer-motion is stubbed (cached per tag)
 * so the AddFilterPalette portal + controlled inputs behave.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { countRules, type RuleCount } from '@/services/ruleCounts'
import type { Predicate } from '@/types/search'

import { DisplayRuleEditor } from '../DisplayRuleEditor'


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
        allKeys: [], keysByEntityType: {}, tagValues: ['PII'],
        getValueSamples: () => [], edgeTypes: [], keysByEdgeType: {},
        getEdgeValueSamples: () => [], isInitialLoading: false, error: null,
    }),
}))

vi.mock('@/services/ruleCounts', () => ({
    countRules: vi.fn(async () => new Map()),
}))

vi.mock('@/providers/GraphProviderContext', async () => {
    // The preview only counts against the live backend.
    const { RemoteGraphProvider } = await import('@/providers/RemoteGraphProvider')
    const provider = Object.create(RemoteGraphProvider.prototype)
    return { useGraphProvider: () => provider }
})

vi.mock('@/components/ui/DynamicIcon', () => ({
    DynamicIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}))


const tagPredicate: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }

function props(over: Record<string, unknown> = {}) {
    return {
        viewId: 'view-1',
        knownEntityTypes: ['dataset'],
        knownLayers: [],
        existingNames: [],
        onSave: vi.fn(),
        onCancel: vi.fn(),
        ...over,
    }
}


describe('DisplayRuleEditor', () => {
    beforeEach(() => {
        vi.mocked(countRules).mockReset()
        vi.mocked(countRules).mockImplementation(async () => new Map())
    })

    it('renders a seeded predicate as an editable filter row', () => {
        render(
            <DisplayRuleEditor
                {...props()}
                rule={{
                    id: '', name: '', color: '#6366f1', predicate: tagPredicate,
                    enabled: true, createdAt: '2026-01-01T00:00:00Z',
                }}
            />,
        )
        // The shared ConditionRow renders the tag filter's description.
        expect(screen.getByText(/Match nodes by their assigned tags/i)).toBeInTheDocument()
    })

    it('blocks Save until a name is entered, then emits a well-formed rule', async () => {
        const user = userEvent.setup()
        const onSave = vi.fn()
        render(
            <DisplayRuleEditor
                {...props({ onSave })}
                rule={{
                    id: '', name: '', color: '#6366f1', predicate: tagPredicate,
                    enabled: true, createdAt: '2026-01-01T00:00:00Z',
                }}
            />,
        )

        const saveBtn = screen.getByRole('button', { name: /save rule|create rule/i })
        expect(saveBtn).toBeDisabled()

        await user.type(screen.getByPlaceholderText(/PII, Needs owner/i), 'PII columns')
        expect(saveBtn).toBeEnabled()

        await user.click(saveBtn)
        expect(onSave).toHaveBeenCalledTimes(1)
        const saved = onSave.mock.calls[0][0]
        expect(saved.name).toBe('PII columns')
        expect(saved.id).toBeTruthy()           // minted from empty seed id
        expect(saved.color).toBe('#6366f1')
        expect(saved.enabled).toBe(true)
        expect(saved.predicate).toEqual(tagPredicate)
    })

    it('strips the FE-only uiScope hint from descendantOf before save', async () => {
        const user = userEvent.setup()
        const onSave = vi.fn()
        const withScope = {
            kind: 'descendantOf', urns: ['urn:a'], uiScope: 'roots',
        } as unknown as Predicate
        render(
            <DisplayRuleEditor
                {...props({ onSave })}
                rule={{
                    id: 'r1', name: 'Seeded', color: '#06b6d4', predicate: withScope,
                    enabled: true, createdAt: '2026-01-01T00:00:00Z',
                }}
            />,
        )
        await user.click(screen.getByRole('button', { name: /save rule|create rule/i }))
        const saved = onSave.mock.calls[0][0]
        expect(saved.predicate).toEqual({ kind: 'descendantOf', urns: ['urn:a'] })
        expect('uiScope' in saved.predicate).toBe(false)
    })

    it('previews the exact count, showing what it has found while it counts', async () => {
        let finish: (counts: Map<string, RuleCount>) => void = () => {}
        vi.mocked(countRules).mockImplementation((_p, viewId, rules, opts) => {
            expect(viewId).toBe('view-1')
            expect(rules).toEqual([{ id: 'preview', predicate: tagPredicate }])
            opts?.onUpdate?.(new Map([['preview', { count: 1200, complete: false, percent: 30 }]]))
            return new Promise((resolve) => { finish = resolve })
        })
        render(
            <DisplayRuleEditor
                {...props()}
                rule={{
                    id: 'r1', name: 'PII', color: '#6366f1', predicate: tagPredicate,
                    enabled: true, createdAt: '2026-01-01T00:00:00Z',
                }}
            />,
        )
        expect(await screen.findByText(/found so far/i)).toBeInTheDocument()
        expect(screen.getByText('1,200')).toBeInTheDocument()

        finish(new Map([['preview', { count: 4821, complete: true, percent: 100 }]]))
        expect(await screen.findByText(/entities will be tagged/i)).toBeInTheDocument()
        expect(screen.getByText('4,821')).toBeInTheDocument()
        expect(screen.queryByText(/found so far/i)).not.toBeInTheDocument()
    })

    it('shows why a rule cannot be counted', async () => {
        vi.mocked(countRules).mockImplementation(async () => new Map([
            ['preview', { count: 0, complete: true, percent: 100, error: 'Unknown property type' }],
        ]))
        render(
            <DisplayRuleEditor
                {...props()}
                rule={{
                    id: 'r1', name: 'PII', color: '#6366f1', predicate: tagPredicate,
                    enabled: true, createdAt: '2026-01-01T00:00:00Z',
                }}
            />,
        )
        expect(await screen.findByText('Unknown property type')).toBeInTheDocument()
    })
})
