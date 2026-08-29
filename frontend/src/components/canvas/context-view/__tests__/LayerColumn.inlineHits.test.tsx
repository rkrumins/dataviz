/**
 * The row-level search box, seen from the column it renders in.
 *
 * The box used to be the one browse action that could not be undone: it
 * removed a parent's loaded children from the canvas store and put the
 * server's one-hop hits in their place. It is now a scoped instance of the
 * view's one search session, and this file pins what that costs the column:
 *
 *  - the loaded children are STILL THERE (nothing is replaced), filtered
 *    locally, and the hits inside that container arrive as their own
 *    virtual rows;
 *  - the box's text and its filter come from the SESSION, not from a
 *    parallel local copy that can drift from it;
 *  - and rows are only ever drawn from a result that belongs to the query
 *    the box is actually holding.
 *
 * `inlineSearchHits.spec.ts` owns which hits get a row; this owns whether
 * the column renders them, and what a click on one does.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { QuickQuery } from '@/components/canvas/search/session/quickPredicate'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import type { SearchHit } from '@/types/search'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'


const layer: ViewLayerConfig = {
    id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
}

function node(id: string, children: HierarchyNode[] = []): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: id, data: {}, children,
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

function hit(urn: string, path: string[]): SearchHit {
    return {
        node: { urn, displayName: urn, entityType: 'dataset', properties: {} },
        ancestorPath: path.map(p => ({ urn: p, displayName: p, entityType: 'container' })),
    }
}

/** A pipeline parked on a result page — the only part of `advanced` the
 *  column reads. The template/query/inputs are inert here. */
function results(hits: SearchHit[]): PanelView {
    return {
        kind: 'results',
        template: { id: 't', name: 't' },
        inputs: {},
        query: {},
        result: {
            hits, truncated: false, candidateCount: hits.length,
            deadlineExceeded: false, elapsedMs: 1, cacheHit: false,
        },
        elapsedMs: 1,
    } as unknown as PanelView
}

/** A quick query scoped into one container — what the row box produces. */
function scopedTo(insideUrn: string, text: string): QuickQuery {
    return { text, lookIn: 'everything', match: 'substring', scope: { insideUrn, label: insideUrn } }
}

/** The session as it stands when a scoped search has ANSWERED: results are
 *  in, and they belong to the query the box is holding. */
function answered(quick: QuickQuery, hits: SearchHit[]): Partial<ViewSearchSession> {
    return { quick, advanced: stubAdvanced({ view: results(hits) }), resultMatchesQuick: true }
}

const DEFAULT_NODES = [node('P', [node('C1')])]

function renderColumn(
    over: Partial<ViewSearchSession> = {},
    { isTracing = false, nodes = DEFAULT_NODES }: { isTracing?: boolean; nodes?: HierarchyNode[] } = {},
) {
    installJsdomLayout()
    const onRevealSearchHit = vi.fn()
    const session = stubSession(over)
    const tree = (s: ViewSearchSession) => (
        <ViewSearchSessionContext.Provider value={s}>
            <LayerColumn
                layer={layer}
                nodes={nodes}
                schema={null}
                selectedNodeId={null}
                expandedNodes={new Set(['P'])}
                searchResults={new Set()}
                onSelect={vi.fn()}
                onToggle={vi.fn()}
                onContextMenu={vi.fn()}
                onDoubleClick={vi.fn()}
                traceFocusId={null}
                traceNodes={new Set()}
                traceContextSet={new Set()}
                isTracing={isTracing}
                onRevealSearchHit={onRevealSearchHit}
                // jsdom gives the scroller a 40px viewport, so the
                // virtualizer's window is a handful of rows. The capped
                // stack and its trailing row sit below it otherwise.
                overscan={200}
            />
        </ViewSearchSessionContext.Provider>
    )
    const view = render(tree(session))
    return {
        session,
        onRevealSearchHit,
        /** Re-render with a different session — how the header's × reaches
         *  a column that is already on screen. */
        withSession: (next: Partial<ViewSearchSession>) => view.rerender(tree(stubSession(next))),
    }
}

/** Click a row's magnifier, which is what mounts its search box. */
function openBox(nodeId: string) {
    const row = document.getElementById(`layer-node-${nodeId}`)
    const button = [...(row?.querySelectorAll('button') ?? [])]
        .find(b => b.getAttribute('title') === 'Search children')
    if (!button) throw new Error(`no child-search button on ${nodeId}`)
    fireEvent.click(button)
}

function boxInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search node"]')
    if (!input) throw new Error('no child-search box is open')
    return input
}

/** Type and submit. The box holds its own value and only commits on
 *  Enter or blur, so a change event alone reaches nothing. */
function submit(text: string) {
    const input = boxInput()
    fireEvent.change(input, { target: { value: text } })
    fireEvent.keyDown(input, { key: 'Enter' })
}

const hitUrns = () => [...document.querySelectorAll('[data-search-hit]')]
    .map(el => el.getAttribute('data-search-hit'))

const rowExists = (id: string) => document.getElementById(`layer-node-${id}`) !== null


describe('LayerColumn — the box drives the session', () => {
    it('clamps the session to this container when text is submitted', () => {
        const { session } = renderColumn()
        openBox('P')
        submit('orders')

        expect(session.setQuick).toHaveBeenCalledWith({
            text: 'orders',
            scope: { insideUrn: 'P', label: 'P' },
        })
    })

    it('unclamps it when the box is emptied — there is nothing to refetch', () => {
        const { session } = renderColumn({ quick: scopedTo('P', 'orders') })
        openBox('P')
        submit('')

        expect(session.setQuick).toHaveBeenCalledWith({ text: '' })
        expect(session.clearScope).toHaveBeenCalled()
    })
})


