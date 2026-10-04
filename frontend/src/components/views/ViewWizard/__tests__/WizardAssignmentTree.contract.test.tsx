/**
 * WizardAssignmentTree with placementContractEnabled on: the tree places each
 * node through the One Placement Contract, top-down with its parent's context,
 * and the coverage meter places each root the same way. The flag-off tree is
 * pinned by the other WizardAssignmentTree tests, unedited.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({}) }))

type FakeNode = {
  urn: string
  entityType: string
  displayName: string
  properties: Record<string, unknown>
  tags?: string[]
  layerAssignment?: string
}
type FakeEntry = {
  node: FakeNode
  childIds: string[]
  totalChildren: number
  totalIsExact: boolean
  hasMore: boolean
  nextOffset: number
  loaded: boolean
}

const entry = (node: Partial<FakeNode> & { urn: string; entityType: string; displayName: string }, childIds: string[] = []): [string, FakeEntry] =>
  [node.urn, {
    node: { properties: {}, ...node },
    childIds,
    totalChildren: childIds.length,
    totalIsExact: true,
    hasMore: false,
    nextOffset: 0,
    loaded: true,
  }]

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: [] as string[],
  nodes: new Map<string, FakeEntry>(),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([] as string[]),
  loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false,
  topLevelTotalCount: 0,
  topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
  failedIds: new Set<string>(),
  loadingNodes: new Set<string>(),
}

vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { WizardAssignmentTree, type BrowserSnapshot } from '../WizardAssignmentTree'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

const setContract = (on: boolean) =>
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, placementContractEnabled: on } })

function browse(entries: [string, FakeEntry][], topLevelIds: string[]) {
  fakeBrowser.nodes = new Map(entries)
  fakeBrowser.topLevelIds = topLevelIds
  fakeBrowser.topLevelTotalCount = topLevelIds.length
}

function renderTree(
  layers: ViewLayerConfig[],
  assignments: Record<string, LayerAssignmentEntry> = {},
  extra: Partial<React.ComponentProps<typeof WizardAssignmentTree>> = {},
) {
  return render(
    <WizardAssignmentTree
      layers={layers}
      assignments={assignments}
      entityScope="all"
      onAssignmentChange={vi.fn()}
      onBulkAssign={vi.fn()}
      {...extra}
    />,
  )
}

/** The tree row showing `name` (its title sits on the name). */
const row = (name: string) => screen.getByTitle(name).closest('.group') as HTMLElement
const expand = (name: string) => fireEvent.click(within(row(name)).getAllByRole('button')[0])
const badge = (name: string) => within(row(name)).queryByTestId('assigned-layer-badge')
const byType = (name: string) => within(row(name)).queryByTestId('rule-placed-marker')

