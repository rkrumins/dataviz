/**
 * LayerHierarchyPanel — RTL tests.
 *
 * The left "Layers & Groups" panel must derive its per-layer / per-node entity
 * lists and count badges from the canonical urn-keyed `assignments` prop
 * (formData.assignments), matching what WizardAssignmentTree reads. The legacy
 * `layer.entityAssignments[]` array is deprecated and no longer written by the
 * wizard's assignment path — the panel must ignore it even when present.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ViewLayerConfig, LayerAssignmentEntry } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import { useCanvasStore, type LineageNode } from '@/store/canvas'

vi.mock('@/hooks/useGraphHydration', () => ({
  useGraphHydration: () => ({ loadChildren: vi.fn(), loadingNodes: new Set<string>() }),
}))

import { LayerHierarchyPanel } from '../LayerHierarchyPanel'

const fakeLogicalNodes: UseLogicalNodesReturn = {
  addNode: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
  moveNode: vi.fn(),
  toggleCollapse: vi.fn(),
  nodesForLayer: (layerId: string) => (layers.find(l => l.id === layerId)?.logicalNodes ?? []),
  nodePathLabel: (_layerId: string, nodeId: string) => nodeId,
  canUndo: false,
  canRedo: false,
  undo: vi.fn(),
  redo: vi.fn(),
}

const layers: ViewLayerConfig[] = [
  {
    id: 'l1',
    name: 'Layer 1',
    entityTypes: [],
    order: 0,
    logicalNodes: [{ id: 'n1', name: 'Group 1', type: 'group' }],
    // Stale legacy data — must NOT be read by the panel.
    entityAssignments: [{ entityId: 'urn:stale', layerId: 'l1', inheritsChildren: true, priority: 1000 }],
  },
  { id: 'l2', name: 'Layer 2', entityTypes: [], order: 1 },
]

function seedCanvasNode(id: string, label: string) {
  const node = { id, position: { x: 0, y: 0 }, data: { label, urn: id, type: 'domain' } } as LineageNode
  useCanvasStore.setState({ nodes: [node], edges: [] })
}

function renderPanel(assignments: Record<string, LayerAssignmentEntry>) {
  return render(
    <LayerHierarchyPanel
      layers={layers}
      assignments={assignments}
      activeTarget={null}
      logicalNodes={fakeLogicalNodes}
      onSetActiveTarget={vi.fn()}
      onDrop={vi.fn()}
      onUnassign={vi.fn()}
      onReorderLayers={vi.fn()}
    />
  )
}

describe('LayerHierarchyPanel — derives entity lists from the canonical assignments map', () => {
  it('shows a layer-direct assignment and its count badge', () => {
    seedCanvasNode('urn:a', 'Node A')
    renderPanel({ 'urn:a': { layerId: 'l1', inheritsChildren: true } })

    expect(screen.getByText('Node A')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    // Legacy layer.entityAssignments entry must not leak through.
    expect(screen.queryByText('urn:stale')).not.toBeInTheDocument()
  })

  it('shows a logical-node assignment nested under its group', () => {
    seedCanvasNode('urn:b', 'Node B')
    renderPanel({ 'urn:b': { layerId: 'l1', logicalNodeId: 'n1', inheritsChildren: true } })

    expect(screen.getByText('Node B')).toBeInTheDocument()
    // Both the node's own badge and the layer's rolled-up total should read 1.
    expect(screen.getAllByText('1')).toHaveLength(2)
  })

  it('ignores layer.entityAssignments entirely, even with no canonical assignments', () => {
    renderPanel({})

    expect(screen.queryByText('urn:stale')).not.toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })
})
