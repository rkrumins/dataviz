/**
 * Details on demand on the Graph canvas: where a click doesn't open an
 * entity's details, the selected card's toolbar offers them. Where a click
 * does, the toolbar is as it was.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { beforeAll, afterEach, describe, expect, it } from 'vitest'

import { GenericNode } from '../GenericNode'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { usePersonaStore } from '@/store/persona'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspacesStore } from '@/store/workspaces'
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
const URN = 'urn:li:dataset:customer_orders'

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

function renderCard(size: CardSize, selected = false) {
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
    selected,
    data: {
      id: 'n1',
      typeId: 'dataset',
      name: 'Customer Orders',
      description: DESCRIPTION,
      urn: URN,
      qualifiedName: QUALIFIED,
      properties: { id: 'ORD-000417' },
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


afterEach(() => {
  usePersonaStore.setState({ mode: 'technical' })
  useCanvasStore.setState({ drawerNodeId: null } as never)
  useWorkspacesStore.setState({ activeWorkspaceId: null, workspaces: [] } as never)
})

describe('GenericNode — details on demand', () => {
  it('the selected card offers its details in the Business view, and opens them', () => {
    usePersonaStore.setState({ mode: 'business' })
    renderCard('md', true)
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('n1')
  })

  it('offers nothing extra where a click opens the details', () => {
    renderCard('md', true)
    expect(screen.queryByRole('button', { name: 'Open details' })).toBeNull()
  })
})
