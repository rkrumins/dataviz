/**
 * WizardAssignmentTree — RTL tests.
 *
 * The tree communicates assignment changes ONLY via onAssignmentChange/onBulkAssign
 * props (Task 4: canonical view-config store). It must never write to the
 * referenceModelStore directly — that store is a render cache now, not a writer.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

type FakeEntry = {
  node: { urn: string; entityType: string; displayName: string; properties: Record<string, unknown> }
  childIds: string[]
  totalChildren: number
  totalIsExact: boolean
  hasMore: boolean
  nextCursor: string | null
  loaded: boolean
}

function nodeA(overrides: Partial<FakeEntry> = {}): FakeEntry {
  return {
    node: { urn: 'urn:a', entityType: 'domain', displayName: 'Node A', properties: {} },
    childIds: [],
    totalChildren: 0,
    totalIsExact: true,
    hasMore: false,
    nextCursor: null,
    loaded: true,
    ...overrides,
  }
}

function child(urn: string, name: string, overrides: Partial<FakeEntry> = {}): FakeEntry {
  return {
    node: { urn, entityType: 'domain', displayName: name, properties: {} },
    childIds: [],
    totalChildren: 0,
    totalIsExact: true,
    hasMore: false,
    nextCursor: null,
    loaded: true,
    ...overrides,
  }
}

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:a'],
  nodes: new Map<string, FakeEntry>([['urn:a', nodeA()]]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  // loadAllChildren resolves the ids it loaded — the select-all path reads .length
  // off it. Defaulting to undefined made every un-stubbed call reject *after* the
  // assertions had run: green test, unhandled TypeError. [] is the honest "loaded
  // nothing".
  loadAllChildren: vi.fn().mockResolvedValue([] as string[]),
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

    expect(screen.getByTestId('assigned-layer-badge')).toHaveTextContent('Layer 2')
  })
})

describe('WizardAssignmentTree — coverage, filtering and bulk selection', () => {
  afterEach(() => {
    fakeBrowser.nodes = new Map<string, FakeEntry>([['urn:a', nodeA()]])
    fakeBrowser.loadAllChildren.mockClear()
  })

  function renderTree(props: Partial<React.ComponentProps<typeof WizardAssignmentTree>> = {}) {
    return render(
      <WizardAssignmentTree
        layers={layers}
        assignments={{}}
        onAssignmentChange={vi.fn()}
        onBulkAssign={vi.fn()}
        {...props}
      />
    )
  }

  it('reports how many top-level entities are placed', () => {
    renderTree({ assignments: { 'urn:a': { layerId: 'l2', inheritsChildren: true } } })

    // 1 of 1 top-level entities placed — the honest "am I done?" signal.
    expect(screen.getByText(/\/ 1 placed/)).toBeInTheDocument()
  })

  it('"Unassigned only" hides entities that already have a layer', () => {
    renderTree({ assignments: { 'urn:a': { layerId: 'l2', inheritsChildren: true } } })

    expect(screen.getByText('Node A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Unassigned only/i }))
    expect(screen.queryByText('Node A')).not.toBeInTheDocument()
  })

  it('assigns the selection to the Nth layer when 1–9 is pressed', () => {
    const onBulkAssign = vi.fn()
    renderTree({ onBulkAssign })

    fireEvent.click(screen.getByText('Node A'))       // select the row
    fireEvent.keyDown(window, { key: '2' })           // → second layer

    expect(onBulkAssign).toHaveBeenCalledWith('l2', ['urn:a'])
  })

  it('never hijacks digits typed into the search box', () => {
    const onBulkAssign = vi.fn()
    renderTree({ onBulkAssign })

    fireEvent.click(screen.getByText('Node A'))
    fireEvent.keyDown(screen.getByPlaceholderText(/Search entities/i), { key: '1' })

    expect(onBulkAssign).not.toHaveBeenCalled()
  })

  it('"Select its N children only" pages in every remaining child before selecting', async () => {
    // 888 children, only the first page loaded — the exact case that used to
    // mean clicking "Load more" seventeen times.
    fakeBrowser.nodes = new Map<string, FakeEntry>([
      ['urn:a', nodeA({ totalChildren: 888, hasMore: true, nextCursor: 'cursor-1', loaded: true })],
    ])
    renderTree()

    fireEvent.click(screen.getByText('Node A'))
    fireEvent.click(screen.getByRole('button', { name: /Select its 888 children only/i }))

    await waitFor(() => expect(fakeBrowser.loadAllChildren).toHaveBeenCalledWith('urn:a'))
  })

  it('selects the children — WITHOUT the parent — on the FIRST click', async () => {
    // Two contracts in one:
    //  1. The stale-state regression: loadAllChildren resolved but React hadn't
    //     re-rendered, so the old code read the pre-load node and selected only
    //     the parent. The loader RETURNS the ids now, so one click is enough.
    //  2. "Children only" means only the children. Selecting the parent as well
    //     would just be a slow way of placing the parent (its children inherit),
    //     and would give no way to place children WITHOUT their parent.
    fakeBrowser.nodes = new Map<string, FakeEntry>([
      ['urn:a', nodeA({ totalChildren: 2, hasMore: true, nextCursor: 'c1', loaded: true })],
    ])
    fakeBrowser.loadAllChildren.mockImplementationOnce(async (urn: string) => {
      // Simulate the hook: children land in the map and the ids come back.
      // A NEW Map — the tree memoises on map identity, as the real hook does.
      fakeBrowser.nodes = new Map<string, FakeEntry>([
        [urn, nodeA({
          totalChildren: 2, hasMore: false, nextCursor: null, loaded: true,
          childIds: ['urn:c1', 'urn:c2'],
        })],
        ['urn:c1', child('urn:c1', 'Child One')],
        ['urn:c2', child('urn:c2', 'Child Two')],
      ])
      return ['urn:c1', 'urn:c2']
    })
    const onBulkAssign = vi.fn()
    renderTree({ onBulkAssign })

    fireEvent.click(screen.getByTitle('Node A'))
    fireEvent.click(screen.getByRole('button', { name: /Select its 2 children only/i }))

    // Generous: this awaits a paged load AND a virtualized re-render, which can
    // outrun the 1s default when the suite runs files in parallel.
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument(), { timeout: 5000 })
    // And it says so, so nobody places children without their parent by accident.
    expect(screen.getByText(/itself won’t be placed/)).toBeInTheDocument()

    // Placing sends the two children and NOT the parent.
    fireEvent.keyDown(window, { key: '1' })
    expect(onBulkAssign).toHaveBeenCalledWith('l1', ['urn:c1', 'urn:c2'])
  })

  it('reports a child count the server actually gave (never the paging heuristic)', () => {
    fakeBrowser.nodes = new Map<string, FakeEntry>([
      ['urn:a', nodeA({ totalChildren: 200, totalIsExact: true, hasMore: true, loaded: true })],
    ])
    renderTree()

    // 200 — the real count. Before, expanding overwrote this with `offset + page + 1` = 51.
    expect(screen.getByTitle('200 children')).toHaveTextContent('200')
  })

  it('marks an unknown total as a floor rather than inventing one', () => {
    fakeBrowser.nodes = new Map<string, FakeEntry>([
      ['urn:a', nodeA({ totalChildren: 50, totalIsExact: false, hasMore: true, loaded: true })],
    ])
    renderTree()

    expect(screen.getByText('50+')).toBeInTheDocument()
  })

  it('releasing a parent releases its children too', async () => {
    // Parent with two loaded children; select the children, then add the parent
    // so the whole subtree is ticked.
    fakeBrowser.nodes = new Map<string, FakeEntry>([
      ['urn:a', nodeA({ totalChildren: 2, loaded: true, childIds: ['urn:c1', 'urn:c2'] })],
      ['urn:c1', child('urn:c1', 'Child One')],
      ['urn:c2', child('urn:c2', 'Child Two')],
    ])
    fakeBrowser.loadAllChildren.mockResolvedValueOnce(['urn:c1', 'urn:c2'])
    const onBulkAssign = vi.fn()
    renderTree({ onBulkAssign })

    // getByTitle targets the ROW: the parent's name also appears in the toolbar's
    // "…itself won’t be placed" line once its children are selected.
    fireEvent.click(screen.getByTitle('Node A'))
    fireEvent.click(screen.getByRole('button', { name: /Select its 2 children only/i }))
    // Generous: this awaits a paged load AND a virtualized re-render, which can
    // outrun the 1s default when the suite runs files in parallel.
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument(), { timeout: 5000 })

    fireEvent.click(screen.getByTitle('Node A'), { metaKey: true })   // add the parent
    await waitFor(() => expect(screen.getByText('3 selected')).toBeInTheDocument())

    // Now release the parent — the children must not be left behind silently
    // selected, or the next placement quietly drags them along.
    fireEvent.click(screen.getByTitle('Node A'), { metaKey: true })

    await waitFor(() => expect(screen.queryByText('3 selected')).not.toBeInTheDocument())
    // Nothing is selected any more, so a quick-assign key must do nothing.
    fireEvent.keyDown(window, { key: '1' })
    expect(onBulkAssign).not.toHaveBeenCalled()
  })
})
