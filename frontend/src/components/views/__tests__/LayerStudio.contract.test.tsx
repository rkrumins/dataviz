/**
 * LayerStudio with placementContractEnabled on: the rail lists what the One
 * Placement Contract places as roots (stale entries skipped, stamped and
 * tag/property rule roots included), the conflict map ignores the store's
 * backend answer, and Auto-layer asks the contract what is already placed.
 * Flag-off behaviour is pinned by the other LayerStudio tests, unedited.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../ViewWizard/ViewWizard'
import type { LayerRootRow } from '../LayerHierarchyPanel'
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
vi.mock('@/providers/GraphProviderContext', () => {
  const provider = { getNodes: vi.fn().mockResolvedValue([]) }
  return { useGraphProvider: () => provider }
})

const entityType = (id: string, plural: string) => ({
  id,
  name: id,
  pluralName: plural,
  visual: { icon: 'Box', color: '#123456', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false },
  behavior: {},
})

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: [entityType('Domain', 'Domains'), entityType('Platform', 'Platforms')],
    relationshipTypes: [],
    containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: [],
    rootEntityTypes: ['Domain'],
    isLoading: false,
    isError: false,
  }),
}))

type FakeNode = { urn: string; entityType: string; displayName: string; properties: Record<string, unknown>; tags?: string[]; layerAssignment?: string }
const node = (n: Omit<FakeNode, 'properties'>, childIds: string[] = []) => [n.urn, {
  node: { properties: {}, ...n },
  childIds, totalChildren: childIds.length, totalIsExact: true, hasMore: false, nextOffset: 0, loaded: true,
}] as const

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: [] as string[],
  nodes: new Map<string, ReturnType<typeof node>[1]>(),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([]),
  loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false,
  topLevelTotalCount: 0,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  failedIds: new Set<string>(),
  loadingNodes: new Set<string>(),
}
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

// The rail is a stub that records the rows LayerStudio hands it.
const rail = vi.hoisted(() => ({ rootsByLayer: null as Map<string, LayerRootRow[]> | null }))
vi.mock('../LayerHierarchyPanel', () => ({
  LayerHierarchyPanel: ({ rootsByLayer }: { rootsByLayer: Map<string, LayerRootRow[]> }) => {
    rail.rootsByLayer = rootsByLayer
    return <div data-testid="layer-hierarchy-panel-stub" />
  },
}))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { LayerStudio } from '../LayerStudio'

const setContract = (on: boolean) =>
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, placementContractEnabled: on } })

function browse(entries: ReturnType<typeof node>[], topLevelIds: string[], parentMap = new Map<string, string>()) {
  fakeBrowser.nodes = new Map(entries)
  fakeBrowser.topLevelIds = topLevelIds
  fakeBrowser.topLevelTotalCount = topLevelIds.length
  fakeBrowser.parentMap = parentMap
}

function makeFormData(overrides: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'Test view',
    description: '',
    icon: 'Layout',
    visibility: 'private',
    tags: [],
    layoutType: 'reference',
    dataSourceId: 'ds1',
    layers: [],
    assignments: {},
    visibleEntityTypes: [],
    visibleRelationshipTypes: [],
    advancedFilters: [],
    isValid: true,
    ...overrides,
  }
}

const layer = (id: string, name: string, order: number, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
  ({ id, name, order, sequence: order, entityTypes: [], ...extra })

/** layerId -> [name, rulePlaced] for every rail row. */
const railRows = () => Object.fromEntries(
  [...rail.rootsByLayer!.entries()].map(([layerId, rows]) => [layerId, rows.map(r => [r.name, r.rulePlaced])]),
)

beforeEach(() => setContract(true))
afterEach(() => {
  setContract(false)
  useReferenceModelStore.setState({ effectiveAssignments: new Map() })
  rail.rootsByLayer = null
})

