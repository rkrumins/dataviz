/**
 * The "Top matches" surface, against props alone.
 *
 * The dropdown decides nothing: which rows it holds, whether a run is in
 * flight and what a zero means are all worked out in HeaderSearch and
 * handed down. So every spec here is either "it drew what it was given"
 * or "it called back" — the same split the header box's own tests make.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import type { AncestorRef, SearchHit } from '@/types/search'

import { SearchDropdown, type SearchDropdownProps } from '../SearchDropdown'


function anc(displayName: string): AncestorRef {
    return { urn: `urn:${displayName}`, displayName, entityType: 'container' }
}

function hit(displayName: string, ancestorPath: AncestorRef[] = []): SearchHit {
    return {
        node: {
            urn: `urn:${displayName}`, displayName, entityType: 'dataset', properties: {},
        },
        ancestorPath,
        highlights: [],
    } as unknown as SearchHit
}

function renderDropdown(over: Partial<SearchDropdownProps> = {}) {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const anchorRef = createRef<HTMLElement>() as { current: HTMLElement | null }
    anchorRef.current = anchor

    const props: SearchDropdownProps = {
        anchorRef,
        listId: 'view-search-list',
        text: 'orders',
        quick: { ...DEFAULT_QUICK, text: 'orders' },
        rows: [hit('orders')],
        activeIndex: 0,
        running: false,
        error: null,
        zero: false,
        count: 1,
        plus: false,
        recents: [],
        layerOf: () => null,
        onActivate: vi.fn(),
        onPick: vi.fn(),
        onCrumb: vi.fn(),
        onRecent: vi.fn(),
        onNarrow: vi.fn(),
        onSeeAll: vi.fn(),
        onRefine: vi.fn(),
        onRetry: vi.fn(),
        ...over,
    }
    render(<SearchDropdown {...props} />)
    return props
}


describe('SearchDropdown — the list', () => {
    it('offers ten rows and no more, whatever it was handed', () => {
        renderDropdown({
            rows: Array.from({ length: 25 }, (_, i) => hit(`table_${i}`)),
            count: 25,
        })

        expect(screen.getAllByRole('option')).toHaveLength(10)
    })

    it('marks exactly one row as the selected one', () => {
        renderDropdown({
            rows: [hit('a'), hit('b'), hit('c')], activeIndex: 1, count: 3,
        })

        const options = screen.getAllByRole('option')
        expect(options.map((o) => o.getAttribute('aria-selected')))
            .toEqual(['false', 'true', 'false'])
    })

    it('says why each row is in the list', () => {
        renderDropdown({ rows: [hit('orders_daily')], count: 1 })

        expect(screen.getByText('Name starts with')).toBeInTheDocument()
    })

    it('draws the path top-down under the name, with the layer it lives in', () => {
        renderDropdown({
            rows: [hit('customer_id', [anc('crm'), anc('public'), anc('customers')])],
            layerOf: () => 'Raw',
            count: 1,
        })

        expect(screen.getByText('Raw')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'crm' })).toBeInTheDocument()
        expect(screen.getByText('3 levels deep')).toBeInTheDocument()
    })

    it('hovering a row makes it the active one', () => {
        const props = renderDropdown({ rows: [hit('a'), hit('b')], count: 2 })

        fireEvent.mouseEnter(screen.getAllByRole('option')[1])

        expect(props.onActivate).toHaveBeenCalledWith(1)
    })

    it('clicking a row picks it', () => {
        const props = renderDropdown({ rows: [hit('a'), hit('b')], count: 2 })

        fireEvent.click(screen.getAllByRole('option')[1])

        expect(props.onPick).toHaveBeenCalledTimes(1)
        expect((props.onPick as ReturnType<typeof vi.fn>).mock.calls[0][0].node.displayName)
            .toBe('b')
    })

    // The index is into the WHOLE ancestor path, not into the crumbs that
    // survived the elision — the caller slices the path with it.
    it('clicking a crumb reports its place in the real path', () => {
        const props = renderDropdown({
            rows: [hit('col', [anc('crm'), anc('public'), anc('customers'), anc('columns')])],
            count: 1,
        })

        fireEvent.click(screen.getByRole('button', { name: 'columns' }))

        expect(props.onCrumb).toHaveBeenCalledWith(expect.anything(), 3)
    })
})


describe('SearchDropdown — the strips', () => {
    it('heads the list with the whole count, floored when the server capped it', () => {
        renderDropdown({ count: 1284, plus: true, rows: [hit('a')] })

        expect(screen.getByText('Top matches · 1,284+ in this view')).toBeInTheDocument()
    })

    it('drops the plus once the server knows the exact total', () => {
        renderDropdown({ count: 1284, plus: false, rows: [hit('a')] })

        expect(screen.getByText('Top matches · 1,284 in this view')).toBeInTheDocument()
    })

    // Ten of five hundred is not an answer, and "See all" only moves the
    // same haystack to a bigger rail. The two narrowings that actually
    // help are one click each.
    it('offers a way in when the count is more than anyone can read', () => {
        const props = renderDropdown({ count: 500, rows: [hit('a')] })

        expect(screen.getByText('Many matches — narrow:')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Names only' }))
        expect(props.onNarrow).toHaveBeenCalledWith({ lookIn: 'name' })
    })

    it('stays quiet about a count the list already answers', () => {
        renderDropdown({ count: 50, rows: [hit('a')] })

        expect(screen.queryByText('Many matches — narrow:')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Names only' })).not.toBeInTheDocument()
    })

    it('offers the whole result set at the bottom', () => {
        const props = renderDropdown({ count: 1284, rows: [hit('a')] })

        fireEvent.click(screen.getByRole('button', { name: /see all 1,284 results/i }))

        expect(props.onSeeAll).toHaveBeenCalledTimes(1)
    })

    it('offers the builder at the bottom too', () => {
        const props = renderDropdown({ count: 3, rows: [hit('a')] })

        fireEvent.click(screen.getByRole('button', { name: /refine/i }))

        expect(props.onRefine).toHaveBeenCalledTimes(1)
    })
})


describe('SearchDropdown — the states', () => {
    it('an empty box offers what was searched before, and says what it searches', () => {
        const props = renderDropdown({
            text: '', quick: DEFAULT_QUICK, rows: [], count: null,
            recents: ['orders', 'customer id'],
        })

        expect(screen.getByText('Recent in this view')).toBeInTheDocument()
        expect(screen.getByText(/every level, even containers you haven't opened/i))
            .toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'customer id' }))
        expect(props.onRecent).toHaveBeenCalledWith('customer id')
    })

    it('an empty box with no history still explains itself', () => {
        renderDropdown({ text: '', quick: DEFAULT_QUICK, rows: [], count: null })

        expect(screen.queryByText('Recent in this view')).not.toBeInTheDocument()
        expect(screen.getByText(/searches names, descriptions, tags/i)).toBeInTheDocument()
    })

    it('one character waits for the second, or for Enter', () => {
        renderDropdown({
            text: 'a', quick: { ...DEFAULT_QUICK, text: 'a' }, rows: [], count: null,
        })

        expect(screen.getByText('Keep typing — or press ↵ to search for "a"'))
            .toBeInTheDocument()
    })

    it('keeps the last answer on screen, dimmed, while the next one runs', () => {
        renderDropdown({ rows: [hit('orders')], running: true, count: 1 })

        expect(screen.getAllByRole('option')).toHaveLength(1)
        expect(screen.getByTestId('dropdown-rows').className).toContain('opacity-60')
        expect(screen.getByTestId('dropdown-running-bar')).toBeInTheDocument()
    })

    it('a real zero says so in the words that were typed, and offers a way out', () => {
        const props = renderDropdown({
            text: 'zzz', quick: { ...DEFAULT_QUICK, text: 'zzz' },
            rows: [], zero: true, count: 0,
        })

        expect(screen.getByText('Nothing in this view contains "zzz"')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Starts with' }))
        expect(props.onNarrow).toHaveBeenCalledWith({ match: 'prefix' })

        fireEvent.click(screen.getByRole('button', { name: 'Is exactly' }))
        expect(props.onNarrow).toHaveBeenCalledWith({ match: 'exact' })

        fireEvent.click(screen.getByRole('button', { name: 'Names only' }))
        expect(props.onNarrow).toHaveBeenCalledWith({ lookIn: 'name' })
    })

    it('a failed run shows the failure and keeps a way to ask again', () => {
        const props = renderDropdown({
            rows: [], error: 'Query deadline exceeded', count: null,
        })

        expect(screen.getByText('Query deadline exceeded')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /retry/i }))
        expect(props.onRetry).toHaveBeenCalledTimes(1)
    })

    it('the failure outranks whatever rows were left over', () => {
        renderDropdown({ rows: [hit('orders')], error: 'Boom', count: 1 })

        expect(screen.queryByRole('option')).not.toBeInTheDocument()
    })
})
