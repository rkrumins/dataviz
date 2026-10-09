/**
 * LayerStudio with placementContractEnabled on: the rail lists what the One
 * Placement Contract places as roots (stale entries skipped, stamped and
 * tag/property rule roots included) and the loaded children it places apart
 * from their parent (nested, or promoted by an anchor, only in their own layer),
 * the conflict map ignores the store's backend answer, and Auto-layer asks the
 * contract what is already placed.
 * Flag-off behaviour is pinned by the other LayerStudio tests, unedited.
 */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
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
const { getChildrenWithEdges } = vi.hoisted(() => ({ getChildrenWithEdges: vi.fn() }))
vi.mock('@/providers/GraphProviderContext', () => {
  const provider = { getNodes: vi.fn().mockResolvedValue([]), getChildrenWithEdges }
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

// The rail is a stub that records the rows LayerStudio hands it — the real
// panel when a test sets `real`.
const rail = vi.hoisted(() => ({ rootsByLayer: null as Map<string, LayerRootRow[]> | null, real: false }))
vi.mock('../LayerHierarchyPanel', async (importOriginal) => {
  const { LayerHierarchyPanel } = await importOriginal<typeof import('../LayerHierarchyPanel')>()
  return {
    LayerHierarchyPanel: (props: React.ComponentProps<typeof LayerHierarchyPanel>) => {
      rail.rootsByLayer = props.rootsByLayer ?? null
      return rail.real ? <LayerHierarchyPanel {...props} /> : <div data-testid="layer-hierarchy-panel-stub" />
    },
  }
})

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

/** name -> what placed it, for every rail row. */
const railPlacedBy = () => Object.fromEntries([...rail.rootsByLayer!.values()].flat().map(r => [r.name, r.placedBy]))

/** The real rail's row for `name` in a column. */
const railRow = (layerId: string, name: string) =>
  within(screen.getByTestId(`layer-rows-${layerId}`)).getByText(name).closest('[draggable]') as HTMLElement

beforeEach(() => setContract(true))
afterEach(() => {
  setContract(false)
  useReferenceModelStore.setState({ effectiveAssignments: new Map() })
  rail.rootsByLayer = null
  rail.real = false
  getChildrenWithEdges.mockReset()
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
    expect(railPlacedBy()).toEqual({
      Explicit: undefined, Stamped: 'stamp', 'Plain Domain': 'type', 'Stale Domain': 'type', Golden: 'rule',
    })
  })

  it('labels each placed row by what placed it', () => {
    rail.real = true
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    const marker = (layerId: string, name: string) => within(railRow(layerId, name)).getByTestId('rail-rule-placed-marker')

    expect(marker('manual', 'Stamped')).toHaveTextContent('stamped')
    expect(marker('manual', 'Stamped'))
      .toHaveAttribute('title', "Placed by the entity's own layer setting. Drag it to another layer to override.")
    expect(marker('gold', 'Golden')).toHaveTextContent('by rule')
    expect(marker('gold', 'Golden'))
      .toHaveAttribute('title', 'Placed automatically by a rule on this layer. Drag it to another layer to override.')
    expect(marker('domains', 'Plain Domain')).toHaveTextContent('by type')
    expect(marker('domains', 'Plain Domain'))
      .toHaveAttribute('title', 'Placed automatically because this layer covers the Domain type. Drag it to another layer to override.')
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

describe('LayerStudio — contract rail, loaded children', () => {
  // Warehouse (container) holds Orders (dataset); each type has its own column.
  const formData = makeFormData({
    entityScope: 'all',
    layers: [layer('left', 'Left', 0, { entityTypes: ['container'] }), layer('right', 'Right', 1, { entityTypes: ['dataset'] })],
  })

  beforeEach(() => {
    rail.real = true
    browse([
      node({ urn: 'urn:p', entityType: 'container', displayName: 'Warehouse' }, ['urn:k']),
      node({ urn: 'urn:k', entityType: 'dataset', displayName: 'Orders' }),
    ], ['urn:p'])
    getChildrenWithEdges.mockResolvedValue({
      children: [{ urn: 'urn:k', entityType: 'dataset', displayName: 'Orders', properties: {} }],
      containmentEdges: [], lineageEdges: [],
    })
  })

  const left = () => within(screen.getByTestId('layer-rows-left'))

  it('lists a child its own rule places in another column there, not under its parent', async () => {
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expect(left().getByTitle('1 children inherit this layer')).toBeInTheDocument()
    fireEvent.click(left().getByRole('button', { name: 'Expand Warehouse' }))

    await waitFor(() => expect(screen.getByTestId('layer-rows-right')).toHaveTextContent('Orders'))
    expect(railRows()).toEqual({ left: [['Warehouse', true]], right: [['Orders', true]] })
    expect(railPlacedBy()).toMatchObject({ Orders: 'type' })
    expect(left().queryByText('Orders')).not.toBeInTheDocument()
    // With its path in the data, as the canvas tags it.
    expect(within(screen.getByTestId('layer-rows-right'))
      .getByTitle('Placed here for this view only — the data source is unchanged. In the data, Orders is part of Warehouse.'))
      .toHaveTextContent('Part of Warehouse')
    // Nor counted as a child that inherits Left.
    fireEvent.click(left().getByRole('button', { name: 'Collapse Warehouse' }))
    expect(left().queryByTitle(/children inherit this layer/)).not.toBeInTheDocument()
  })

  it('does not draw a child its parent passes nothing to, nor count it', async () => {
    // Warehouse's entry does not cascade and Orders has no rule: the contract places it nowhere.
    render(<LayerStudio formData={makeFormData({
      entityScope: 'all',
      layers: [layer('left', 'Left', 0)],
      assignments: { 'urn:p': { layerId: 'left', inheritsChildren: false } },
    })} updateFormData={vi.fn()} />)
    // Not counted even before its page is in: nothing can inherit from Warehouse.
    expect(left().queryByTitle(/children inherit this layer/)).not.toBeInTheDocument()
    fireEvent.click(left().getByRole('button', { name: 'Expand Warehouse' }))

    // Its page is in once the row stops loading.
    await waitFor(() => expect(left().getByRole('button', { name: 'Collapse Warehouse' }).querySelector('.animate-spin')).toBeNull())
    expect(left().queryByText('Orders')).not.toBeInTheDocument()
    fireEvent.click(left().getByRole('button', { name: 'Collapse Warehouse' }))
    expect(left().queryByTitle(/children inherit this layer/)).not.toBeInTheDocument()
  })

  it('nests the child under its parent with the flag off (control)', async () => {
    setContract(false)
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    fireEvent.click(left().getByRole('button', { name: 'Expand Warehouse' }))

    await waitFor(() => expect(left().getByText('Orders')).toBeInTheDocument())
    expect(screen.queryByTestId('layer-rows-right')).not.toBeInTheDocument()
  })
})

describe('LayerStudio — contract rail, a child only the rail loaded', () => {
  // Warehouse (container) holds Orders (dataset), which only the rail's own page
  // brings in: its tags and stamp come from that page, not the browser.
  const formData = makeFormData({
    entityScope: 'all',
    layers: [
      layer('left', 'Left', 0, { entityTypes: ['container'] }),
      layer('gold', 'Gold', 1, { rules: [{ id: 'r', priority: 0, tags: ['gold'] }] }),
      layer('right', 'Right', 2),
    ],
  })
  const orders = (extra: Partial<FakeNode>) => getChildrenWithEdges.mockResolvedValue({
    children: [{ urn: 'urn:k', entityType: 'dataset', displayName: 'Orders', properties: {}, ...extra }],
    containmentEdges: [], lineageEdges: [],
  })

  beforeEach(() => {
    rail.real = true
    browse([node({ urn: 'urn:p', entityType: 'container', displayName: 'Warehouse' }, ['urn:k'])], ['urn:p'])
  })

  const expandWarehouse = () =>
    fireEvent.click(within(screen.getByTestId('layer-rows-left')).getByRole('button', { name: 'Expand Warehouse' }))

  it('lists it where its tags place it', async () => {
    orders({ tags: ['gold'] })
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expandWarehouse()

    await waitFor(() => expect(screen.getByTestId('layer-rows-gold')).toHaveTextContent('Orders'))
    expect(railRows()).toEqual({ left: [['Warehouse', true]], gold: [['Orders', true]] })
    expect(railPlacedBy()).toMatchObject({ Orders: 'rule' })
  })

  it('lists it where its own stamp places it', async () => {
    orders({ layerAssignment: 'right' })
    render(<LayerStudio formData={formData} updateFormData={vi.fn()} />)
    expandWarehouse()

    await waitFor(() => expect(screen.getByTestId('layer-rows-right')).toHaveTextContent('Orders'))
    expect(railRows()).toEqual({ left: [['Warehouse', true]], right: [['Orders', true]] })
    expect(railPlacedBy()).toMatchObject({ Orders: 'stamp' })
  })
})

describe('LayerStudio — contract rail, an anchored column', () => {
  // Left is Warehouse, whose entry passes nothing down: Staging is Left's by type,
  // Orders is Right's.
  beforeEach(() => {
    rail.real = true
    browse([node({ urn: 'urn:p', entityType: 'container', displayName: 'Warehouse' }, ['urn:k', 'urn:s'])], ['urn:p'])
    getChildrenWithEdges.mockResolvedValue({
      children: [
        { urn: 'urn:k', entityType: 'dataset', displayName: 'Orders', properties: {} },
        { urn: 'urn:s', entityType: 'schema', displayName: 'Staging', properties: {} },
      ],
      containmentEdges: [], lineageEdges: [],
    })
  })

  it('promotes only the children placed in its layer', async () => {
    render(<LayerStudio formData={makeFormData({
      entityScope: 'all',
      layers: [
        layer('left', 'Left', 0, { anchorUrn: 'urn:p', entityTypes: ['schema'] }),
        layer('right', 'Right', 1, { entityTypes: ['dataset'] }),
      ],
      assignments: { 'urn:p': { layerId: 'left', inheritsChildren: false } },
    })} updateFormData={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('layer-rows-left')).toHaveTextContent('Staging'))
    expect(railRows()).toEqual({ left: [['Staging', false]], right: [['Orders', true]] })
    expect(screen.getAllByText('Orders')).toHaveLength(1)
  })
})

describe('LayerStudio — contract rail, a child under two parents', () => {
  // Alpha and Beta (Domains) both hold Shared (dataset).
  beforeEach(() => {
    rail.real = true
    browse([
      node({ urn: 'urn:a', entityType: 'Domain', displayName: 'Alpha' }, ['urn:c']),
      node({ urn: 'urn:b', entityType: 'Domain', displayName: 'Beta' }, ['urn:c']),
      node({ urn: 'urn:c', entityType: 'dataset', displayName: 'Shared' }),
    ], ['urn:a', 'urn:b'])
    getChildrenWithEdges.mockResolvedValue({
      children: [{ urn: 'urn:c', entityType: 'dataset', displayName: 'Shared', properties: {} }],
      containmentEdges: [], lineageEdges: [],
    })
  })

  const rows = (layerId: string) => within(screen.getByTestId(`layer-rows-${layerId}`))
  /** Expand both parents and wait for Shared to land in `sharedIn` — only there. */
  const expandBoth = async (alphaLayer: string, betaLayer: string, sharedIn: string) => {
    fireEvent.click(rows(alphaLayer).getByRole('button', { name: 'Expand Alpha' }))
    fireEvent.click(rows(betaLayer).getByRole('button', { name: 'Expand Beta' }))
    await waitFor(() => expect(rows(sharedIn).getByText('Shared')).toBeInTheDocument())
    expect(screen.getAllByText('Shared')).toHaveLength(1)
  }

  it('does not list a child that only inherits as a root of either column', async () => {
    render(<LayerStudio formData={makeFormData({
      entityScope: 'all',
      layers: [layer('left', 'Left', 0), layer('right', 'Right', 1)],
      assignments: { 'urn:a': { layerId: 'left', inheritsChildren: true }, 'urn:b': { layerId: 'right', inheritsChildren: true } },
    })} updateFormData={vi.fn()} />)
    // Two hand parents: the smaller URN wins, so under Alpha only.
    await expandBoth('left', 'right', 'left')

    expect(railRows()).toEqual({ left: [['Alpha', false]], right: [['Beta', false]] })
    expect(screen.queryByTestId('rail-rule-placed-marker')).not.toBeInTheDocument()
  })

  it('places the child from both parents: a hand parent beats its own rule', async () => {
    render(<LayerStudio formData={makeFormData({
      entityScope: 'all',
      layers: [
        layer('left', 'Left', 0, { entityTypes: ['Domain'] }),
        layer('middle', 'Middle', 1),
        layer('right', 'Right', 2, { entityTypes: ['dataset'] }),
      ],
      assignments: { 'urn:b': { layerId: 'middle', inheritsChildren: true } },
    })} updateFormData={vi.fn()} />)
    // Under Beta, whose Middle it inherits — not under Alpha too.
    await expandBoth('left', 'middle', 'middle')

    expect(railRows()).toEqual({ left: [['Alpha', true]], middle: [['Beta', false]] })
    fireEvent.click(rows('left').getByRole('button', { name: 'Collapse Alpha' }))
    expect(rows('left').queryByTitle(/children inherit this layer/)).not.toBeInTheDocument()
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
