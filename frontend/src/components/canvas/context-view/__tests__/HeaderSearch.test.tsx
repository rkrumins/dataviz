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
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import type { FindInViewState } from '@/hooks/useFindInView'
import type { SearchHit } from '@/types/search'

// The panel's "Narrow it down" suggester pulls sampled facets from the
// live backend. These specs are about the field and the panel, not about
// discovery, so it returns nothing.
vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => ({}),
    useGraphProviderContext: () => ({ providerVersion: 1 }),
}))

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
        hasMore: false, loadMore: vi.fn(), isLoadingMore: false,
        loadAll: vi.fn(), isLoadingAll: false,
        retry: vi.fn(),
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
            canvasRoots={new Map()}
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

    it('keeps a way into Advanced Search visible without opening anything', () => {
        // It used to be the only route out of this box, and moving it into
        // a panel you have to open first made the rail unreachable for
        // anyone who never opened one.
        const onOpenAdvancedSearch = vi.fn()
        renderField(makeFind(), { onOpenAdvancedSearch })
        fireEvent.click(screen.getByRole('button', { name: /Advanced Search/i }))
        expect(onOpenAdvancedSearch).toHaveBeenCalled()
    })

    it('clears the query from the field', () => {
        const find = makeFind({ text: 'revenue' })
        renderField(find)
        fireEvent.click(screen.getByLabelText('Clear search'))
        expect(find.clear).toHaveBeenCalled()
    })

    it('unwinds one layer per Escape, and consumes only its own', async () => {
        // The results panel is a role="dialog", and the canvas's
        // trace-exit handler yields the first Escape to any open dialog.
        // A panel that claims that press without consuming it would leave
        // a user unable to leave a trace while a search is open.
        const find = makeFind({ text: 'revenue', status: 'ready', hits: [] })
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        expect(screen.getByRole('dialog', { name: /search results/i })).toBeInTheDocument()

        // 1st: the panel. (It exits on an animation, so wait it out.)
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(find.clear).not.toHaveBeenCalled()
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: /search results/i })).toBeNull()
        })

        // 2nd: the query.
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(find.clear).toHaveBeenCalled()
    })

    it('lets Escape through once it has nothing of its own to close', () => {
        const outer = vi.fn()
        window.addEventListener('keydown', outer)
        try {
            renderField(makeFind())
            fireEvent.keyDown(window, { key: 'Escape' })
            expect(outer).toHaveBeenCalled()
        } finally {
            window.removeEventListener('keydown', outer)
        }
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

    it('leads with the whole view, and says how much of it is on screen', () => {
        // The old box could only count what had loaded and presented that
        // as the answer. The headline is now the view's total; the line
        // under it is what the canvas is already showing.
        renderField(withResults())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toMatch(/47\s*matches/)
        expect(panel.textContent).toContain('1 already on this canvas')
        expect(panel.textContent).toContain('showing 2 so far')
    })

    it('never leads with a total smaller than the rows it is showing', () => {
        // The local tier reads property keys and numeric values that the
        // server's indexed text doesn't carry, so it can hold rows the
        // server didn't count. "0 matches" over a list of two is worse
        // than either number alone.
        renderField(withResults({ serverTotal: 0, localCount: 2 }))
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toMatch(/2\s*matches/)
        expect(panel.textContent).not.toMatch(/0\s*matches/)
    })

    it('renders outside the field, so an overflow-hidden header cannot clip it', () => {
        // Regression pin. The header sits inside `overflow-hidden` flex
        // containers, so an absolutely-positioned panel was rendered and
        // then clipped to nothing — the search looked completely broken.
        // It is portaled to the body; if it is ever inside the field's
        // subtree again, it is clippable again.
        const { container } = renderField(withResults())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(container.contains(panel)).toBe(false)
        expect(document.body.contains(panel)).toBe(true)
    })

    it('lets the user choose how to match', () => {
        const find = withResults()
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const modes = screen.getByRole('radiogroup', { name: /how to match/i })
        fireEvent.click(within(modes).getByRole('radio', { name: 'Starts with' }))
        expect(find.setMode).toHaveBeenCalledWith('startsWith')
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


describe('HeaderFindField — a partial result set says so', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    function openWith(overrides: Partial<FindInViewState>) {
        const find = withResults(overrides)
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        return { find, panel: screen.getByRole('dialog', { name: /search results/i }) }
    }

    it('offers to load the pages it has not fetched', () => {
        const loadMore = vi.fn()
        const { panel } = openWith({ hasMore: true, loadMore, serverTotal: 47 })
        const button = within(panel).getByRole('button', { name: /load more/i })
        expect(button.textContent).toContain('45 not loaded yet')
        fireEvent.click(button)
        expect(loadMore).toHaveBeenCalled()
    })

    it('offers to complete the set without scrolling to the end of it', () => {
        // A user who wants every match — to isolate on it, or to trust
        // the roll-up counts — shouldn't have to walk a partial list to
        // find the button that completes it.
        const loadAll = vi.fn()
        const { panel } = openWith({ hasMore: true, loadAll, serverTotal: 300 })
        fireEvent.click(within(panel).getByRole('button', { name: /load all matches/i }))
        expect(loadAll).toHaveBeenCalled()
    })

    it('offers nothing to load once the set is complete', () => {
        const { panel } = openWith({ hasMore: false })
        expect(within(panel).queryByRole('button', { name: /load more/i })).toBeNull()
        expect(within(panel).queryByRole('button', { name: /load all/i })).toBeNull()
    })

    it('warns that Isolate is acting on a partial set', () => {
        // Isolate hides everything that is not a loaded match. Claiming
        // "only these" while 45 matches are unfetched would hide entities
        // the headline just counted.
        act(() => { useSearchStore.getState().setCanvasFilterMode('isolate', 'view-1') })
        const { panel } = openWith({ hasMore: true, serverTotal: 47 })
        expect(panel.textContent).toMatch(/Isolate is acting on the 2 matches loaded so far/)
    })

    it('says nothing about it in Highlight mode, which hides nothing', () => {
        act(() => { useSearchStore.getState().setCanvasFilterMode('highlight', 'view-1') })
        const { panel } = openWith({ hasMore: true, serverTotal: 47 })
        expect(panel.textContent).not.toMatch(/acting on the/)
    })

    it('says nothing once every page is loaded', () => {
        act(() => { useSearchStore.getState().setCanvasFilterMode('isolate', 'view-1') })
        const { panel } = openWith({ hasMore: false })
        expect(panel.textContent).not.toMatch(/acting on the/)
    })
})


describe('HeaderFindField — starting from nothing', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('opens on focus with nothing typed, and says what it will search', () => {
        renderField(makeFind())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toMatch(/at any depth/i)
        expect(panel.textContent).toMatch(/Data Landscape/)
    })

    it('offers this view\'s recent searches instead of a blank box', () => {
        act(() => {
            useSearchStore.getState().addRecent({
                viewId: 'view-1',
                predicate: { kind: 'tag', op: 'hasAny', values: ['PII'] },
                label: 'tag:PII',
            })
        })
        const find = makeFind()
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).toContain('Recent in this view')

        fireEvent.click(within(panel).getByText('tag:PII'))
        expect(find.setText).toHaveBeenCalledWith('tag:PII')
    })

    it('does not offer another view\'s recent searches', () => {
        act(() => {
            useSearchStore.getState().addRecent({
                viewId: 'other-view',
                predicate: { kind: 'tag', op: 'hasAny', values: ['GDPR'] },
                label: 'tag:GDPR',
            })
        })
        renderField(makeFind())
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        const panel = screen.getByRole('dialog', { name: /search results/i })
        expect(panel.textContent).not.toContain('tag:GDPR')
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

/**
 * Browsing hundreds of results.
 *
 * Reported: a term that genuinely appears hundreds of times has to stay
 * browsable — paginated, showing each hit's path, grouped under the
 * top-level node the user actually sees on the canvas.
 */
describe('HeaderFindField — browsing a large result set', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    const ROOTS = new Map([
        ['urn:snowflake', {
            urn: 'urn:snowflake', id: 'urn:snowflake', displayName: 'Snowflake',
            entityType: 'container', layerName: 'Warehouse', layerColor: '#0af',
        }],
        ['urn:commerce', {
            urn: 'urn:commerce', id: 'urn:commerce', displayName: 'Commerce',
            entityType: 'container', layerName: 'Source', layerColor: '#fa0',
        }],
    ])

    function deepHit(urn: string, rootUrn: string): SearchHit {
        return {
            node: { urn, entityType: 'dataset', displayName: urn, properties: {} },
            ancestorPath: [
                { urn: rootUrn, displayName: rootUrn, entityType: 'container' },
                { urn: 'urn:gold', displayName: 'GOLD', entityType: 'container' },
            ],
        } as SearchHit
    }

    function openWithHits(hits: SearchHit[], overrides: Partial<FindInViewState> = {}) {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: hits.map((h) => h.node.urn!),
            queryHash: 'find:contains:everything:customer',
            source: 'quick',
        })
        renderField(
            makeFind({
                text: 'customer', status: 'ready', hits,
                localCount: hits.length, serverTotal: hits.length,
                ...overrides,
            }),
            { canvasRoots: ROOTS },
        )
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        return screen.getByRole('dialog', { name: /search results/i })
    }

    it('groups results under the top-level node, with its layer', () => {
        const panel = openWithHits([
            deepHit('urn:h1', 'urn:snowflake'),
            deepHit('urn:h2', 'urn:snowflake'),
            deepHit('urn:h3', 'urn:commerce'),
        ])
        expect(within(panel).getByText('Snowflake')).toBeInTheDocument()
        expect(within(panel).getByText('Warehouse')).toBeInTheDocument()
        expect(within(panel).getByText('Commerce')).toBeInTheDocument()
        expect(within(panel).getByText('Source')).toBeInTheDocument()
    })

    it('keeps the grouping at 500 results instead of collapsing to a flat list', () => {
        // The old browser dropped grouping above 200 hits — exactly when
        // it carries the most signal.
        const many: SearchHit[] = []
        for (let i = 0; i < 500; i++) {
            many.push(deepHit(`urn:h${i}`, i % 2 ? 'urn:commerce' : 'urn:snowflake'))
        }
        const panel = openWithHits(many)
        expect(within(panel).getByText('Snowflake')).toBeInTheDocument()
        expect(within(panel).getByText('Commerce')).toBeInTheDocument()
        // Each group reports its own size, so the header answers the
        // question without opening 250 rows.
        expect(within(panel).getAllByText('250')).toHaveLength(2)
    })

    it('drops the group name from each row breadcrumb', () => {
        const panel = openWithHits([deepHit('urn:h1', 'urn:snowflake')])
        // One group, so no header — and the full path is kept.
        expect(within(panel).getAllByText('GOLD').length).toBeGreaterThan(0)
    })
})


/**
 * A failing server tier must not take the local one down with it.
 *
 * Reported as "I don't have the previous highlight feature and nothing
 * happens": MatchBar hides the stepper and the Highlight / Isolate /
 * Exclude cluster on ANY error, which is right for the Advanced rail and
 * wrong here, where local matches survive by design.
 */
describe('HeaderFindField — a partial server failure', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    function openFailed() {
        const find = withResults({
            status: 'error',
            errorMessage: 'API Error 500: {"detail":"Internal Server Error"}',
            serverTotal: null,
        })
        renderField(find)
        fireEvent.focus(screen.getByPlaceholderText('Find anything in this view…'))
        return { find, panel: screen.getByRole('dialog', { name: /search results/i }) }
    }

    it('keeps Highlight / Isolate / Exclude usable on the matches it has', () => {
        const { panel } = openFailed()
        expect(within(panel).getByRole('radio', { name: 'Isolate' })).toBeInTheDocument()
        expect(within(panel).getByRole('radio', { name: 'Exclude' })).toBeInTheDocument()
        // …and the stepper, which is the only way to walk matches that
        // are several levels deep.
        expect(within(panel).getByRole('button', { name: /next match/i })).toBeInTheDocument()
    })

    it('says what still works instead of printing the transport error', () => {
        const { panel } = openFailed()
        expect(panel.textContent).toMatch(/couldn.t search the rest/i)
        expect(panel.textContent).toMatch(/already on this canvas/i)
        // The raw JSON body never reaches the user.
        expect(panel.textContent).not.toContain('{"detail"')
        expect(panel.textContent).not.toMatch(/API Error 500/)
    })

    it('offers a retry that re-runs the server tier', () => {
        const { find, panel } = openFailed()
        fireEvent.click(within(panel).getByRole('button', { name: /retry/i }))
        expect(find.retry).toHaveBeenCalled()
    })
})
