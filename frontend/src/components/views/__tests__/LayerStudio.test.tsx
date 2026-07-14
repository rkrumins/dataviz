/**
 * LayerStudio — RTL tests (Task 4: canonical view-config store).
 *
 * Assignment gestures (quick-assign / remove) must land in formData.assignments
 * (the canonical flattened urn -> layer map, same shape the canvas persists via
 * persistReferenceLayout) — NEVER inside layers[].entityAssignments (legacy).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../ViewWizard/ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'

// jsdom has no layout, so @tanstack/react-virtual (used by WizardAssignmentTree,
// rendered inside LayerStudio) would render 0 rows without a viewport + ResizeObserver.
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

// LayerStudio → LayoutStep (LAYER_COLORS) → … → `@/store/workspaces` →
// workspaceSwitchCleanup → `@/main`, which calls createRoot() at import time.
// Same stub the other store-touching suites use.
vi.mock('@/lib/queryClient', () => ({ getQueryClient: () => ({ removeQueries: vi.fn(), invalidateQueries: vi.fn() }) }))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({ getNode: vi.fn().mockResolvedValue(null) }),
}))

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:a'],
  nodes: new Map([
    ['urn:a', {
      node: { urn: 'urn:a', entityType: 'domain', displayName: 'Node A', properties: {} },
      childIds: [],
      totalChildren: 0,
      hasMore: false,
      nextCursor: null,
      loaded: true,
    }],
  ]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue(undefined),
  loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false,
  topLevelTotalCount: 1,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  loadingNodes: new Set<string>(),
}

vi.mock('@/hooks/useEntityBrowser', () => ({
  useEntityBrowser: () => fakeBrowser,
}))

// The real drag/drop hierarchy UI is covered by LayerHierarchyPanel.test.tsx.
// Here it is a stub that exposes just the CRUD callbacks so we can assert what
// the Studio commits (and that one undo restores it).
vi.mock('../LayerHierarchyPanel', () => ({
  LayerHierarchyPanel: ({ onAddLayer, onDeleteLayer, onClearLayer }: {
    onAddLayer: (name: string) => void
    onDeleteLayer: (layerId: string) => void
    onClearLayer: (layerId: string) => void
  }) => (
    <div data-testid="layer-hierarchy-panel-stub">
      <button onClick={() => onAddLayer('Curated')}>stub-add-layer</button>
      <button onClick={() => onDeleteLayer('l1')}>stub-delete-l1</button>
      <button onClick={() => onClearLayer('l1')}>stub-clear-l1</button>
    </div>
  ),
}))

import { LayerStudio } from '../LayerStudio'

const layers: ViewLayerConfig[] = [
  { id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 },
  { id: 'l2', name: 'Layer 2', entityTypes: [], order: 1 },
]

function makeFormData(overrides: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'Test view',
    description: '',
    icon: 'Layout',
    visibility: 'private',
    tags: [],
    layoutType: 'reference',
    layers,
    assignments: {},
    visibleEntityTypes: [],
    visibleRelationshipTypes: [],
    advancedFilters: [],
    isValid: true,
    ...overrides,
  }
}

describe('LayerStudio — assignment writes go to formData.assignments', () => {
  it('quick-assign updates formData.assignments and leaves layers[].entityAssignments untouched', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'l2' } })

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.assignments).toMatchObject({ 'urn:a': { layerId: 'l2' } })
    expect(call.layers.every((l: ViewLayerConfig) => !l.entityAssignments)).toBe(true)
  })

  it('remove-assignment deletes the entry from formData.assignments', () => {
    const updateFormData = vi.fn()
    const formData = makeFormData({ assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } } })
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByTitle('Remove assignment'))

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.assignments).toEqual({})
  })
})

describe('LayerStudio — in-step layer CRUD commits through the shared undo history', () => {
  it('adds a layer with a palette colour and the next order', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByText('stub-add-layer'))

    const call = updateFormData.mock.calls[0][0]
    expect(call.layers).toHaveLength(3)
    expect(call.layers[2]).toMatchObject({ name: 'Curated', order: 2 })
    expect(call.layers[2].color).toMatch(/^#/)
  })

  it('deleting a layer drops its placements in the SAME commit (one undo restores both)', () => {
    const updateFormData = vi.fn()
    const formData = makeFormData({
      assignments: {
        'urn:a': { layerId: 'l1', inheritsChildren: true },
        'urn:b': { layerId: 'l2', inheritsChildren: true },
      },
    })
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByText('stub-delete-l1'))

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    // Layer gone, its assignment gone, the other layer's assignment kept.
    expect(call.layers.map((l: ViewLayerConfig) => l.id)).toEqual(['l2'])
    expect(call.assignments).toEqual({ 'urn:b': { layerId: 'l2', inheritsChildren: true } })
  })
})

describe('LayerStudio — bulk unassign from a layer', () => {
  it('clears every placement in the layer, leaving other layers alone', () => {
    const updateFormData = vi.fn()
    const formData = makeFormData({
      assignments: {
        'urn:a': { layerId: 'l1', inheritsChildren: true },
        'urn:b': { layerId: 'l1', inheritsChildren: true },
        'urn:keep': { layerId: 'l2', inheritsChildren: true },
      },
    })
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByText('stub-clear-l1'))

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    // Layer survives; only its placements go.
    expect(call.layers.map((l: ViewLayerConfig) => l.id)).toEqual(['l1', 'l2'])
    expect(call.assignments).toEqual({ 'urn:keep': { layerId: 'l2', inheritsChildren: true } })
  })

  it('is undoable — ⌘Z puts every cleared placement back', () => {
    const updateFormData = vi.fn()
    const assignments = {
      'urn:a': { layerId: 'l1', inheritsChildren: true },
      'urn:b': { layerId: 'l1', inheritsChildren: true },
    }
    render(<LayerStudio formData={makeFormData({ assignments })} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByText('stub-clear-l1'))
    expect(updateFormData.mock.calls[0][0].assignments).toEqual({})

    // Bulk-clearing 197 placements without an undo would be a trap, so this is
    // the contract: it goes through the same history as every other mutation.
    fireEvent.keyDown(window, { key: 'z', metaKey: true })

    expect(updateFormData).toHaveBeenCalledTimes(2)
    expect(updateFormData.mock.calls[1][0].assignments).toEqual(assignments)
  })

  it('does nothing when the layer is already empty', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByText('stub-clear-l1'))

    expect(updateFormData).not.toHaveBeenCalled()
  })
})

describe('LayerStudio — Magic Map', () => {
  it('proposes a name match and applies it as ONE inheriting entry marked assignedBy=rule', async () => {
    const updateFormData = vi.fn()
    // The browser's only top-level entity is named exactly like layer "Node A".
    const formData = makeFormData({
      layers: [{ id: 'l-node-a', name: 'Node A', entityTypes: [], order: 0 }],
    })
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)

    fireEvent.click(screen.getByRole('button', { name: /Magic Map/i }))

    // Review sheet lists the suggestion before anything is applied.
    expect(await screen.findByText(/Accept all 1/i)).toBeInTheDocument()
    expect(updateFormData).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Accept all 1/i }))

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.assignments['urn:a']).toMatchObject({
      layerId: 'l-node-a',
      inheritsChildren: true,
      assignedBy: 'rule',
    })
  })
})
