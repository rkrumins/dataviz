/**
 * WizardAssignmentTree — RTL tests.
 *
 * The tree communicates assignment changes ONLY via onAssignmentChange/onBulkAssign
 * props (Task 4: canonical view-config store). It must never write to the
 * referenceModelStore directly — that store is a render cache now, not a writer.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no layout, so @tanstack/react-virtual would render 0 rows without a
// viewport + ResizeObserver (same pattern as ConflictResolver.test.tsx).
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

import { useReferenceModelStore } from '@/store/referenceModelStore'
import { WizardAssignmentTree } from '../WizardAssignmentTree'
import type { ViewLayerConfig, LayerAssignmentEntry } from '@/types/schema'

const layers: ViewLayerConfig[] = [
  { id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 },
  { id: 'l2', name: 'Layer 2', entityTypes: [], order: 1 },
]

describe('WizardAssignmentTree', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assignSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let removeSpy: any

  beforeEach(() => {
    assignSpy = vi.spyOn(useReferenceModelStore.getState(), 'assignEntityToLayer')
    removeSpy = vi.spyOn(useReferenceModelStore.getState(), 'removeEntityAssignment')
  })

  it('quick-assign fires onAssignmentChange and never touches the referenceModelStore', () => {
    const onAssignmentChange = vi.fn()
    render(
      <WizardAssignmentTree
        layers={layers}
        assignments={{}}
        onAssignmentChange={onAssignmentChange}
        onBulkAssign={vi.fn()}
      />
    )

    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'l2' } })

    expect(onAssignmentChange).toHaveBeenCalledWith('urn:a', 'l2')
    expect(assignSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('the remove-assignment button fires onAssignmentChange(id, null) without touching the store', () => {
    const onAssignmentChange = vi.fn()
    const assignments: Record<string, LayerAssignmentEntry> = {
      'urn:a': { layerId: 'l1', inheritsChildren: true },
    }
    render(
      <WizardAssignmentTree
        layers={layers}
        assignments={assignments}
        onAssignmentChange={onAssignmentChange}
        onBulkAssign={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTitle('Remove assignment'))

    expect(onAssignmentChange).toHaveBeenCalledWith('urn:a', null)
    expect(assignSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('renders the assigned layer badge from the assignments prop (not a store lookup)', () => {
    const assignments: Record<string, LayerAssignmentEntry> = {
      'urn:a': { layerId: 'l2', inheritsChildren: true },
    }
    render(
      <WizardAssignmentTree
        layers={layers}
        assignments={assignments}
        onAssignmentChange={vi.fn()}
        onBulkAssign={vi.fn()}
      />
    )

    expect(screen.getByText('Layer 2', { selector: 'span' })).toBeInTheDocument()
  })
})
