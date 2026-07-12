/**
 * LayerHierarchyPanel — RTL tests.
 *
 * Two contracts are pinned here:
 *
 * 1. Entity lists + count badges derive from the canonical urn-keyed
 *    `assignments` prop (formData.assignments) — the legacy
 *    `layer.entityAssignments[]` array is deprecated and must be ignored.
 *
 * 2. Assigned-entity IDENTITY (name, type, children) comes from the injected
 *    `entityIndex`, NOT from the canvas store. The canvas store is empty inside
 *    the wizard, which is why assigned rows used to render as raw URN fragments
 *    and could never expand. These tests deliberately never seed a canvas.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ViewLayerConfig, LayerAssignmentEntry } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import type { WizardEntityIndex, EntityIdentity } from '@/components/views/ViewWizard/useWizardEntityIndex'

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

/** Minimal stand-in for the browser-backed index the Layer Studio injects. */
function makeIndex(
  directory: Record<string, EntityIdentity>,
  children: Record<string, string[]> = {},
): WizardEntityIndex & { loadChildren: ReturnType<typeof vi.fn> } {
  const loadChildren = vi.fn().mockResolvedValue(undefined)
  return {
    resolve: (urn: string) => directory[urn],
    childrenOf: (urn: string) => children[urn] ?? [],
    loadChildren,
    isLoading: () => false,
  }
}

function renderPanel(
  assignments: Record<string, LayerAssignmentEntry>,
  entityIndex: WizardEntityIndex = makeIndex({}),
  handlers: Partial<{
    onUnassign: () => void
    onAddLayer: (name: string) => void
    onRenameLayer: (id: string, name: string) => void
    onDeleteLayer: (id: string) => void
    onClearLayer: (id: string) => void
  }> = {},
) {
  return render(
    <LayerHierarchyPanel
      layers={layers}
      assignments={assignments}
      activeTarget={null}
      logicalNodes={fakeLogicalNodes}
      entityIndex={entityIndex}
      onSetActiveTarget={vi.fn()}
      onDrop={vi.fn()}
      onUnassign={handlers.onUnassign ?? vi.fn()}
      onReorderLayers={vi.fn()}
      onAddLayer={handlers.onAddLayer ?? vi.fn()}
      onRenameLayer={handlers.onRenameLayer ?? vi.fn()}
      onDeleteLayer={handlers.onDeleteLayer ?? vi.fn()}
      onClearLayer={handlers.onClearLayer ?? vi.fn()}
    />
  )
}

describe('LayerHierarchyPanel — derives entity lists from the canonical assignments map', () => {
  it('shows a layer-direct assignment, named from the entity index (no canvas store)', () => {
    const index = makeIndex({ 'urn:a': { name: 'Node A', type: 'domain', childCount: 0 } })
    renderPanel({ 'urn:a': { layerId: 'l1', inheritsChildren: true } }, index)

    // THE regression: the display name, not a truncated URN fragment.
    expect(screen.getByText('Node A')).toBeInTheDocument()
    expect(screen.queryByText(/urn:a/)).not.toBeInTheDocument()
    // Legacy layer.entityAssignments entry must not leak through.
    expect(screen.queryByText('urn:stale')).not.toBeInTheDocument()
  })

  it('shows a logical-node assignment nested under its group', () => {
    const index = makeIndex({ 'urn:b': { name: 'Node B', type: 'domain', childCount: 0 } })
    renderPanel({ 'urn:b': { layerId: 'l1', logicalNodeId: 'n1', inheritsChildren: true } }, index)

    expect(screen.getByText('Node B')).toBeInTheDocument()
  })

  it('ignores layer.entityAssignments entirely, even with no canonical assignments', () => {
    renderPanel({})

    expect(screen.queryByText('urn:stale')).not.toBeInTheDocument()
  })

  it('falls back to a readable fragment when the graph no longer knows the urn', () => {
    const index = makeIndex({
      'urn:gone': { name: 'gone', type: 'unknown', childCount: 0, missing: true },
    })
    renderPanel({ 'urn:gone': { layerId: 'l1', inheritsChildren: true } }, index)

    expect(screen.getByText('gone')).toBeInTheDocument()
  })
})

