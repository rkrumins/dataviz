/**
 * LayerStudio — reordering a column's rows.
 *
 * The rail drives the canvas's own mutations (setLayerNodeSortMode,
 * ensureSiblingOrderKeys, keysForInsertion), so an arrangement built in the
 * wizard is the one the canvas renders. The case that matters most: a
 * RULE-placed row holds no assignment entry, and reordering it has to mint an
 * order-carrier entry rather than silently doing nothing.
 *
 * Renders the REAL LayerHierarchyPanel — the drag gesture is the thing under test.
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
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({
    entityTypes: [{
      id: 'domain', name: 'domain', pluralName: 'Domains',
      visual: { icon: 'Box', color: '#8b5cf6', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
      fields: [], hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false }, behavior: {},
    }],
    relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [],
    rootEntityTypes: ['domain'], isLoading: false, isError: false,
  }),
}))

const node = (urn: string, name: string, kids = 0) => [urn, {
  node: { urn, entityType: 'domain', displayName: name, properties: {} },
  childIds: [], totalChildren: kids, hasMore: false, nextCursor: null, loaded: true,
}] as const

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:a', 'urn:b', 'urn:c'],
  nodes: new Map([
    node('urn:a', 'Agriculture', 5),
    node('urn:b', 'Banking', 9),
    node('urn:c', 'Chemicals', 1),
  ]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(), setSearch: vi.fn(), setTypeFilter: vi.fn(), expandNode: vi.fn(),
  loadMoreChildren: vi.fn(), loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([]), loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false, topLevelTotalCount: 3,
  topLevelMetadata: { rootTypeCount: 3, orphanCount: 0 },
  loadingNodes: new Set<string>(),
}
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { LayerStudio } from '../LayerStudio'

/** One column whose type rule places all three domains — none holds an entry. */
const ruleLayer: ViewLayerConfig[] = [
  { id: 'l1', name: 'Domains', entityTypes: ['domain'], order: 0, sequence: 0 },
]

function makeFormData(overrides: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'T', description: '', icon: 'Layout', visibility: 'private', tags: [],
    layoutType: 'reference', dataSourceId: 'ds1',
    layers: ruleLayer, assignments: {},
    visibleEntityTypes: [], visibleRelationshipTypes: [], advancedFilters: [], isValid: true,
    ...overrides,
  }
}

/** The layer rail — the entity tree behind it renders the same names. */
const rail = () => within(screen.getByTestId('layer-hierarchy-panel'))

/** The rail's row for `name` — the element carrying the reorder drop handlers. */
function row(name: string): HTMLElement {
  const label = rail().getByText(name)
  const draggable = label.closest('[draggable]') as HTMLElement
  return draggable.parentElement as HTMLElement
}

/** Drag `from` onto `to`, landing in the given third of the row.
 *
 *  jsdom has no DragEvent, so fireEvent's fallback drops mouse coordinates —
 *  and the band is chosen from clientY. Dispatch real MouseEvents instead and
 *  hang the transfer off them by hand. */
function dragOnto(from: string, to: string, clientY: number) {
  const data = new Map<string, string>()
  const dataTransfer = {
    setData: (k: string, v: string) => { data.set(k, v) },
    getData: (k: string) => data.get(k) ?? '',
    types: ['application/x-entity-assignment'],
    effectAllowed: '', dropEffect: '',
    setDragImage: () => {},
  }
  const send = (target: HTMLElement, type: string) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    fireEvent(target, event)
  }
  send(row(from).querySelector('[draggable]') as HTMLElement, 'dragstart')
  send(row(to), 'dragover')
  send(row(to), 'drop')
}

const lastCommit = (fn: ReturnType<typeof vi.fn>) =>
  [...fn.mock.calls].reverse().find(c => 'layers' in c[0])?.[0]