describe('LayerColumn — local filter over the loaded children', () => {
    it('keeps the children whose names match and drops the ones that do not', () => {
        renderColumn(
            { quick: scopedTo('P', 'orders') },
            { nodes: [node('P', [node('orders_daily'), node('customers')])] },
        )

        expect(rowExists('orders_daily')).toBe(true)
        expect(rowExists('customers')).toBe(false)
    })

    it('reads its text from the session, so a box on ANOTHER row never filters this one', () => {
        // The desync this replaces: the box's text used to live in a
        // per-node local map while the filter read the one session query,
        // so a second box's word filtered the first box's row.
        renderColumn(
            { quick: scopedTo('OTHER', 'zzz') },
            { nodes: [node('P', [node('orders_daily'), node('customers')])] },
        )
        openBox('P')

        expect(boxInput().value).toBe('')
        expect(rowExists('orders_daily')).toBe(true)
        expect(rowExists('customers')).toBe(true)
    })

    it('empties the box and stops filtering when the session is cleared elsewhere', () => {
        // The header chip's × calls clearScope on the session the column
        // reads; a box holding its own copy of the text would go on
        // filtering with a word the user can no longer see.
        const { withSession } = renderColumn(
            { quick: scopedTo('P', 'orders') },
            { nodes: [node('P', [node('orders_daily'), node('customers')])] },
        )
        openBox('P')
        expect(boxInput().value).toBe('orders')
        expect(rowExists('customers')).toBe(false)

        withSession({})

        expect(boxInput().value).toBe('')
        expect(rowExists('customers')).toBe(true)
    })
})


describe('LayerColumn — inline search-hit rows', () => {
    it('renders a row per hit inside the scoped container, and keeps the loaded children', () => {
        renderColumn(answered(scopedTo('P', 'C'), [hit('C1', ['P']), hit('G1', ['P', 'C2'])]))

        // Non-destructive: the loaded child still has its own row.
        expect(rowExists('C1')).toBe(true)

        // C1 is a hit AND a loaded child, so only G1 gets a hit row.
        expect(hitUrns()).toEqual(['G1'])
        // The crumb is relative to the container the reader is looking at.
        expect(document.querySelector('[data-search-hit="G1"]')?.textContent).toContain('C2')
    })

    it('reveals the hit — with its path — when the row is clicked', () => {
        const { onRevealSearchHit } = renderColumn(
            answered(scopedTo('P', 'G'), [hit('G1', ['P', 'C2'])]),
        )

        fireEvent.click(screen.getByRole('button', { name: /G1/ }))

        expect(onRevealSearchHit).toHaveBeenCalledWith(
            'G1', [
                { urn: 'P', displayName: 'P', entityType: 'container' },
                { urn: 'C2', displayName: 'C2', entityType: 'container' },
            ],
        )
    })

    it('brings back a loaded child the name filter hid, as its own hit row', () => {
        // `matchesQuick` can only read a display name. Under "everything"
        // the server also matches descriptions, tags and property values —
        // so a child it returned as a hit can be one the local pass hid.
        // Deduping against the FILTERED children is what stops that match
        // from disappearing off the canvas entirely.
        renderColumn(
            answered(scopedTo('P', 'profit'), [hit('revenue_daily', ['P'])]),
            { nodes: [node('P', [node('revenue_daily')])] },
        )

        expect(rowExists('revenue_daily')).toBe(false)
        expect(hitUrns()).toEqual(['revenue_daily'])
    })

    it('sends the rest to the panel instead of splicing 500 rows into a tree', () => {
        const many = Array.from({ length: 52 }, (_, i) => hit(`H${i}`, ['P']))
        const { session } = renderColumn(answered(scopedTo('P', 'H'), many))

        expect(hitUrns().filter(u => u !== 'more')).toHaveLength(50)

        const more = document.querySelector<HTMLElement>('[data-search-hit="more"]')
        expect(more?.textContent).toContain('+2 more')
        expect(more?.textContent).toContain('See all in panel')

        fireEvent.click(more!.querySelector('button')!)
        expect(session.openPanel).toHaveBeenCalled()
    })

    it('draws nothing from a result that belongs to a different query', () => {
        // Header search at view scope, then one character into a row box:
        // that text is below the debounce's floor, so nothing is
        // dispatched and the VIEW-WIDE result is still standing. Splicing
        // it in would put 50 foreign entities under this container, with
        // their full paths passed off as relative crumbs.
        renderColumn({
            quick: scopedTo('P', 'o'),
            advanced: stubAdvanced({ view: results([hit('FOREIGN', ['ELSEWHERE'])]) }),
            resultMatchesQuick: false,
        })

        expect(hitUrns()).toEqual([])
    })

    it('leaves a trace alone — the walk chose what is on that tree', () => {
        // The trace's tree is an overlay, and its rows are the ones the walk
        // put there. A scope set before the trace would otherwise splice in
        // hits from the browse graph underneath — exactly what the walk left
        // out. FlatTreeItem withdraws the magnifier for the same reason.
        renderColumn(
            answered(scopedTo('P', 'G'), [hit('G1', ['P', 'C2'])]),
            { isTracing: true },
        )

        expect(hitUrns()).toEqual([])
    })

    it('renders nothing extra when the session is scoped to another container', () => {
        renderColumn(answered(scopedTo('OTHER', 'G'), [hit('G1', ['OTHER'])]))

        expect(hitUrns()).toEqual([])
    })
})
