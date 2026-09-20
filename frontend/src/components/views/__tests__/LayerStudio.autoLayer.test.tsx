/**
 * LayerStudio — Auto-layer.
 *
 * Turns the top of the hierarchy into layer columns in ONE commit (so one undo
 * walks it back), in two modes:
 *   • by TYPE   — rule-driven layers carrying `entityTypes`, no assignments, and
 *                 a pinned open scope (curated scope ignores rules for roots, so
 *                 without the pin every column would empty out).
 *   • by ENTITY — one column per entity plus one inheriting assignment each.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
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
vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({ getNode: vi.fn().mockResolvedValue(null) }),
}))

// Domain contains Platform contains Table — only Domain is a declared root.
const entityType = (id: string, plural: string, canContain: string[], canBeContainedBy: string[]) => ({
  id,
  name: id,
  pluralName: plural,
  visual: { icon: 'Box', color: '#123456', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [],
  hierarchy: { level: canBeContainedBy.length, canContain, canBeContainedBy, defaultExpanded: false },
  behavior: {},
})

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: [
      entityType('Domain', 'Domains', ['Platform'], []),
      entityType('Platform', 'Platforms', ['Table'], ['Domain']),
      entityType('Table', 'Tables', [], ['Platform']),
    ],
    relationshipTypes: [],
    containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: [],
    rootEntityTypes: ['Domain'],
    isLoading: false,
    isError: false,
  }),
}))

const node = (urn: string, entityType: string, displayName: string, totalChildren = 0) => [urn, {
  node: { urn, entityType, displayName, properties: {} },
  childIds: [], totalChildren, hasMore: false, nextCursor: null, loaded: true,
}] as const

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:finance', 'urn:risk', 'urn:stray'],
  nodes: new Map([
    node('urn:finance', 'Domain', 'Finance', 3),
    node('urn:risk', 'Domain', 'Risk'),
    // An orphan root: a Platform ingested with no Domain above it.
    node('urn:stray', 'Platform', 'Stray Platform'),
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
  topLevelTotalCount: 3,
  topLevelMetadata: { rootTypeCount: 2, orphanCount: 1 },
  loadingNodes: new Set<string>(),
}

vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))
vi.mock('../LayerHierarchyPanel', () => ({
  LayerHierarchyPanel: () => <div data-testid="layer-hierarchy-panel-stub" />,
}))

import { LayerStudio, AUTO_LAYER_WARN, AUTO_LAYER_MAX } from '../LayerStudio'

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

const openSheet = () => fireEvent.click(screen.getByRole('button', { name: /auto-layer/i }))
/** The sheet itself — the entity tree behind it renders the same names. */
const sheet = () => within(screen.getByTestId('auto-layer-sheet'))
const createButton = () => sheet().getByRole('button', { name: /^(Create|Really create)/ })
const checkboxes = () => sheet().getAllByRole('checkbox')
/** The row list only — names also appear in the column preview above it. */
const list = () => within(screen.getByTestId('auto-layer-list'))

describe('Auto-layer — by type', () => {
  it('offers one column per declared root type, and flags observed orphan types', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()

    expect(list().getByText('Domains')).toBeInTheDocument()
    // Platform is not a declared root, but the graph holds one at top level.
    expect(list().getByText('Platforms')).toBeInTheDocument()
    expect(list().getByText('unexpected')).toBeInTheDocument()
    // Table is neither a root nor observed at top level.
    expect(list().queryByText('Tables')).not.toBeInTheDocument()
  })

  it('pre-selects only the observed declared roots, so orphans are opt-in', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    expect(createButton()).toHaveTextContent('Create 1 column')
  })

  it('commits rule-driven layers and pins open scope, in one commit each', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    openSheet()
    fireEvent.click(createButton())

    const layerCall = updateFormData.mock.calls.find(c => 'layers' in c[0])![0]
    expect(layerCall.layers).toHaveLength(1)
    expect(layerCall.layers[0]).toMatchObject({
      name: 'Domains',
      entityTypes: ['Domain'],
      order: 0,
      sequence: 0,
    })
    // The type rule places the entities — nothing is written per entity.
    expect(layerCall.assignments).toEqual({})

    const scopeCall = updateFormData.mock.calls.find(c => 'entityScope' in c[0])![0]
    expect(scopeCall.entityScope).toBe('all')
  })

  it('keeps existing layers and numbers the new ones after them', () => {
    const existing: ViewLayerConfig[] = [{ id: 'l1', name: 'Mine', entityTypes: [], order: 0 }]
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData({ layers: existing })} updateFormData={updateFormData} />)
    openSheet()
    fireEvent.click(createButton())

    const call = updateFormData.mock.calls.find(c => 'layers' in c[0])![0]
    expect(call.layers.map((l: ViewLayerConfig) => l.name)).toEqual(['Mine', 'Domains'])
    expect(call.layers[1].order).toBe(1)
  })

  it('marks a type an existing layer already covers, and leaves it unselected', () => {
    const existing: ViewLayerConfig[] = [{ id: 'l1', name: 'Mine', entityTypes: ['Domain'], order: 0 }]
    render(<LayerStudio formData={makeFormData({ layers: existing })} updateFormData={vi.fn()} />)
    openSheet()

    expect(list().getByText('already a column')).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
  })

  it('selects an orphan type on demand', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    openSheet()

    // Row order is declared roots first, then orphans.
    fireEvent.click(checkboxes()[1])
    expect(createButton()).toHaveTextContent('Create 2 columns')

    fireEvent.click(createButton())
    const call = updateFormData.mock.calls.find(c => 'layers' in c[0])![0]
    expect(call.layers.map((l: ViewLayerConfig) => l.entityTypes)).toEqual([['Domain'], ['Platform']])
  })
})

