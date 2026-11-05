/**
 * Display → Density → Minimal: one line per entity.
 *
 * A Minimal row keeps what it carries, on the name's line: the glyph without
 * its tile, Technical's identifier after the name instead of under it, and
 * each rule chip as a colour dot named by its tooltip. Nothing is drawn below
 * the name, so the virtualizer's estimate is the row's own height and
 * Technical adds nothing to it. Spacious draws the same rows as before.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { usePreferencesStore, type CanvasDensity } from '@/store/preferences'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { DisplayRuleConfig, ViewLayerConfig } from '@/types/schema'

import { densityRowHeights, TECHNICAL_LINE_HEIGHT } from '../density'
import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

/** The real virtualizer, with the `estimateSize` it is handed kept: what a row
 *  it has never mounted contributes to the column's scroll height. */
const virtualSpy = vi.hoisted(() => ({
  estimateSize: null as ((index: number) => number) | null,
  count: 0,
}))
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  const useVirtualizer: typeof actual.useVirtualizer = (options) => {
    virtualSpy.estimateSize = options.estimateSize
    virtualSpy.count = options.count
    return actual.useVirtualizer(options)
  }
  return { ...actual, useVirtualizer }
})

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const ORDER_ID: HierarchyNode = {
  id: 'order_id', urn: 'urn:li:schemaField:order_id', typeId: 'column', name: 'Order ID',
  data: { label: 'Order ID', urn: 'urn:li:schemaField:order_id' },
  children: [], parentId: 'orders', depth: 1, entityTypeOption: 'column', tags: [],
}
const ORDERS: HierarchyNode = {
  id: 'orders', urn: 'urn:li:dataset:customer_orders', typeId: 'dataset', name: 'Customer Orders',
  data: { label: 'Customer Orders', urn: 'urn:li:dataset:customer_orders' },
  children: [ORDER_ID], depth: 0, entityTypeOption: 'dataset', tags: [],
}

const rule = (id: string, color: string): DisplayRuleConfig => ({
  id, name: id, color, style: {}, predicate: {}, enabled: true, createdAt: '2026-01-01T00:00:00Z',
})

/** A group the reader made, in Edit mode: its row carries the group's controls. */
const GROUP = {
  id: 'logical:g1', urn: 'logical:g1', typeId: 'dataset', name: 'Finance', isLogical: true,
  data: { label: 'Finance', isLogical: true }, children: [], depth: 0, entityTypeOption: 'dataset', tags: [],
} as HierarchyNode
const groupCallbacks = () => ({
  onCreateGroup: vi.fn(), onRenameGroup: vi.fn(), onDeleteGroup: vi.fn(), onPlaceInGroup: vi.fn(),
  onMoveGroup: vi.fn(), onMoveGroupContents: vi.fn(), onUngroup: vi.fn(),
})

