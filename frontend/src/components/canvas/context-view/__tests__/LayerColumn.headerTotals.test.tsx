/**
 * The layer header's totals: "Layer + known children", shown as loaded / total.
 *
 * The header used to count only the entities loaded into the column, so a
 * collapsed container with 5,000 children read as one entity, and a group
 * wrapper counted as an entity of its own. Pinned here:
 *  - `loaded` is the entities loaded into the column, nested included, group
 *    wrappers left out;
 *  - `total` adds each row's children the server reports and nobody loaded
 *    (wherever they are drawn; none once the server said there are no more
 *    pages), the anchor's remainder and the type feeds' remainder;
 *  - a feed with more and no server total makes the total a floor ('+');
 *  - a row whose type can contain a fed type adds no remainder of its own (the
 *    feed's total already counts those children);
 *  - the folded spine shows the total; the delete warning says what happens to
 *    the loaded entities.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import { useSchemaStore } from '@/store/schema'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'


const layer: ViewLayerConfig = {
    id: 'L1', name: 'Domains', entityTypes: ['domain'], order: 0, color: '#e11d48',
}

function node(id: string, data: Record<string, unknown> = {}, children: HierarchyNode[] = []): HierarchyNode {
    return {
        id, urn: id, typeId: 'domain', name: `${id} name`, data, children,
        depth: 0, entityTypeOption: 'domain', tags: [],
    }
}

type Extra = Partial<React.ComponentProps<typeof LayerColumn>>

function renderColumn(extra: Extra = {}) {
    const session = stubSession()
    const base = {
        layer,
        schema: null,
        nodes: [node('A'), node('B')],
        selectedNodeId: null,
        expandedNodes: new Set<string>(),
        searchResults: new Set<string>(),
        onSelect: vi.fn(),
        onSelectRange: vi.fn(),
        onToggle: vi.fn(),
        onContextMenu: vi.fn(),
        onDoubleClick: vi.fn(),
        traceFocusId: null,
        traceNodes: new Set<string>(),
        traceContextSet: new Set<string>(),
        isTracing: false,
        overscan: 200,
    }
    return render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn {...base} {...extra} />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>,
    )
}

const pill = () => screen.getByTitle(/in this layer/)

/** One collapsed container whose server-reported children are all unloaded. */
const bigRoot = () => [node('root', { childCount: 5000 })]

/** The ontology the column reads (the global store, outside a view context). */
const viewOntology = (entityTypes: unknown[]) =>
    useSchemaStore.setState({ schema: { ...(useSchemaStore.getState().schema ?? {}), entityTypes } } as never)

const initialSchema = useSchemaStore.getState().schema
beforeEach(() => { installJsdomLayout() })
afterEach(() => {
    vi.restoreAllMocks()
    useSchemaStore.setState({ schema: initialSchema } as never)
})


describe('LayerColumn — header totals', () => {
    it('counts the children the server reports for a collapsed row', () => {
        renderColumn({ nodes: bigRoot() })
        expect(pill().getAttribute('title')).toContain('1 loaded · 5,001 in this layer')
        expect(pill().textContent).toBe('1/5,001')
    })

    it('does not count a loaded child twice', () => {
        const kids = [node('c1'), node('c2'), node('c3')]
        renderColumn({
            nodes: [node('root', { childCount: 5000 }, kids)],
            loadedChildren: new Map([['root', ['c1', 'c2', 'c3']]]),
        })
        expect(pill().getAttribute('title')).toContain('4 loaded · 5,001 in this layer')
    })

    it('counts children loaded into other columns as loaded', () => {
        renderColumn({
            nodes: [node('root', { childCount: 5000 }, [node('c1')])],
            loadedChildren: new Map([['root', ['c1', 'c2', 'c3']]]),
        })
        expect(pill().getAttribute('title')).toContain('2 loaded · 4,999 in this layer')
    })

    it('adds nothing for a row the server said has no more pages', () => {
        renderColumn({ nodes: bigRoot(), exhaustedParents: new Map([['root', 5000]]) })
        expect(pill().getAttribute('title')).toContain('1 loaded · 1 in this layer')
    })

    it("adds the anchor's unloaded children", () => {
        renderColumn({ anchorMore: { anchorUrn: 'urn:a', remaining: 4998 } })
        expect(pill().getAttribute('title')).toContain('2 loaded · 5,000 in this layer')
    })

    it('marks the total a floor while a feed with more has no count', () => {
        renderColumn({ feedMore: { loading: false, failed: false } })
        expect(pill().getAttribute('title')).toContain('2 loaded · 2+ in this layer')
        expect(pill().getAttribute('title')).toContain('some types have no count yet')
        expect(pill().textContent).toBe('2/2+')
    })

    it("adds the type feeds' remainder", () => {
        renderColumn({ feedMore: { loading: false, failed: false, remaining: 11800 } })
        expect(pill().getAttribute('title')).toContain('2 loaded · 11,802 in this layer')
        expect(pill().textContent).toBe('2/11,802')
        expect(pill().getAttribute('title')).not.toContain('≈')
    })

    it("does not count twice the children a fed type's total already holds", () => {
        // 'domain' rows can contain only 'domain': the feed's remainder counts the
        // unloaded nested domains, so the row's own childCount adds nothing.
        viewOntology([{ id: 'domain', hierarchy: { canContain: ['domain'] } }])
        renderColumn({
            nodes: bigRoot(),
            feedMore: { loading: false, failed: false, remaining: 4999, types: ['domain'] },
        })
        expect(pill().getAttribute('title')).toContain('1 loaded · 5,000 in this layer')
    })

    it('keeps the remainder of a row that can also hold a type the column does not feed', () => {
        // Its 5,000 children may be systems, which no feed counts: keep them.
        viewOntology([{ id: 'domain', hierarchy: { canContain: ['domain', 'system'] } }])
        renderColumn({
            nodes: bigRoot(),
            feedMore: { loading: false, failed: false, remaining: 10, types: ['domain'] },
        })
        expect(pill().getAttribute('title')).toContain('1 loaded · 5,011 in this layer')
    })

    it('counts no group wrapper as an entity', () => {
        renderColumn({
            nodes: [
                { ...node('logical:g', {}, [node('a'), node('b')]), isLogical: true },
                node('c'),
            ],
            expandedNodes: new Set(['logical:g']),
        })
        expect(pill().getAttribute('title')).toMatch(/^3 entities in the tree · 3 loaded · 3 in this layer/)
    })

    it('warns on delete what happens to the loaded entities', () => {
        renderColumn({ nodes: bigRoot(), onDeleteLayer: vi.fn() })
        fireEvent.click(screen.getByTitle('Delete Domains'))
        expect(screen.getByTitle(
            "Delete — 1 entity here: hand-placed ones move to the default layer; ones placed by this layer's type rules become unassigned unless another layer claims their type",
        )).toBeInTheDocument()
    })

    it('shows the total on the folded spine', () => {
        renderColumn({ nodes: bigRoot(), isFolded: true, onFoldChange: vi.fn() })
        expect(screen.getByText('5K')).toBeInTheDocument()
    })
})