describe('Auto-layer — by entity', () => {
  const toEntityMode = () => fireEvent.click(sheet().getByRole('radio', { name: /One column each/ }))

  it('lists the scanned top-level entities', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()

    expect(list().getByText(/Finance/)).toBeInTheDocument()
    expect(list().getByText(/Risk/)).toBeInTheDocument()
    expect(list().getByText(/Stray Platform/)).toBeInTheDocument()
  })

  it('starts with nothing selected — a column per entity is a deliberate choice', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    expect(createButton()).toBeDisabled()
  })

  it('commits one column AND one inheriting assignment per entity, in one commit', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    openSheet()
    toEntityMode()

    const boxes = checkboxes()
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[1])
    fireEvent.click(createButton())

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.layers.map((l: ViewLayerConfig) => l.name)).toEqual(['Finance', 'Risk'])
    // No type rule — a column for Finance must not swallow every other Domain.
    expect(call.layers.every((l: ViewLayerConfig) => l.entityTypes.length === 0)).toBe(true)
    expect(Object.keys(call.assignments)).toEqual(['urn:finance', 'urn:risk'])
    expect(call.assignments['urn:finance']).toMatchObject({
      layerId: call.layers[0].id,
      inheritsChildren: true,
    })
  })

  it('does NOT pin open scope — explicit placements are correct under curated', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    openSheet()
    toEntityMode()
    fireEvent.click(checkboxes()[0])
    fireEvent.click(createButton())

    expect(updateFormData.mock.calls.some(c => 'entityScope' in c[0])).toBe(false)
  })
})

