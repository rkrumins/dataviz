/**
 * Anchored columns in the wizard rail.
 *
 * A column anchored to an entity IS that entity, so the rail lists the entity's
 * CHILDREN — matching what the canvas draws. Without this the rail would show a
 * single row repeating the column's own name.
 */
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
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
  // Lookups are batched through getNodes; an empty answer = "not in the graph".
  const provider = { getNodes: vi.fn().mockResolvedValue([]), getChildrenWithEdges }
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
    childIds: [], totalChildren: 2, hasMore: false, nextOffset: 0, loaded: true,
  }]]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(), setSearch: vi.fn(), setTypeFilter: vi.fn(), expandNode: vi.fn(),
  loadMoreChildren: vi.fn(), loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([]), loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false, topLevelTotalCount: 1,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  failedIds: new Set<string>(),
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
  const withChildCount = async (total: number, assertions: () => void | Promise<void>) => {
    const entry = fakeBrowser.nodes.get('urn:finance')!
    const original = entry.totalChildren
    fakeBrowser.nodes.set('urn:finance', { ...entry, totalChildren: total })
    try { await assertions() }
    finally { fakeBrowser.nodes.set('urn:finance', { ...entry, totalChildren: original }) }
  }

  it('shows the page it has and offers the rest', async () => {
    await withChildCount(5000, async () => {
      render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
      await waitFor(() => expect(rows().getByText('Payments')).toBeInTheDocument())
      // Never a silent 2-of-5000: the remainder is stated and reachable. The
      // number is the WIZARD's page (50) — what the click actually fetches.
      expect(rows().getByRole('button', { name: /Show 50 more/ })).toBeInTheDocument()
      expect(rows().getByText(/4,998 left/)).toBeInTheDocument()
    })
  })

  it('asks for the next page when the row is clicked', async () => {
    await withChildCount(5000, async () => {
      render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
      await waitFor(() => expect(rows().getByText('Payments')).toBeInTheDocument())
      getChildrenWithEdges.mockClear()
      fireEvent.click(rows().getByRole('button', { name: /Show 50 more/ }))
      await waitFor(() => expect(getChildrenWithEdges).toHaveBeenCalled())
      // Paged, not refetched from the top — and exactly the page the label named.
      expect(getChildrenWithEdges.mock.calls[0][1].offset).toBe(2)
      expect(getChildrenWithEdges.mock.calls[0][1].limit).toBe(50)
    })
  })

  it('offers nothing more once the column holds the lot', async () => {
    render(<LayerStudio formData={formData(anchored)} updateFormData={vi.fn()} />)
    await waitFor(() => expect(rows().getByText('Payments')).toBeInTheDocument())
    expect(rows().queryByRole('button', { name: /Show .* more/ })).not.toBeInTheDocument()
  })
})

describe('LayerStudio — not creating a column that could never fill', () => {
  it('skips an entity that already has a column', async () => {
    // A second column on the same entity can never fill (placement resolves an
    // anchor to ONE layer), so it is cheaper not to create it.
    const updateFormData = vi.fn()
    render(<LayerStudio formData={formData(anchored)} updateFormData={updateFormData} />)
    await waitFor(() => expect(rows().getByText('Payments')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /auto-layer/i }))
    const sheet = within(screen.getByTestId('auto-layer-sheet'))
    fireEvent.click(sheet.getByRole('radio', { name: /One column each/ }))
    // Financial Services is the only scanned top-level entity, and it is the
    // anchor of the column already on the draft.
    sheet.getAllByRole('checkbox').forEach(box => fireEvent.click(box))
    fireEvent.click(sheet.getByRole('button', { name: /^Create/ }))

    expect(updateFormData.mock.calls.some(c => 'layers' in c[0])).toBe(false)
  })
})

describe('LayerStudio — an anchored column also holding something else', () => {
  it('lists the dragged-in root alongside the anchor\'s children', async () => {
    // Promotion replaces the ANCHOR row, not the column. The canvas keeps any
    // other visual root of that layer, so the rail has to as well or the two
    // disagree and the count is short.
    const withExtra: WizardFormData = {
      ...formData(anchored),
      assignments: {
        'urn:finance': { layerId: 'l1', inheritsChildren: true },
        'urn:other': { layerId: 'l1', inheritsChildren: true },
      },
    }
    render(<LayerStudio formData={withExtra} updateFormData={vi.fn()} />)
    await waitFor(() => expect(rows().getByText('Payments')).toBeInTheDocument())
    // The extra root resolves by urn fallback; what matters is that it is drawn.
    expect(screen.getByTestId('layer-rows-l1').querySelectorAll('[draggable]').length)
      .toBeGreaterThanOrEqual(3)
  })
})
