/**
 * Anchored columns in the wizard rail.
 *
 * A column anchored to an entity IS that entity, so the rail lists the entity's
 * CHILDREN — matching what the canvas draws. Without this the rail would show a
 * single row repeating the column's own name.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../ViewWizard/ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

vi.mock('@/lib/queryClient', () => ({ getQueryClient: () => ({ removeQueries: vi.fn(), invalidateQueries: vi.fn() }) }))

const { getChildrenWithEdges } = vi.hoisted(() => ({ getChildrenWithEdges: vi.fn() }))
getChildrenWithEdges.mockResolvedValue({
  children: [
    { urn: 'urn:payments', entityType: 'dataset', displayName: 'Payments', properties: {} },
    { urn: 'urn:ledger', entityType: 'dataset', displayName: 'Ledger', properties: {} },
  ],
  containmentEdges: [], lineageEdges: [],
})

// ONE provider object for the life of the test. useWizardEntityIndex wipes its
// caches whenever the provider IDENTITY changes (its workspace-scope reset), so
// a factory returning a fresh object each render throws the loaded children away
// on every render and childrenOf never returns anything.
vi.mock('@/providers/GraphProviderContext', () => {
  const provider = { getNode: vi.fn().mockResolvedValue(null), getChildrenWithEdges }
  return { useGraphProvider: () => provider }
})
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: [], relationshipTypes: [], containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: [], rootEntityTypes: [], isLoading: false, isError: false,
  }),
}))

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:finance'],
  nodes: new Map([['urn:finance', {
    node: { urn: 'urn:finance', entityType: 'domain', displayName: 'Financial Services', properties: {} },
    childIds: [], totalChildren: 2, hasMore: false, nextCursor: null, loaded: true,
  }]]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(), setSearch: vi.fn(), setTypeFilter: vi.fn(), expandNode: vi.fn(),
  loadMoreChildren: vi.fn(), loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([]), loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false, topLevelTotalCount: 1,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  loadingNodes: new Set<string>(),
}
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { LayerStudio } from '../LayerStudio'

const anchored: ViewLayerConfig[] = [{
  id: 'l1', name: 'Financial Services', entityTypes: [], order: 0, sequence: 0,
  anchorUrn: 'urn:finance',
}]

const formData = (layers: ViewLayerConfig[]): WizardFormData => ({
  name: 'T', description: '', icon: 'Layout', visibility: 'private', tags: [],
  layoutType: 'reference', dataSourceId: 'ds1',
  layers, assignments: { 'urn:finance': { layerId: 'l1', inheritsChildren: true } },
  visibleEntityTypes: [], visibleRelationshipTypes: [], advancedFilters: [], isValid: true,
})

const rail = () => within(screen.getByTestId('layer-hierarchy-panel'))
/** Just the column's rows — the layer name also appears in headers and hints. */
const rows = () => within(screen.getByTestId('layer-rows-l1'))

describe('LayerStudio — anchored columns', () => {
  it('fetches the anchor\'s children, which nothing else in the wizard expands', async () => {
    render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
    await waitFor(() => expect(getChildrenWithEdges).toHaveBeenCalled())
    expect(getChildrenWithEdges.mock.calls[0][0]).toBe('urn:finance')
  })

  it('lists the children as the column\'s rows', async () => {
    render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
    await waitFor(() => expect(rail().getByText('Payments')).toBeInTheDocument())
    expect(rail().getByText('Ledger')).toBeInTheDocument()
  })

  it('does not repeat the column\'s own name as a row', async () => {
    render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
    await waitFor(() => expect(rail().getByText('Payments')).toBeInTheDocument())
    // The header names the column; the rows must not repeat it.
    expect(rows().queryByText('Financial Services')).not.toBeInTheDocument()
  })

  it('without an anchor, the entity itself is still the row', async () => {
    const plain = [{ ...anchored[0], anchorUrn: undefined }]
    render(<LayerStudio formData={formData(plain)} updateFormData={vi.fn()} />)
    await waitFor(() => expect(rows().getByText('Financial Services')).toBeInTheDocument())
    expect(rows().queryByText('Payments')).not.toBeInTheDocument()
  })
})

describe('LayerStudio — an anchor holding more than one page', () => {
  it('keeps the anchor row rather than showing only its first page', async () => {
    // The rail must agree with the canvas, which falls back to the row so the
    // rest stays reachable — paging hangs off that row.
    const entry = fakeBrowser.nodes.get('urn:finance')!
    const original = entry.totalChildren
    fakeBrowser.nodes.set('urn:finance', { ...entry, totalChildren: 5000 })
    try {
      render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
      await waitFor(() => expect(rows().getByText('Financial Services')).toBeInTheDocument())
      expect(rows().queryByText('Payments')).not.toBeInTheDocument()
    } finally {
      fakeBrowser.nodes.set('urn:finance', { ...entry, totalChildren: original })
    }
  })
})