const layer = (id: string, name: string, order: number, extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
  ({ id, name, order, entityTypes: [], ...extra })

beforeEach(() => setContract(true))
afterEach(() => {
  setContract(false)
  useReferenceModelStore.setState({ effectiveAssignments: new Map() })
})

describe('WizardAssignmentTree — contract tree', () => {
  // Finance (Domain) contains Ledger (Table) and Reports (Folder).
  beforeEach(() => browse([
    entry({ urn: 'urn:d', entityType: 'Domain', displayName: 'Finance' }, ['urn:t', 'urn:f']),
    entry({ urn: 'urn:t', entityType: 'Table', displayName: 'Ledger' }),
    entry({ urn: 'urn:f', entityType: 'Folder', displayName: 'Reports' }),
  ], ['urn:d']))

  const typed = [
    layer('domains', 'Domains', 0, { entityTypes: ['Domain'] }),
    layer('tables', 'Tables', 1, { entityTypes: ['Table'] }),
    layer('manual', 'Manual', 2),
  ]

  it('splits a child out of a rule-placed parent by its own rule; the rest inherit', () => {
    renderTree(typed)
    expand('Finance')

    expect(badge('Finance')).toHaveTextContent('Domains')
    expect(byType('Finance')).toBeInTheDocument()
    expect(badge('Ledger')).toHaveTextContent(/^Tables$/)
    expect(byType('Ledger')).toHaveTextContent('by type')
    expect(badge('Reports')).toHaveTextContent('↳ Domains')
    expect(byType('Reports')).not.toBeInTheDocument()
  })

  it('keeps the child in its parent column with the flag off (control)', () => {
    setContract(false)
    renderTree(typed)
    expand('Finance')
    expect(badge('Ledger')).toHaveTextContent('↳ Domains')
  })

  it('cascades a hand placement over the child’s own rule', () => {
    renderTree(typed, { 'urn:d': { layerId: 'manual', inheritsChildren: true } })
    expand('Finance')

    expect(badge('Finance')).toHaveTextContent(/^Manual$/)
    expect(badge('Ledger')).toHaveTextContent('↳ Manual')
    expect(badge('Reports')).toHaveTextContent('↳ Manual')
  })

  it('honours inheritsChildren: false — children fall to their own rule or nowhere', () => {
    renderTree(typed, { 'urn:d': { layerId: 'manual', inheritsChildren: false } })
    expand('Finance')

    expect(badge('Ledger')).toHaveTextContent(/^Tables$/)
    expect(badge('Reports')).not.toBeInTheDocument()
  })

  it('keeps an assigned parent under “Unassigned only” as the path to a child it leaves unassigned', () => {
    renderTree(typed, { 'urn:d': { layerId: 'manual', inheritsChildren: false } })
    expand('Finance')
    fireEvent.click(screen.getByRole('button', { name: /Unassigned only/ }))

    expect(screen.getByTitle('Finance')).toBeInTheDocument()
    expect(screen.getByTitle('Reports')).toBeInTheDocument()
    expect(screen.queryByTitle('Ledger')).not.toBeInTheDocument()
  })

  it('drops an assigned parent under “Unassigned only” when every child is assigned too', () => {
    renderTree(typed)
    expand('Finance')
    fireEvent.click(screen.getByRole('button', { name: /Unassigned only/ }))
    expect(screen.queryByTitle('Finance')).not.toBeInTheDocument()
  })

  it('drops the assigned parent with its whole subtree with the flag off (control)', () => {
    setContract(false)
    renderTree(typed, { 'urn:d': { layerId: 'manual', inheritsChildren: false } })
    expand('Finance')
    fireEvent.click(screen.getByRole('button', { name: /Unassigned only/ }))
    expect(screen.queryByTitle('Reports')).not.toBeInTheDocument()
  })

  it('honours a rule’s inheritsFromParent: false', () => {
    renderTree([
      layer('domains', 'Domains', 0, { rules: [{ id: 'r', priority: 0, entityTypes: ['Domain'], inheritsFromParent: false }] }),
      layer('tables', 'Tables', 1, { entityTypes: ['Table'] }),
    ])
    expand('Finance')

    expect(badge('Finance')).toHaveTextContent('Domains')
    expect(badge('Ledger')).toHaveTextContent(/^Tables$/)
    expect(badge('Reports')).not.toBeInTheDocument()
  })

  it('places by the first layer and folds type case', () => {
    renderTree([
      layer('first', 'First', 0, { entityTypes: ['domain'] }),
      layer('second', 'Second', 1, { entityTypes: ['Domain'] }),
    ])
    expect(badge('Finance')).toHaveTextContent('First')
  })

  it('ignores the store’s backend answer, which nothing computes under the contract', () => {
    useReferenceModelStore.setState({
      effectiveAssignments: new Map([['urn:d', { entityId: 'urn:d', layerId: 'manual', isInherited: false, confidence: 1 }]]),
    })
    renderTree([layer('manual', 'Manual', 0)])
    expect(badge('Finance')).not.toBeInTheDocument()
  })

  it('shows a fallback (showUnassigned) entity as unassigned — fallback is display only', () => {
    renderTree([layer('rest', 'Rest', 0, { showUnassigned: true })])
    expect(badge('Finance')).not.toBeInTheDocument()
  })
})

describe('WizardAssignmentTree — contract facts', () => {
  it('matches a tag rule against the node’s own tags', () => {
    browse([entry({ urn: 'urn:g', entityType: 'Table', displayName: 'Gold', tags: ['gold'] })], ['urn:g'])
    renderTree([layer('gold', 'Gold tier', 0, { rules: [{ id: 'r', priority: 0, tags: ['gold'] }] })])
    expect(badge('Gold')).toHaveTextContent('Gold tier')
    expect(byType('Gold')).toHaveTextContent('by rule')
    expect(byType('Gold')).toHaveAttribute('title', 'Placed automatically by a rule on this layer. Assign it elsewhere to override.')
  })

  it('places a stamped node without offering to remove an entry it does not have', () => {
    browse([entry({ urn: 'urn:s', entityType: 'Table', displayName: 'Stamped', layerAssignment: 'manual' })], ['urn:s'])
    renderTree([layer('manual', 'Manual', 0)])
    expect(badge('Stamped')).toHaveTextContent('Manual')
    expect(within(row('Stamped')).queryByTitle('Remove assignment')).not.toBeInTheDocument()
    expect(byType('Stamped')).toHaveTextContent('stamped')
    expect(byType('Stamped')).toHaveAttribute('title', "Placed by the entity's own layer setting. Assign it elsewhere to override.")
  })

  it('publishes facts on snapshot entries only with the flag on', () => {
    browse([entry({ urn: 'urn:s', entityType: 'Table', displayName: 'Stamped', layerAssignment: 'manual', tags: ['gold'] })], ['urn:s'])
    const onBrowserSnapshot = vi.fn<(snapshot: BrowserSnapshot) => void>()
    const { unmount } = renderTree([layer('manual', 'Manual', 0)], {}, { onBrowserSnapshot })
    const on = onBrowserSnapshot.mock.lastCall![0].directory.get('urn:s')!
    expect(on.facts).toMatchObject({ urn: 'urn:s', entityType: 'Table', stamp: 'manual', tags: ['gold'] })
    unmount()

    setContract(false)
    onBrowserSnapshot.mockClear()
    renderTree([layer('manual', 'Manual', 0)], {}, { onBrowserSnapshot })
    expect(onBrowserSnapshot.mock.lastCall![0].directory.get('urn:s')).not.toHaveProperty('facts')
  })
})

describe('WizardAssignmentTree — contract coverage meter', () => {
  const layers = [
    layer('domains', 'Domains', 0, { entityTypes: ['Domain'] }),
    layer('gold', 'Gold', 1, { rules: [{ id: 'r', priority: 0, tags: ['gold'] }] }),
    layer('manual', 'Manual', 2),
  ]
  const assignments: Record<string, LayerAssignmentEntry> = {
    'urn:a': { layerId: 'manual', inheritsChildren: true },    // explicit
    'urn:e': { layerId: 'deleted', inheritsChildren: true },   // stale, nothing else places it
    'urn:g': { layerId: 'deleted', inheritsChildren: true },   // stale, falls through to its rule
  }

  beforeEach(() => browse([
    entry({ urn: 'urn:a', entityType: 'Platform', displayName: 'A' }),
    entry({ urn: 'urn:b', entityType: 'Platform', displayName: 'B', layerAssignment: 'manual' }),
    entry({ urn: 'urn:c', entityType: 'Domain', displayName: 'C' }),
    entry({ urn: 'urn:d', entityType: 'Platform', displayName: 'D', tags: ['gold'] }),
    entry({ urn: 'urn:e', entityType: 'Platform', displayName: 'E' }),
    entry({ urn: 'urn:g', entityType: 'Domain', displayName: 'G' }),
    entry({ urn: 'urn:h', entityType: 'Platform', displayName: 'H' }),
  ], ['urn:a', 'urn:b', 'urn:c', 'urn:d', 'urn:e', 'urn:g', 'urn:h']))

  const placed = () => screen.getByText(/\/ 7 placed/).parentElement

  it('counts explicit, stamped and rule roots, and not a stale entry that places nothing', () => {
    renderTree(layers, assignments)
    // a (explicit), b (stamped), c (type rule), d (tag rule), g (stale, then its rule).
    expect(placed()).toHaveTextContent('5 / 7 placed')
    expect(screen.getByTitle('Manual: 2')).toBeInTheDocument()
    expect(screen.getByTitle('Domains: 2')).toBeInTheDocument()
    expect(screen.getByTitle('Gold: 1')).toBeInTheDocument()
  })

  it('agrees with the tree, row by row', () => {
    renderTree(layers, assignments)
    const badged = ['A', 'B', 'C', 'D', 'E', 'G', 'H'].filter(name => badge(name) !== null)
    expect(badged).toEqual(['A', 'B', 'C', 'D', 'G'])
  })

  it('counts the legacy way with the flag off (control)', () => {
    setContract(false)
    renderTree(layers, assignments)
    // Every entry, stale or not, plus the type rule on c; no stamp, no tags.
    expect(placed()).toHaveTextContent('4 / 7 placed')
  })
})
