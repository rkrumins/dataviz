/**
 * HeaderFindField — the Context View's search box.
 *
 * The behaviours pinned here are the ones the old box got wrong: it told
 * users it could only search "visible entities", it exposed no way to say
 * what a word should match, and escalating to Advanced Search threw the
 * query away. It also pins the canvas controls the box now owns —
 * Highlight / Isolate / Exclude reach the store from here, not only from
 * the Advanced rail.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import type { FindInViewState } from '@/hooks/useFindInView'
import type { SearchHit } from '@/types/search'

import { HeaderFindField } from '../header/HeaderSearch'


function hit(urn: string, displayName: string, parent?: string): SearchHit {
    return {
        node: { urn, entityType: 'dataset', displayName, properties: {} },
        ancestorPath: parent
            ? [{ urn: `urn:${parent}`, displayName: parent, entityType: 'container' }]
            : [],
    }
}

function makeFind(overrides: Partial<FindInViewState> = {}): FindInViewState {
    return {
        text: '', mode: 'contains', scope: 'everything',
        setText: vi.fn(), setMode: vi.fn(), setScope: vi.fn(), clear: vi.fn(),
        hits: [], localCount: 0, serverTotal: null,
        status: 'idle', errorMessage: null,
        truncated: false, deadlineExceeded: false, elapsedMs: null,
        isStale: false,
        compiled: {
            predicate: null, recognized: [], fallbackText: [], usedOperators: false,
        },
        ...overrides,
    }
}

function renderField(
    find: FindInViewState,
    props: Partial<React.ComponentProps<typeof HeaderFindField>> = {},
) {
    return render(
        <HeaderFindField
            find={find}
            viewId="view-1"
            viewName="Data Landscape"
            onReveal={vi.fn()}
            {...props}
        />,
    )
}

/** A typed query with results, published to the store the way
 *  useFindInView publishes — the panel reads counts and the stepper
 *  from there. */
function withResults(overrides: Partial<FindInViewState> = {}) {
    useSearchStore.getState().setResult({
        viewId: 'view-1',
        matchUrns: ['urn:a', 'urn:b'],
        queryHash: 'find:contains:everything:revenue',
        source: 'quick',
    })
    return makeFind({
        text: 'revenue',
        status: 'ready',
        hits: [hit('urn:a', 'revenue_gross', 'Orders'), hit('urn:b', 'revenue_net', 'Orders')],
        localCount: 1,
        serverTotal: 47,
        elapsedMs: 240,
        ...overrides,
    })
}


describe('HeaderFindField — the field', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('does not claim to search only what is visible', () => {
        const { container } = renderField(makeFind())
        expect(container.textContent ?? '').not.toMatch(/visible/i)
        expect(screen.getByPlaceholderText('Find anything in this view…'))
            .toBeInTheDocument()
    })

    it('reports typing to the find state', () => {
        const find = makeFind()
        renderField(find)
        fireEvent.change(screen.getByPlaceholderText('Find anything in this view…'), {
            target: { value: 'orders' },
        })
        expect(find.setText).toHaveBeenCalledWith('orders')
    })

    it('offers the three match modes and reports the choice', () => {
        const find = makeFind({ text: 'revenue' })
        renderField(find)
        fireEvent.click(screen.getByRole('button', { name: /match mode/i }))
        fireEvent.click(screen.getByRole('option', { name: /starts with/i }))
        expect(find.setMode).toHaveBeenCalledWith('startsWith')
    })

    it('clears the query from the field', () => {
        const find = makeFind({ text: 'revenue' })
        renderField(find)
        fireEvent.click(screen.getByLabelText('Clear search'))
        expect(find.clear).toHaveBeenCalled()
    })

    it('focuses the field on Cmd+F', () => {
        renderField(makeFind())
        const input = screen.getByPlaceholderText('Find anything in this view…')
        expect(document.activeElement).not.toBe(input)
        fireEvent.keyDown(window, { key: 'f', metaKey: true })
        expect(document.activeElement).toBe(input)
    })
})


describe('HeaderFindField — the results panel', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('stays closed until there is a query', () => {
        renderField(makeFind())
        expect(screen.queryByRole('dialog', { name: /search results/i })).toBeNull()
    })

    it('opens on focus once a query exists', () => {
        renderField(withResults())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        expect(screen.getByRole('dialog', { name: /search results/i }))
            .toBeInTheDocument()
    })

    it('reports both counts rather than collapsing them into one', () => {
        renderField(withResults())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toContain('1 on this canvas')
        expect(panel.textContent).toContain('47 in this view')
    })

    it('lets the user change which fields are searched', () => {
        const find = withResults()
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        fireEvent.click(within(panel).getByRole('radio', { name: 'Tags' }))
        expect(find.setScope).toHaveBeenCalledWith('tags')
    })

    it('drives the canvas filter mode — isolate and exclude, from the header', () => {
        renderField(withResults())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const modes = screen.getByRole('radiogroup', { name: /canvas filter mode/i })

        fireEvent.click(within(modes).getByRole('radio', { name: /isolate/i }))
        expect(useSearchStore.getState().canvasFilterMode).toBe('isolate')

        fireEvent.click(within(modes).getByRole('radio', { name: /exclude/i }))
        expect(useSearchStore.getState().canvasFilterMode).toBe('hide')
    })

    it('reads an operator query back in plain English', () => {
        renderField(withResults({
            text: 'revenue tag:PII',
            compiled: {
                predicate: {
                    kind: 'group', op: 'and',
                    children: [
                        { kind: 'text', value: 'revenue', target: 'name', match: 'substring' },
                        { kind: 'tag', op: 'hasAny', values: ['PII'] },
                    ],
                },
                recognized: ['tag:PII'],
                fallbackText: ['revenue'],
                usedOperators: true,
            },
        }))
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toMatch(/PII/)
    })

    it('offers a way out when nothing matched', () => {
        renderField(makeFind({
            text: 'zzz', status: 'ready', hits: [], scope: 'tags',
        }))
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toContain('No match for “zzz” in Data Landscape')
        // The specific widening move, not just the word — the scope chip
        // also says "Everything".
        expect(within(panel).getByRole('button', { name: /Look in everything/i }))
            .toBeInTheDocument()
    })
})


describe('HeaderFindField — handing over to Advanced Search', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('carries the typed query across', () => {
        const onOpenAdvancedSearch = vi.fn()
        renderField(withResults({ text: '  revenue  ' }), { onOpenAdvancedSearch })
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        fireEvent.click(screen.getByText('Open in Advanced Search'))
        expect(onOpenAdvancedSearch).toHaveBeenCalledWith({ text: 'revenue' })
    })

    it('escalates on Cmd+Enter without leaving the field', () => {
        const onOpenAdvancedSearch = vi.fn()
        renderField(withResults(), { onOpenAdvancedSearch })
        fireEvent.keyDown(screen.getByPlaceholderText('Find anything in this view…'), {
            key: 'Enter', metaKey: true,
        })
        expect(onOpenAdvancedSearch).toHaveBeenCalledWith({ text: 'revenue' })
    })
})