describe('Auto-layer — guards', () => {
  it('asks a second time before creating a great many columns', () => {
    const many = Array.from({ length: AUTO_LAYER_WARN + 1 }, (_, i) => `urn:e${i}`)
    const original = { ids: fakeBrowser.topLevelIds, nodes: fakeBrowser.nodes }
    fakeBrowser.topLevelIds = many
    fakeBrowser.nodes = new Map(many.map(urn => node(urn, 'Domain', urn)))

    const updateFormData = vi.fn()
    try {
      render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
      openSheet()
      fireEvent.click(sheet().getByRole('radio', { name: /One column each/ }))
      checkboxes().forEach(box => fireEvent.click(box))

      fireEvent.click(createButton())
      expect(updateFormData).not.toHaveBeenCalled()
      expect(createButton()).toHaveTextContent(`Create ${many.length} columns?`)

      fireEvent.click(createButton())
      expect(updateFormData).toHaveBeenCalledTimes(1)
    } finally {
      fakeBrowser.topLevelIds = original.ids
      fakeBrowser.nodes = original.nodes
    }
  })

  it('warns when every type in the ontology reports as a top level', async () => {
    vi.resetModules()
    vi.doMock('@/hooks/useDataSourceSchema', () => ({
      useDataSourceSchema: () => ({
        entityTypes: [
          entityType('Domain', 'Domains', [], []),
          entityType('Platform', 'Platforms', [], []),
        ],
        relationshipTypes: [],
        containmentEdgeTypes: [],
        lineageEdgeTypes: [],
        rootEntityTypes: ['Domain', 'Platform'],
        isLoading: false,
        isError: false,
      }),
    }))
    const { LayerStudio: Ungoverned } = await import('../LayerStudio')

    render(<Ungoverned formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    expect(sheet().getByText(/may not say yet what contains what/i)).toBeInTheDocument()
  })
})

describe('Auto-layer — splitting one type into a column each', () => {
  const toEntityMode = () => fireEvent.click(sheet().getByRole('radio', { name: /One column each/ }))
  const pill = (name: RegExp) => sheet().getByRole('button', { name })

  it('offers a pill per type actually present, with its count', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()

    expect(pill(/^Everything/)).toBeInTheDocument()
    expect(pill(/^Domains2$/)).toBeInTheDocument()   // 2 domains scanned
    expect(pill(/^Platforms1$/)).toBeInTheDocument() // 1 orphan platform
  })

  it('picking a type selects every one of them — the whole point of the gesture', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    expect(createButton()).toBeDisabled()

    fireEvent.click(pill(/^Domains2$/))
    expect(createButton()).toHaveTextContent('Create 2 columns')
  })

  it('narrows the list to that type', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    fireEvent.click(pill(/^Domains2$/))

    expect(list().getByText('Finance')).toBeInTheDocument()
    expect(list().getByText('Risk')).toBeInTheDocument()
    expect(list().queryByText('Stray Platform')).not.toBeInTheDocument()
  })

  it('commits a column per entity of that type, each carrying its subtree', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    openSheet()
    toEntityMode()
    fireEvent.click(pill(/^Domains2$/))
    fireEvent.click(createButton())

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.layers.map((l: ViewLayerConfig) => l.name)).toEqual(['Finance', 'Risk'])
    expect(Object.keys(call.assignments)).toEqual(['urn:finance', 'urn:risk'])
    expect(call.assignments['urn:finance'].inheritsChildren).toBe(true)
  })

  it('says which entities would be left out of the view', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    fireEvent.click(pill(/^Domains2$/))

    // The one Platform is not placed by a Domains split — never silently.
    expect(sheet().getByText(/1 Platforms stays out of the view/)).toBeInTheDocument()
  })

  it('says nothing about leftovers once everything is covered', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    checkboxes().forEach(box => fireEvent.click(box))

    expect(sheet().queryByText(/stays out of the view|stay out of the view/)).not.toBeInTheDocument()
  })

  it('"Everything" clears the selection rather than ticking hundreds', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    fireEvent.click(pill(/^Domains2$/))
    expect(createButton()).toHaveTextContent('Create 2 columns')

    fireEvent.click(pill(/^Everything/))
    expect(createButton()).toBeDisabled()
    expect(list().getByText('Stray Platform')).toBeInTheDocument()
  })

  it('previews the columns it would create, with what each holds', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    openSheet()
    toEntityMode()
    fireEvent.click(pill(/^Domains2$/))

    // Finance appears twice: once in the preview column, once in the list row.
    expect(sheet().getAllByText('Finance')).toHaveLength(2)
    // The preview says what the column will hold, not just its name.
    expect(within(screen.getByTestId('auto-layer-sheet')).getAllByText('3 inside').length)
        .toBeGreaterThanOrEqual(1)
    expect(list().getByText('3 inside')).toBeInTheDocument()
  })
})

describe('Auto-layer — scale', () => {
  const withEntities = (n: number, run: () => void) => {
    const original = { ids: fakeBrowser.topLevelIds, nodes: fakeBrowser.nodes }
    const many = Array.from({ length: n }, (_, i) => `urn:m${i}`)
    fakeBrowser.topLevelIds = many
    fakeBrowser.nodes = new Map(many.map(urn => node(urn, 'Domain', urn)))
    try { run() } finally {
      fakeBrowser.topLevelIds = original.ids
      fakeBrowser.nodes = original.nodes
    }
  }

  it('draws a bounded list however many entities were scanned', () => {
    withEntities(5000, () => {
      render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
      openSheet()
      fireEvent.click(sheet().getByRole('radio', { name: /One column each/ }))
      // 5000 scanned, but the sheet never tries to draw 5000 rows.
      expect(checkboxes().length).toBeLessThanOrEqual(100)
      expect(sheet().getByRole('button', { name: /Show 100 more/ })).toBeInTheDocument()
    })
  })

  it('declines a number of columns a view cannot be read across', () => {
    withEntities(AUTO_LAYER_MAX + 50, () => {
      const updateFormData = vi.fn()
      render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
      openSheet()
      fireEvent.click(sheet().getByRole('radio', { name: /One column each/ }))
      // One click on the type pill selects every entity of that type.
      fireEvent.click(sheet().getByRole('button', { name: /^Domains/ }))

      expect(createButton()).toBeDisabled()
      expect(sheet().getByText(/more than a view can be read across/)).toBeInTheDocument()
      fireEvent.click(createButton())
      expect(updateFormData).not.toHaveBeenCalled()
    })
  })
})