function renderColumn(density: CanvasDensity, nodes: HierarchyNode[] = [ORDERS], extra: object = {}) {
  usePreferencesStore.setState({ canvasDensity: density })
  installJsdomLayout()
  const session = stubSession({})
  render(
    <ViewSearchSessionContext.Provider value={session as ViewSearchSession}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer} schema={null} selectedNodeId={null} expandedNodes={new Set(['orders'])} searchResults={new Set()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()} onDoubleClick={vi.fn()}
          traceFocusId={null} traceNodes={new Set()} traceContextSet={new Set()} onRevealSearchHit={vi.fn()}
          overscan={200} nodes={nodes} isTracing={false} {...extra}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

const row = (id: string) => document.getElementById(`layer-node-${id}`) as HTMLElement
const estimates = () => Array.from({ length: virtualSpy.count }, (_, i) => virtualSpy.estimateSize!(i))

beforeEach(() => {
  useDisplayRuleMatchStore.getState().clear()
  useDisplayRuleMatchStore.getState().setRuleMeta([
    rule('PII', '#ef4444'), rule('Gold', '#f59e0b'), rule('Certified', '#22c55e'), rule('Finance', '#3b82f6'),
  ])
  useDisplayRuleMatchStore.getState().applyMembership(
    ['PII', 'Gold', 'Certified', 'Finance'],
    [ORDERS.urn, ORDER_ID.urn],
    { PII: [ORDERS.urn, ORDER_ID.urn], Gold: [ORDERS.urn, ORDER_ID.urn], Certified: [ORDER_ID.urn], Finance: [ORDER_ID.urn] },
  )
})
afterEach(() => usePreferencesStore.setState({ canvasDensity: 'spacious' }))

describe('Minimal', () => {
  it('sets a Technical row on one line: the identifier beside the name, nothing beneath it', () => {
    renderColumn('minimal')
    const name = within(row('orders')).getByText('Customer Orders')
    const identifier = within(row('orders')).getByText('urn:li:dataset:customer_orders')
    // One line: the name and its identifier share a row, not a stack.
    expect(identifier.parentElement).toBe(name.parentElement)
    expect(name.parentElement).not.toHaveClass('flex-col')
    expect(name).toHaveClass('truncate')
    expect(name).not.toHaveClass('line-clamp-3')
    // The type label was the line under the name.
    expect(within(row('orders')).queryByText('dataset')).toBeNull()
    // The glyph alone: no tile painted behind it.
    expect(row('orders').querySelector('[data-entity-icon]')).not.toHaveAttribute('style')
    expect(row('orders').style.minHeight).toBe('30px')
    expect(row('order_id').style.minHeight).toBe('26px')
  })

  it('estimates each row at its own height: Technical adds no line', () => {
    renderColumn('minimal')
    const { root, child } = densityRowHeights('minimal')
    expect([root, child]).toEqual([30, 26])
    expect(estimates()).toEqual([root, child])
  })

  it('shows each rule chip as a dot, named by its tooltip, three at most', async () => {
    renderColumn('minimal')
    const pii = within(row('orders')).getByRole('img', { name: 'PII' })
    expect(within(row('orders')).getByRole('img', { name: 'Gold' })).toBeInTheDocument()
    expect(row('orders').textContent).not.toContain('PII')
    expect(pii).not.toHaveAttribute('title')
    fireEvent.mouseEnter(pii)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('PII')

    const dots = within(row('order_id')).getAllByRole('img', { name: /^(PII|Gold|Certified|Finance)$/ })
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual(['PII', 'Gold', 'Certified'])
    expect(within(row('order_id')).getByLabelText('1 more display-rule tags')).toHaveTextContent('+1')
  })

  it("keeps a group's controls beside its name, without the drop hint that would take the name's width", () => {
    renderColumn('minimal', [GROUP], groupCallbacks())
    expect(within(row('logical:g1')).getByRole('button', { name: 'Rename group Finance' })).toBeInTheDocument()
    expect(within(row('logical:g1')).queryByText('Drop entities or groups here')).toBeNull()
  })
})

describe('Spacious, for the same rows', () => {
  it('is drawn as before: the identifier and the type under the name, chips in words, the tile', () => {
    renderColumn('spacious')
    const name = within(row('orders')).getByText('Customer Orders')
    expect(name.parentElement).toHaveClass('flex-col')
    expect(name).toHaveClass('line-clamp-3')
    expect(within(row('orders')).getByText('urn:li:dataset:customer_orders').parentElement).toBe(name.parentElement)
    expect(within(row('orders')).getByText('dataset')).toBeInTheDocument()
    expect(row('orders').textContent).toContain('PII')
    expect(within(row('orders')).queryByRole('img', { name: 'PII' })).toBeNull()
    expect(row('orders').querySelector('[data-entity-icon]')).toHaveAttribute('style')
    expect(row('orders').style.minHeight).toBe('64px')
    expect(row('order_id').style.minHeight).toBe('52px')
  })

  it('still estimates the Technical line under the name', () => {
    renderColumn('spacious')
    const { root, child } = densityRowHeights('spacious')
    expect(estimates()).toEqual([root + TECHNICAL_LINE_HEIGHT, child + TECHNICAL_LINE_HEIGHT])
  })

  it("keeps the group's drop hint", () => {
    renderColumn('spacious', [GROUP], groupCallbacks())
    expect(within(row('logical:g1')).getByText('Drop entities or groups here')).toBeInTheDocument()
  })
})
