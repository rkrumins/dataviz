/**
 * The Business/Technical toggle, seen from a graph node card.
 *
 * Technical mode's promise — the one the toggle's own tooltip makes — is that
 * it ADDS the qualified name (or the URN) under every name. On the card it
 * originally SWAPPED: the technical identity was computed in place of
 * `description`, so turning the toggle on silently deleted every card's
 * description (on `perf-load-test-solidatus`, 200,000 of 200,000 nodes carry a
 * URN that differs from the name, so it was every card).
 *
 * This file pins the split: cards with room for two lines (`md` and up) show
 * both, and only `sm` — one line's worth of room — substitutes.
 */
import { render, screen } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'

import { GenericNode } from '../GenericNode'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { usePersonaStore } from '@/store/persona'
import type { EntityTypeSchema, EntityVisualConfig } from '@/types/schema'

type CardSize = EntityVisualConfig['size']

// React Flow needs a viewport + ResizeObserver in jsdom (same stubs as
// NodePreview.test.tsx, which mounts a real GenericNode the same way).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const DESCRIPTION = 'Every order a customer has placed'
const QUALIFIED = 'snowflake.prod.sales.customer_orders'

function entityType(size: CardSize): EntityTypeSchema {
  return {
    id: 'dataset',
    name: 'Dataset',
    pluralName: 'Datasets',
    description: 'A table',
    visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size, borderStyle: 'solid', showInMinimap: true },
    fields: [],
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
    behavior: { selectable: true, draggable: true, expandable: false, traceable: false, clickAction: 'select', doubleClickAction: 'expand' },
  }
}

const nodeTypes = { generic: GenericNode }

function renderCard(size: CardSize) {
  const type = entityType(size)
  const schema: ResolvedViewSchema = {
    entityTypes: [type],
    relationshipTypes: [],
    containmentEdgeTypes: [],
    lineageEdgeTypes: [],
    rootEntityTypes: [],
  }
  const nodes: Node[] = [{
    id: 'n1',
    type: 'generic',
    position: { x: 0, y: 0 },
    data: {
      id: 'n1',
      typeId: 'dataset',
      name: 'Customer Orders',
      description: DESCRIPTION,
      urn: 'urn:li:dataset:customer_orders',
      qualifiedName: QUALIFIED,
    },
  }]
  render(
    <StaticViewSchemaProvider schema={schema}>
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} proOptions={{ hideAttribution: true }} />
      </ReactFlowProvider>
    </StaticViewSchemaProvider>,
  )
}

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => usePersonaStore.setState({ mode: 'business' }))

describe('GenericNode, Business mode', () => {
  it('shows the description and no technical identity', () => {
    renderCard('md')
    expect(screen.getByText(DESCRIPTION)).toBeTruthy()
    expect(screen.queryByText(QUALIFIED)).toBeNull()
  })
})

describe('GenericNode, Technical mode', () => {
  it('REVEALS the qualified name without taking the description away', () => {
    usePersonaStore.setState({ mode: 'technical' })
    renderCard('md')
    expect(screen.getByText('Customer Orders')).toBeTruthy()
    expect(screen.getByText(DESCRIPTION)).toBeTruthy()
    expect(screen.getByText(QUALIFIED)).toBeTruthy()
  })

  it('head-truncates the technical line, as the context-view row does', () => {
    usePersonaStore.setState({ mode: 'technical' })
    renderCard('md')
    const line = screen.getByText(QUALIFIED)
    expect(line.style.direction).toBe('rtl')
    expect(line.getAttribute('title')).toBe(QUALIFIED)
  })

  it('substitutes on a `sm` card, which has room for one line only', () => {
    usePersonaStore.setState({ mode: 'technical' })
    renderCard('sm')
    expect(screen.getByText(QUALIFIED)).toBeTruthy()
    expect(screen.queryByText(DESCRIPTION)).toBeNull()
  })
})
