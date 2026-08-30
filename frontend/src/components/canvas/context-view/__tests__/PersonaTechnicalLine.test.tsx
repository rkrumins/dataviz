/**
 * The Business/Technical toggle, seen from a context-view row.
 *
 * The toggle used to change nothing on this surface: the only behavioural read
 * of it anywhere asked for `data.technicalLabel`, which no mapper writes and no
 * backend field defines, so both halves resolved to the same string. This file
 * pins what Technical mode is now worth on a row:
 *
 *  - it reveals the entity's technical identity on a second line;
 *  - it falls back to the URN when `qualifiedName` is just the display name
 *    again — several loaders set it that way, and measured against the dev
 *    stack that is the majority of real nodes;
 *  - it NEVER prints a line that repeats the name already on the row;
 *  - and Business mode shows none of it.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import { usePersonaStore } from '@/store/persona'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = {
    id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
}

function node(id: string, data: Record<string, unknown>): HierarchyNode {
    return {
        id, urn: (data.urn as string) ?? id, typeId: 'dataset',
        name: (data.label as string) ?? id, data, children: [],
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

/** A qualified name that says more than the display name — the DataHub-style
 *  loaders write this shape (`<parent urn>.<name>`). */
const QUALIFIED = node('qualified', {
    label: 'Customer Orders',
    urn: 'urn:li:dataset:customer_orders',
    qualifiedName: 'snowflake.prod.sales.customer_orders',
})
/** `qualifiedName` set from the name — the Solidatus loaders' shape. The URN is
 *  then the only technical identity left to show. */
const SELF_NAMED = node('self-named', {
    label: 'Orders',
    urn: 'urn:synodic:solidatus:object:OBJ-1',
    qualifiedName: 'Orders',
})
/** Nothing technical to add beyond the name itself. */
const NOTHING = node('nothing', { label: 'urn:bare', urn: 'urn:bare' })

function renderColumn(nodes: HierarchyNode[]) {
    installJsdomLayout()
    const session = stubSession({})
    const props = {
        layer,
        schema: null,
        selectedNodeId: null,
        expandedNodes: new Set<string>(),
        searchResults: new Set<string>(),
        onSelect: vi.fn(),
        onToggle: vi.fn(),
        onContextMenu: vi.fn(),
        onDoubleClick: vi.fn(),
        traceFocusId: null,
        traceNodes: new Set<string>(),
        traceContextSet: new Set<string>(),
        onRevealSearchHit: vi.fn(),
        overscan: 200,
    }
    render(
        <ViewSearchSessionContext.Provider value={session as ViewSearchSession}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn {...props} nodes={nodes} isTracing={false} />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>,
    )
}

/** Every line of text inside one row, so "the name is there once" is provable. */
const rowText = (id: string) =>
    (document.getElementById(`layer-node-${id}`)?.textContent ?? '')

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => usePersonaStore.setState({ mode: 'business' }))

describe('Business mode', () => {
    it('shows the name and no technical identity', () => {
        renderColumn([QUALIFIED, SELF_NAMED])
        expect(screen.getByText('Customer Orders')).toBeTruthy()
        expect(screen.queryByText('snowflake.prod.sales.customer_orders')).toBeNull()
        expect(rowText('self-named')).not.toContain('urn:synodic')
    })
})

describe('Technical mode', () => {
    it('reveals the qualified name beneath the name it belongs to', () => {
        usePersonaStore.setState({ mode: 'technical' })
        renderColumn([QUALIFIED])
        expect(screen.getByText('Customer Orders')).toBeTruthy()
        expect(screen.getByText('snowflake.prod.sales.customer_orders')).toBeTruthy()
    })

    it('falls back to the URN when the qualified name is only the name again', () => {
        usePersonaStore.setState({ mode: 'technical' })
        renderColumn([SELF_NAMED])
        expect(screen.getByText('urn:synodic:solidatus:object:OBJ-1')).toBeTruthy()
        // The duplicate `qualifiedName` must not reach the row at all.
        expect(rowText('self-named').match(/Orders/g)?.length).toBe(1)
    })

    it('adds no line when the technical identity IS the name', () => {
        usePersonaStore.setState({ mode: 'technical' })
        renderColumn([NOTHING])
        expect(rowText('nothing').match(/urn:bare/g)?.length).toBe(1)
    })

    it('carries the full value in the row title so a truncated line stays readable', () => {
        usePersonaStore.setState({ mode: 'technical' })
        renderColumn([QUALIFIED])
        const line = screen.getByText('snowflake.prod.sales.customer_orders')
        expect(line.getAttribute('title')).toBe('snowflake.prod.sales.customer_orders')
    })
})