describe('LayerHierarchyPanel — assigned entities expand and drag', () => {
  it('expands an assigned entity and lists the children it covers', () => {
    const index = makeIndex(
      {
        'urn:parent': { name: 'Staging', type: 'root', childCount: 2 },
        'urn:c1': { name: 'Child One', type: 'node', childCount: 0 },
        'urn:c2': { name: 'Child Two', type: 'node', childCount: 0 },
      },
      { 'urn:parent': ['urn:c1', 'urn:c2'] },
    )
    renderPanel({ 'urn:parent': { layerId: 'l1', inheritsChildren: true } }, index)

    fireEvent.click(screen.getByRole('button', { name: /Expand Staging/i }))

    expect(index.loadChildren).toHaveBeenCalledWith('urn:parent')
    expect(screen.getByText('Child One')).toBeInTheDocument()
    expect(screen.getByText('Child Two')).toBeInTheDocument()
  })

  it('drags an assigned entity with the same payload the browser tree emits', () => {
    const index = makeIndex({ 'urn:a': { name: 'Node A', type: 'domain', childCount: 0 } })
    renderPanel({ 'urn:a': { layerId: 'l1', inheritsChildren: true } }, index)

    const setData = vi.fn()
    fireEvent.dragStart(screen.getByText('Node A'), {
      dataTransfer: { setData, effectAllowed: '' },
    })

    expect(setData).toHaveBeenCalledWith(
      'application/x-entity-assignment',
      expect.stringContaining('urn:a'),
    )
    const [, payload] = setData.mock.calls[0]
    expect(JSON.parse(payload)).toMatchObject({ entityId: 'urn:a', entityIds: ['urn:a'] })
  })
})

describe('LayerHierarchyPanel — in-step layer CRUD', () => {
  it('adds a layer without leaving the step', () => {
    const onAddLayer = vi.fn()
    renderPanel({}, makeIndex({}), { onAddLayer })

    fireEvent.click(screen.getByRole('button', { name: /Add layer/i }))
    const input = screen.getByPlaceholderText('Layer name…')
    fireEvent.change(input, { target: { value: 'Curated' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAddLayer).toHaveBeenCalledWith('Curated')
  })

  it('renames a layer on double-click', () => {
    const onRenameLayer = vi.fn()
    renderPanel({}, makeIndex({}), { onRenameLayer })

    fireEvent.doubleClick(screen.getByText('Layer 1'))
    const input = screen.getByDisplayValue('Layer 1')
    fireEvent.change(input, { target: { value: 'Bronze' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRenameLayer).toHaveBeenCalledWith('l1', 'Bronze')
  })

  it('warns before deleting a layer that still holds placements', () => {
    const onDeleteLayer = vi.fn()
    const index = makeIndex({ 'urn:a': { name: 'Node A', type: 'domain', childCount: 0 } })
    renderPanel({ 'urn:a': { layerId: 'l1', inheritsChildren: true } }, index, { onDeleteLayer })

    fireEvent.click(screen.getByTitle('Delete Layer 1'))
    // Confirmation first — deleting a layer also unassigns its entities.
    expect(onDeleteLayer).not.toHaveBeenCalled()
    expect(screen.getByText(/1 placement will be unassigned/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete layer' }))
    expect(onDeleteLayer).toHaveBeenCalledWith('l1')
  })

  it('deletes an empty layer immediately (nothing to lose)', () => {
    const onDeleteLayer = vi.fn()
    renderPanel({}, makeIndex({}), { onDeleteLayer })

    fireEvent.click(screen.getByTitle('Delete Layer 2'))
    expect(onDeleteLayer).toHaveBeenCalledWith('l2')
  })

  it('empties a layer in bulk without deleting it', () => {
    const onClearLayer = vi.fn()
    const index = makeIndex({
      'urn:a': { name: 'Node A', type: 'domain', childCount: 0 },
      'urn:b': { name: 'Node B', type: 'domain', childCount: 0 },
    })
    renderPanel(
      {
        'urn:a': { layerId: 'l1', inheritsChildren: true },
        'urn:b': { layerId: 'l1', inheritsChildren: true },
      },
      index,
      { onClearLayer },
    )

    fireEvent.click(screen.getByTitle('Remove all 2 placements from Layer 1'))
    expect(onClearLayer).not.toHaveBeenCalled()           // confirm first
    fireEvent.click(screen.getByRole('button', { name: 'Clear layer' }))
    expect(onClearLayer).toHaveBeenCalledWith('l1')
  })

  it('offers no bulk-clear on a layer that holds nothing', () => {
    renderPanel({}, makeIndex({}))
    expect(screen.queryByTitle(/Remove all/)).not.toBeInTheDocument()
  })
})
