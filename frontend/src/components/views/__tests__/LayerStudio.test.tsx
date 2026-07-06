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

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
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
  topLevelHasMore: false,
  topLevelTotalCount: 1,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  loadingNodes: new Set<string>(),
}

vi.mock('@/hooks/useEntityBrowser', () => ({
  useEntityBrowser: () => fakeBrowser,
}))

// Not under test here — trivial stub so LayerStudio can mount without the real
// drag/drop hierarchy UI.
vi.mock('../LayerHierarchyPanel', () => ({
  LayerHierarchyPanel: () => <div data-testid="layer-hierarchy-panel-stub" />,
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