describe('LayerStudio — contract rail', () => {
  const layers = [
    layer('domains', 'Domains', 0, { entityTypes: ['Domain'] }),
    layer('gold', 'Gold', 1, { rules: [{ id: 'r', priority: 0, tags: ['gold'] }] }),
    layer('manual', 'Manual', 2),
  ]
  const formData = makeFormData({
    layers,
    entityScope: 'all',
    assignments: {
      'urn:x': { layerId: 'manual', inheritsChildren: true },
      'urn:stale': { layerId: 'deleted', inheritsChildren: true },
      'urn:stale-domain': { layerId: 'deleted', inheritsChildren: true },
    },
  })

  beforeEach(() => browse([
    node({ urn: 'urn:x', entityType: 'Platform', displayName: 'Explicit' }),
    node({ urn: 'urn:stale', entityType: 'Platform', displayName: 'Stale' }),
    node({ urn: 'urn:stale-domain', entityType: 'Domain', displayName: 'Stale Domain' }),
    node({ urn: 'urn:s', entityType: 'Platform', displayName: 'Stamped', layerAssignment: 'manual' }),
    node({ urn: 'urn:g', entityType: 'Platform', displayName: 'Golden', tags: ['gold'] }),
    node({ urn: 'urn:d', entityType: 'Domain', displayName: 'Plain Domain' }),
  ], ['urn:x', 'urn:stale', 'urn:stale-domain', 'urn:s', 'urn:g', 'urn:d']))

  it('lists explicit, stamped and rule roots, and skips stale entries', () => {
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expect(railRows()).toEqual({
      manual: [['Explicit', false], ['Stamped', true]],
      domains: [['Plain Domain', true], ['Stale Domain', true]],
      gold: [['Golden', true]],
    })
  })

  it('lists the legacy rows with the flag off (control)', () => {
    setContract(false)
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expect(railRows()).toEqual({
      manual: [['Explicit', false]],
      deleted: [['Stale', false], ['Stale Domain', false]],
      domains: [['Plain Domain', true]],
    })
  })
})

describe('LayerStudio — contract conflict map', () => {
  // Parent contains Child; the store's (stale) backend answer puts Child in Other.
  beforeEach(() => {
    browse([
      node({ urn: 'urn:p', entityType: 'Domain', displayName: 'Parent' }, ['urn:c']),
      node({ urn: 'urn:c', entityType: 'Platform', displayName: 'Child' }),
    ], ['urn:p'], new Map([['urn:c', 'urn:p']]))
    useReferenceModelStore.setState({
      effectiveAssignments: new Map([['urn:c', { entityId: 'urn:c', layerId: 'other', isInherited: false, confidence: 1 }]]),
    })
  })

  const assignParentToOne = () => {
    const row = screen.getByTitle('Parent').closest('.group') as HTMLElement
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'one' } })
  }
  const formData = makeFormData({ layers: [layer('one', 'One', 0), layer('other', 'Other', 1)] })

  it('ignores the store’s backend answer: placing the parent asks nothing', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)
    assignParentToOne()

    expect(screen.queryByText(/with parent\?/)).not.toBeInTheDocument()
    const call = updateFormData.mock.calls.find(c => 'assignments' in c[0])![0]
    expect(call.assignments['urn:p']).toMatchObject({ layerId: 'one' })
  })

  it('asks to move the child with the flag off (control)', () => {
    setContract(false)
    const updateFormData = vi.fn()
    render(<LayerStudio formData={formData} updateFormData={updateFormData} />)
    assignParentToOne()

    expect(screen.getByText('Move 1 child with parent?')).toBeInTheDocument()
    expect(updateFormData.mock.calls.some(c => 'assignments' in c[0])).toBe(false)
  })
})

describe('LayerStudio — contract Auto-layer', () => {
  // A stamped Platform is already placed under the contract: not stranded.
  beforeEach(() => browse([
    node({ urn: 'urn:finance', entityType: 'Domain', displayName: 'Finance' }),
    node({ urn: 'urn:risk', entityType: 'Domain', displayName: 'Risk' }),
    node({ urn: 'urn:stray', entityType: 'Platform', displayName: 'Stray Platform', layerAssignment: 'manual' }),
  ], ['urn:finance', 'urn:risk', 'urn:stray']))

  const splitDomains = () => {
    fireEvent.click(screen.getByRole('button', { name: /auto-layer/i }))
    const sheet = within(screen.getByTestId('auto-layer-sheet'))
    fireEvent.click(sheet.getByRole('radio', { name: /One column each/ }))
    fireEvent.click(sheet.getByRole('button', { name: /^Domains2$/ }))
    return sheet
  }
  const formData = makeFormData({ layers: [layer('manual', 'Manual', 0)] })

  it('does not call a stamped entity stranded', () => {
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expect(splitDomains().queryByText(/stays out of the view/)).not.toBeInTheDocument()
  })

  it('calls it stranded with the flag off (control)', () => {
    setContract(false)
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expect(splitDomains().getByText(/1 Platforms stays out of the view/)).toBeInTheDocument()
  })
})