describe('LayerStudio — reordering rule-placed rows', () => {
  it('lists the column\'s rule-placed roots alphabetically to begin with', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    const names = rail().getAllByText(/^(Agriculture|Banking|Chemicals)$/).map(n => n.textContent)
    expect(names).toEqual(['Agriculture', 'Banking', 'Chemicals'])
  })

  it('dropping on a row\'s top third mints an order key and adopts custom order', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    dragOnto('Chemicals', 'Agriculture', 10)   // above the first row

    const call = lastCommit(updateFormData)
    expect(call).toBeDefined()
    // The column switches to a manual arrangement...
    expect(call.layers[0].nodeSortMode).toBe('custom')
    // ...and the moved row now sorts FIRST.
    const keys = call.assignments
    expect(keys['urn:c']?.orderKey).toBeTruthy()
    expect(keys['urn:c'].orderKey < keys['urn:a'].orderKey).toBe(true)
  })

  it('mints an order-carrier entry for a row that had no assignment at all', () => {
    // The whole point: these rows are placed by the TYPE RULE, so there is no
    // entry to hang an orderKey on until the reorder creates one.
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)
    expect(makeFormData().assignments).toEqual({})

    dragOnto('Chemicals', 'Agriculture', 10)

    const call = lastCommit(updateFormData)
    expect(Object.keys(call.assignments).sort()).toEqual(['urn:a', 'urn:b', 'urn:c'])
    // The carrier keeps them in the same column — a reorder is not a move.
    expect(call.assignments['urn:c'].layerId).toBe('l1')
    expect(call.assignments['urn:c'].inheritsChildren).toBe(true)
  })

  it('dropping on the bottom third puts it after the target', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    dragOnto('Agriculture', 'Banking', 800)    // below the second row

    const { assignments } = lastCommit(updateFormData)
    expect(assignments['urn:b'].orderKey < assignments['urn:a'].orderKey).toBe(true)
  })

  it('dropping on the middle third is not a reorder', () => {
    const updateFormData = vi.fn()
    render(<LayerStudio formData={makeFormData()} updateFormData={updateFormData} />)

    dragOnto('Chemicals', 'Agriculture', 450)  // the middle — a move, not a sort

    const call = lastCommit(updateFormData)
    expect(call?.layers?.[0]?.nodeSortMode).toBeUndefined()
  })

  it('leaves an existing manual arrangement in custom mode', () => {
    const updateFormData = vi.fn()
    render(
      <LayerStudio
        formData={makeFormData({ layers: [{ ...ruleLayer[0], nodeSortMode: 'custom' }] })}
        updateFormData={updateFormData}
      />
    )
    dragOnto('Chemicals', 'Agriculture', 10)
    expect(lastCommit(updateFormData).layers[0].nodeSortMode).toBe('custom')
  })
})

describe('LayerStudio — column sort', () => {
  const openSortMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: /^Sort Domains/ }))
  }

  it('offers the column a sort menu', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Sort Domains/ })).toBeInTheDocument()
  })

  it('orders rows by the column\'s own sort mode', () => {
    render(
      <LayerStudio
        formData={makeFormData({ layers: [{ ...ruleLayer[0], nodeSortMode: 'alpha-desc' }] })}
        updateFormData={vi.fn()}
      />
    )
    const names = rail().getAllByText(/^(Agriculture|Banking|Chemicals)$/).map(n => n.textContent)
    expect(names).toEqual(['Chemicals', 'Banking', 'Agriculture'])
  })

  it('puts the biggest containers first under count-desc', () => {
    render(
      <LayerStudio
        formData={makeFormData({ layers: [{ ...ruleLayer[0], nodeSortMode: 'count-desc' }] })}
        updateFormData={vi.fn()}
      />
    )
    const names = rail().getAllByText(/^(Agriculture|Banking|Chemicals)$/).map(n => n.textContent)
    expect(names).toEqual(['Banking', 'Agriculture', 'Chemicals'])   // 9, 5, 1
  })

  it('follows the view default when the column has no override', () => {
    render(
      <LayerStudio
        formData={makeFormData({ defaultNodeSortMode: 'alpha-desc' })}
        updateFormData={vi.fn()}
      />
    )
    const names = rail().getAllByText(/^(Agriculture|Banking|Chemicals)$/).map(n => n.textContent)
    expect(names).toEqual(['Chemicals', 'Banking', 'Agriculture'])
  })

  it('opens without throwing', () => {
    render(<LayerStudio formData={makeFormData()} updateFormData={vi.fn()} />)
    expect(openSortMenu).not.toThrow()
  })
})
