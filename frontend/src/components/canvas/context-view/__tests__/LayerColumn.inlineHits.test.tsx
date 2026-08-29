/**
 * The row-level search box, seen from the column it renders in.
 *
 * The box used to be the one browse action that could not be undone: it
 * removed a parent's loaded children from the canvas store and put the
 * server's one-hop hits in their place. It is now a scoped instance of the
 * view's one search session, and this file pins the two halves of that:
 *
 *  - the loaded children are STILL THERE while the scoped search has
 *    results (nothing was replaced), and
 *  - the hits inside that container arrive as their own rows — virtual
 *    ones, carrying the hit, never written to the store.
 *
 * `inlineSearchHits.spec.ts` owns which hits get a row; this owns whether
 * the column actually renders them, and what a click on one does.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
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

function renderColumn(
    over: Parameters<typeof stubSession>[0] = {},
    { isTracing = false }: { isTracing?: boolean } = {},
) {
    installJsdomLayout()
    const onRevealSearchHit = vi.fn()
    const session = stubSession(over)
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <LayerColumn
                layer={layer}
                nodes={[node('P', [node('C1')])]}
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
        </ViewSearchSessionContext.Provider>,
    )
    return { session, onRevealSearchHit }
}


describe('LayerColumn — inline search-hit rows', () => {
    it('renders a row per hit inside the scoped container, and keeps the loaded children', () => {
        renderColumn({
            quick: { text: 'g', lookIn: 'everything', match: 'substring', scope: { insideUrn: 'P', label: 'P' } },
            advanced: stubAdvanced({ view: results([hit('C1', ['P']), hit('G1', ['P', 'C2'])]) }),
        })

        // Non-destructive: the loaded child still has its own row.
        expect(document.getElementById('layer-node-C1')).not.toBeNull()

        // C1 is a hit AND a loaded child, so only G1 gets a hit row.
        const hitRows = document.querySelectorAll('[data-search-hit]')
        expect(hitRows).toHaveLength(1)
        expect(hitRows[0].getAttribute('data-search-hit')).toBe('G1')
        // The crumb is relative to the container the reader is looking at.
        expect(hitRows[0].textContent).toContain('C2')
    })

    it('reveals the hit — with its path — when the row is clicked', () => {
        const { onRevealSearchHit } = renderColumn({
            quick: { text: 'g', lookIn: 'everything', match: 'substring', scope: { insideUrn: 'P', label: 'P' } },
            advanced: stubAdvanced({ view: results([hit('G1', ['P', 'C2'])]) }),
        })

        fireEvent.click(screen.getByRole('button', { name: /G1/ }))

        expect(onRevealSearchHit).toHaveBeenCalledWith(
            'G1', [
                { urn: 'P', displayName: 'P', entityType: 'container' },
                { urn: 'C2', displayName: 'C2', entityType: 'container' },
            ],
        )
    })

    it('sends the rest to the panel instead of splicing 500 rows into a tree', () => {
        const many = Array.from({ length: 52 }, (_, i) => hit(`H${i}`, ['P']))
        const { session } = renderColumn({
            quick: { text: 'h', lookIn: 'everything', match: 'substring', scope: { insideUrn: 'P', label: 'P' } },
            advanced: stubAdvanced({ view: results(many) }),
        })

        const rows = [...document.querySelectorAll('[data-search-hit]')]
        expect(rows.filter(r => r.getAttribute('data-search-hit') !== 'more')).toHaveLength(50)

        const more = document.querySelector<HTMLElement>('[data-search-hit="more"]')
        expect(more?.textContent).toContain('+2 more')
        expect(more?.textContent).toContain('See all in panel')

        fireEvent.click(more!.querySelector('button')!)
        expect(session.openPanel).toHaveBeenCalled()
    })

    it('leaves a trace alone — the walk chose what is on that tree', () => {
        // The trace's tree is an overlay, and its rows are the ones the walk
        // put there. A scope set before the trace would otherwise splice in
        // hits from the browse graph underneath — exactly what the walk left
        // out. FlatTreeItem withdraws the magnifier for the same reason.
        renderColumn({
            quick: { text: 'g', lookIn: 'everything', match: 'substring', scope: { insideUrn: 'P', label: 'P' } },
            advanced: stubAdvanced({ view: results([hit('G1', ['P', 'C2'])]) }),
        }, { isTracing: true })

        expect(document.querySelectorAll('[data-search-hit]')).toHaveLength(0)
    })

    it('renders nothing extra when the session is scoped to another container', () => {
        renderColumn({
            quick: { text: 'g', lookIn: 'everything', match: 'substring', scope: { insideUrn: 'OTHER', label: 'other' } },
            advanced: stubAdvanced({ view: results([hit('G1', ['OTHER'])]) }),
        })

        expect(document.querySelectorAll('[data-search-hit]')).toHaveLength(0)
    })
})
