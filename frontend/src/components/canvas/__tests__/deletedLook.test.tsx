/**
 * A deleted entity reads the same on every layout: its name struck through and a Deleted chip,
 * whether the deletion is saved to the draft or not saved yet. On the hierarchy, the row's change
 * ring keeps its own colour (an inline type colour used to paint over it).
 */
import { render, screen, within } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { GenericNode } from '../nodes/GenericNode'
import { HierarchyContainer } from '../HierarchyCanvas'
import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { LayerColumn } from '../context-view/LayerColumn'
import type { HierarchyNode as RowNode } from '../context-view/types'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { buildChangeSet } from '@/features/versioning/model/changeModel'
import { synthesizeGhostNode } from '@/features/versioning/canvas/deletionGhosts'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { EntityTypeSchema, ViewLayerConfig } from '@/types/schema'
import type { HierarchyNode } from '@/types/hierarchy'

// React Flow needs a viewport + ResizeObserver in jsdom (as GenericNode.toolbar.test.tsx).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const URN = 'urn:li:dataset:orders'
const dataset: EntityTypeSchema = {
  id: 'dataset', name: 'Dataset', pluralName: 'Datasets', description: '',
  visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: 0, canContain: ['column'], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
}
const schema: ResolvedViewSchema = {
  entityTypes: [dataset], relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: [],
}

const stageDelete = () => useStagedChangesStore.setState({ changes: [{
  id: 'd', type: 'delete_entity', targetId: URN, targetUrn: URN, summary: "Delete 'Orders'", timestamp: 0,
  before: { node: { id: URN } }, after: null,
} as never] })

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [] })
  useBranchStore.setState({ activeChangeSet: null, committedDiffHidden: false })
})

describe('the graph layout’s card', () => {
  function renderCard(data: Record<string, unknown> = { id: URN, typeId: 'dataset', name: 'Orders', urn: URN }) {
    const nodes: Node[] = [{ id: URN, type: 'generic', position: { x: 0, y: 0 }, data }]
    render(
      <StaticViewSchemaProvider schema={schema}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={[]} nodeTypes={{ generic: GenericNode }} proOptions={{ hideAttribution: true }} />
        </ReactFlowProvider>
      </StaticViewSchemaProvider>,
    )
  }

  // React Flow keeps a node hidden until it is measured, which jsdom never does — and a hidden
  // heading has no accessible name — so the title is found by its text.
  const heading = () => screen.getByText('Orders', { selector: 'h3' })

  it('strikes a deleted entity’s name and says Deleted', () => {
    stageDelete()
    renderCard()
    expect(heading()).toHaveClass('line-through')
    expect(screen.getByText('Deleted')).toBeInTheDocument()
  })

  it('leaves a live one alone', () => {
    renderCard()
    expect(heading()).not.toHaveClass('line-through')
    expect(screen.queryByText('Deleted')).toBeNull()
  })

  it('draws a deletion saved to the draft as it was, with no count of what it held', () => {
    const removed = { entityId: URN, urn: URN, kind: 'node', status: 'removed', label: 'Orders',
      origin: { source: 'branch', branchId: 'b' }, before: { displayName: 'Orders', entityType: 'dataset' } } as const
    useBranchStore.setState({ activeChangeSet: buildChangeSet([removed]) })
    const ghost = synthesizeGhostNode(removed)
    renderCard({ ...ghost.data, id: URN, typeId: 'dataset' })
    expect(heading()).toHaveClass('line-through')
    expect(screen.queryByText('0')).toBeNull()
  })
})

describe('the Context View’s row', () => {
  const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }
  const ORDERS: RowNode = {
    id: 'orders', urn: URN, typeId: 'dataset', name: 'Orders',
    data: { label: 'Orders', urn: URN }, children: [], depth: 0, entityTypeOption: 'dataset', tags: [],
  }

  it('strikes the name, says Deleted, and offers nothing to add inside', () => {
    stageDelete()
    installJsdomLayout()
    const session = stubSession({})
    render(
      <ViewSearchSessionContext.Provider value={session as ViewSearchSession}>
        <ViewRowSearchContext.Provider value={session.rowSearch}>
          <LayerColumn
            layer={layer} schema={null} selectedNodeId={null} expandedNodes={new Set()} searchResults={new Set()}
            onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()} onDoubleClick={vi.fn()}
            traceFocusId={null} traceNodes={new Set()} traceContextSet={new Set()} onRevealSearchHit={vi.fn()}
            overscan={200} nodes={[ORDERS]} isTracing={false} onAddChild={vi.fn()}
          />
        </ViewRowSearchContext.Provider>
      </ViewSearchSessionContext.Provider>,
    )
    const row = document.getElementById('layer-node-orders') as HTMLElement
    expect(within(row).getByText('Orders')).toHaveClass('line-through')
    expect(within(row).getByText('Deleted')).toBeInTheDocument()
    expect(within(row).queryByTitle('Add child entity')).toBeNull()
  })
})

describe('the hierarchy’s row', () => {
  const node: HierarchyNode = {
    id: URN, typeId: 'dataset', name: 'Orders', data: { urn: URN, label: 'Orders' }, children: [],
    depth: 0, urn: URN, entityTypeOption: 'dataset', tags: [],
  }
  const renderRow = () => render(
    <HierarchyContainer node={node} schema={{ entityTypes: [dataset] } as never} selectedNodeId={null}
      expandedNodes={new Set()} searchResults={[]} onSelect={vi.fn()} onToggle={vi.fn()} />,
  )
  const card = () => screen.getByRole('heading', { name: 'Orders' }).closest('[style*="border-left-width"]') as HTMLElement

  it('strikes a deleted entity and lets its rose ring show', () => {
    stageDelete()
    renderRow()
    expect(screen.getByRole('heading', { name: 'Orders' })).toHaveClass('line-through')
    expect(screen.getByText('Deleted')).toBeInTheDocument()
    expect(card().className).toContain('ring-rose-500/70')
    expect(card().style.getPropertyValue('--tw-ring-color')).toBe('')
  })

  it('keeps the type colour for a row with no change', () => {
    renderRow()
    expect(card().style.getPropertyValue('--tw-ring-color')).toBe('#6366f1')
  })
})

describe('Restore on a deletion saved to the draft', () => {
  const ghost: HierarchyNode = {
    id: 'urn:gone', typeId: 'dataset', name: 'Gone', data: { urn: 'urn:gone', label: 'Gone', isGhost: true },
    children: [], depth: 0, urn: 'urn:gone', entityTypeOption: 'dataset', tags: [],
  }

  it('is offered on the hierarchy row where the canvas can be edited, and brings it back', () => {
    const onRestore = vi.fn()
    render(<HierarchyContainer node={ghost} schema={{ entityTypes: [dataset] } as never} selectedNodeId={null}
      expandedNodes={new Set()} searchResults={[]} onSelect={vi.fn()} onToggle={vi.fn()} onRestore={onRestore} />)
    screen.getByRole('button', { name: 'Restore Gone' }).click()
    expect(onRestore).toHaveBeenCalledWith('urn:gone')
  })

  it('is not offered where the canvas cannot be edited', () => {
    render(<HierarchyContainer node={ghost} schema={{ entityTypes: [dataset] } as never} selectedNodeId={null}
      expandedNodes={new Set()} searchResults={[]} onSelect={vi.fn()} onToggle={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Restore Gone' })).toBeNull()
  })
})
