/**
 * The View Wizard's layer panel speaks the canvas's language: the same group actions (delete asks
 * first and says what happens; move / move everything / ungroup call the shared operations), and an
 * assigned entity that has a parent in the data says so — "Placed · Part of …" — as on the canvas.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ViewLayerConfig, LayerAssignmentEntry } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import type { WizardEntityIndex, EntityIdentity } from '@/components/views/ViewWizard/useWizardEntityIndex'
import { LayerHierarchyPanel } from '../LayerHierarchyPanel'
import { PlacementPathsContext } from '../placementPathsContext'

const layers: ViewLayerConfig[] = [{
  id: 'l1', name: 'Apps', entityTypes: [], order: 0,
  logicalNodes: [{ id: 'g1', name: 'Critical', type: 'group' }, { id: 'g2', name: 'Archive', type: 'group' }],
} as ViewLayerConfig]

const logicalNodes = (): UseLogicalNodesReturn => ({
  addNode: vi.fn(), renameNode: vi.fn(), deleteNode: vi.fn(), moveNode: vi.fn(),
  ungroupNode: vi.fn(), moveContents: vi.fn(), toggleCollapse: vi.fn(),
  nodesForLayer: (id: string) => layers.find(l => l.id === id)?.logicalNodes ?? [],
  nodePathLabel: (_l: string, id: string) => id,
  canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn(),
})

const index = (dir: Record<string, EntityIdentity>): WizardEntityIndex => ({
  resolve: (u: string) => dir[u], childrenOf: () => [], loadChildren: vi.fn().mockResolvedValue(undefined),
  loadMoreChildren: vi.fn().mockResolvedValue(undefined), isLoading: () => false,
  childPageState: () => ({ hasMore: undefined, failed: false }),
})

function renderPanel(ln: UseLogicalNodesReturn, assignments: Record<string, LayerAssignmentEntry> = {},
                     paths = new Map()) {
  return render(
    <PlacementPathsContext.Provider value={paths}>
      <LayerHierarchyPanel
        layers={layers} assignments={assignments} activeTarget={null} logicalNodes={ln}
        entityIndex={index({ 'urn:appA': { name: 'App A', type: 'app', childCount: 0 } })}
        onSetActiveTarget={vi.fn()} onDrop={vi.fn()} onUnassign={vi.fn()} onReorderLayers={vi.fn()}
        onAddLayer={vi.fn()} onRenameLayer={vi.fn()} onDeleteLayer={vi.fn()} onClearLayer={vi.fn()}
      />
    </PlacementPathsContext.Provider>,
  )
}

describe('View Wizard ↔ canvas: one set of group actions, one placement language', () => {
  it('delete asks first and says the entities stay in the layer', () => {
    const ln = logicalNodes()
    renderPanel(ln)
    fireEvent.click(screen.getByLabelText('Delete group Critical'))
    expect(ln.deleteNode).not.toHaveBeenCalled()
    expect(screen.getByText(/Its entities stay in this layer, ungrouped/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(ln.deleteNode).toHaveBeenCalledWith('l1', 'g1')
  })

  it('ungroup, and move everything into another group, call the shared operations', () => {
    const ln = logicalNodes()
    renderPanel(ln)
    fireEvent.click(screen.getByLabelText('Ungroup Critical'))
    expect(ln.ungroupNode).toHaveBeenCalledWith('l1', 'g1')
    fireEvent.click(screen.getByLabelText('Move the contents of Critical'))
    fireEvent.change(screen.getByLabelText('Move everything in Critical into'), { target: { value: 'g2' } })
    expect(ln.moveContents).toHaveBeenCalledWith('l1', 'g1', 'g2')
  })

  it('a group can move to the top of the layer, and never into itself', () => {
    const ln = logicalNodes()
    renderPanel(ln)
    fireEvent.click(screen.getByLabelText('Move group Critical'))
    const select = screen.getByLabelText('Move group Critical into') as HTMLSelectElement
    expect([...select.options].map(o => o.text)).toEqual(['Move “Critical” into…', 'Top level of Apps', 'Archive'])
    fireEvent.change(select, { target: { value: '__top__' } })
    expect(ln.moveNode).toHaveBeenCalledWith('l1', 'g1', undefined)
  })

  it('an assigned entity with a parent in the data shows "Placed · Part of …"', () => {
    renderPanel(logicalNodes(), { 'urn:appA': { layerId: 'l1', inheritsChildren: true } },
      new Map([['urn:appA', [{ urn: 'urn:dom', displayName: 'My Data Domain', entityType: 'domain' }]]]))
    expect(screen.getByText('Placed')).toBeTruthy()
    expect(screen.getByText(/Part of My Data Domain/)).toBeTruthy()
  })
})
