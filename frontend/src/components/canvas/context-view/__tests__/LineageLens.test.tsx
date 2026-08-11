/**
 * LineageLens — ego-graph overlay behavior.
 *
 * Data parity with the drawer's LineageNeighbors section is guaranteed by
 * the shared deriveNeighborRecords helper (tested directly below); the
 * component tests cover the lens contract: grouping, re-center stack,
 * and ESC/close handling.
 */
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { deriveNeighborRecords } from '@/lib/lineage-neighbors'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePreferencesStore } from '@/store/preferences'
import { FRAME_ALL_CAP } from '../lens/focus-graph'

const node = (id: string, type = 'dataset'): LineageNode => ({
  id,
  type: 'custom',
  position: { x: 0, y: 0 },
  data: { label: `label-${id}`, type, urn: id },
} as unknown as LineageNode)

const edge = (id: string, source: string, target: string): LineageEdge => ({
  id, source, target, data: { edgeType: 'FLOWS_TO' },
} as unknown as LineageEdge)

describe('deriveNeighborRecords (shared with LineageNeighbors)', () => {
  it('splits incoming/outgoing and resolves neighbor nodes', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const { incomingRecords, outgoingRecords } = deriveNeighborRecords(
      'b',
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'b', 'ghost')],
      nodeMap,
      [],
    )
    expect(incomingRecords.map(r => r.neighborId)).toEqual(['a'])
    expect(outgoingRecords.map(r => r.neighborId)).toEqual(['c', 'ghost'])
    expect(outgoingRecords[1].neighborNode).toBeUndefined() // unloaded neighbor kept
  })
})

const renderLens = (
  stack: string[],
  handlers: Partial<Record<'onRecenter' | 'onBack' | 'onForward' | 'onClose', () => void>> = {},
  extra: Partial<ComponentProps<typeof LineageLens>> = {},
) =>
  render(
    <LineageLens
      history={{ entries: stack, cursor: stack.length - 1 }}
      onRecenter={handlers.onRecenter ?? vi.fn()}
      onBack={handlers.onBack ?? vi.fn()}
      onForward={handlers.onForward ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
      {...extra}
    />,
  )

describe('LineageLens', () => {
  beforeEach(() => {
    // Pin the LIST body — these suites assert the column layout; the
    // graph body has its own suite below.
    usePreferencesStore.setState({ lensViewMode: 'list' })
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
  })
  afterEach(() => cleanup())

  it('renders nothing when the stack is empty', () => {
    renderLens([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('centers the focal node with its upstream and downstream neighbors', () => {
    renderLens(['b'])
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByText('label-b').length).toBeGreaterThan(0)
    expect(screen.getByText('label-a')).toBeTruthy()   // upstream
    expect(screen.getByText('label-c')).toBeTruthy()   // downstream
  })

  it('clicking a neighbor re-centers', () => {
    const onRecenter = vi.fn()
    renderLens(['b'], { onRecenter })
    fireEvent.click(screen.getByText('label-c'))
    expect(onRecenter).toHaveBeenCalledWith('c')
  })

  it('shows Back only with stack depth > 1 and pops on click', () => {
    const onBack = vi.fn()
    renderLens(['a', 'b'], { onBack })
    fireEvent.click(screen.getByText('Back'))
    expect(onBack).toHaveBeenCalled()
  })

  it('Escape closes the lens', () => {
    const onClose = vi.fn()
    renderLens(['b'], { onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('LineageLens on-demand fetch merge', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
  })
  afterEach(() => cleanup())

  it('surfaces fetched edges and partner names the canvas never loaded', () => {
    useCanvasStore.setState({ nodes: [node('a')], edges: [], visibleEdges: [] } as never)
    renderLens(['a'], {}, {
      supplementalEdges: [edge('s1', 'a', 'x')],
      supplementalNodes: new Map([['x', node('x')]]),
    })
    expect(screen.getByText('label-x')).toBeTruthy()
  })

  it('dedupes a fetched edge the store already has as a (source, target, type) pair', () => {
    useCanvasStore.setState({
      nodes: [node('b'), node('c')],
      edges: [edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
    renderLens(['b'], {}, { supplementalEdges: [edge('other-id', 'b', 'c')] })
    expect(screen.getAllByText('label-c')).toHaveLength(1)
  })

  it('skips a fetched edge rolled into an aggregate that touches it, keeps one that is not', () => {
    const agg: LineageEdge = {
      id: 'agg1', source: 'a', target: 'P',
      data: { edgeType: 'FLOWS_TO', isAggregated: true, sourceEdgeCount: 2, sourceEdges: ['r1', 'r2'] },
    } as unknown as LineageEdge
    const aggElsewhere: LineageEdge = {
      id: 'agg2', source: 'P', target: 'Q',
      data: { edgeType: 'FLOWS_TO', isAggregated: true, sourceEdgeCount: 1, sourceEdges: ['r3'] },
    } as unknown as LineageEdge
    useCanvasStore.setState({
      nodes: [node('a'), node('P'), node('Q')],
      edges: [],
      visibleEdges: [agg, aggElsewhere],
    } as never)
    renderLens(['a'], {}, {
      // r1 is covered by agg1 (shares endpoint a) → hidden behind the
      // aggregate row; r3 belongs to an aggregate between OTHER nodes
      // → must surface, that's the invisible-lineage case.
      supplementalEdges: [edge('r1', 'a', 'c1'), edge('r3', 'a', 'c2')],
      supplementalNodes: new Map([['c1', node('c1')], ['c2', node('c2')]]),
    })
    expect(screen.queryByText('label-c1')).toBeNull()
    expect(screen.getByText('label-P')).toBeTruthy()
    expect(screen.getByText('label-c2')).toBeTruthy()
  })

  it('classic-mode ×N badge drills an aggregate into its constituents', () => {
    const agg: LineageEdge = {
      id: 'agg1', source: 'a', target: 'P',
      data: { edgeType: 'FLOWS_TO', isAggregated: true, sourceEdgeCount: 2, sourceEdges: ['r1', 'r2'] },
    } as unknown as LineageEdge
    useCanvasStore.setState({
      nodes: [node('a'), node('P'), node('c1')],
      edges: [edge('r1', 'a', 'c1')],
      visibleEdges: [agg],
    } as never)
    renderLens(['a'])
    // Constituents hidden until drilled.
    expect(screen.queryByText('label-c1')).toBeNull()
    fireEvent.click(screen.getByTitle(/Refine — see the 2 underlying connections/))
    expect(screen.getByText('label-c1')).toBeTruthy()
    // The unloaded remainder is reported, never invented.
    expect(screen.getByText(/\+1 more \(showing the first 1\)/)).toBeTruthy()
  })

  it('narrates an in-flight fetch instead of claiming "no connections"', () => {
    useCanvasStore.setState({ nodes: [node('a')], edges: [], visibleEdges: [] } as never)
    renderLens(['a'], {}, { fetchStatus: new Map([['a', 'loading' as const]]) })
    expect(screen.getByText(/Fetching upstream sources from the data source/)).toBeTruthy()
    expect(screen.getByText(/Fetching downstream consumers from the data source/)).toBeTruthy()
  })

  it('claims data-source truth (not canvas truth) once the fetch completed empty', () => {
    useCanvasStore.setState({ nodes: [node('a')], edges: [], visibleEdges: [] } as never)
    renderLens(['a'], {}, { fetchStatus: new Map([['a', 'done' as const]]) })
    expect(screen.getByText('No upstream sources in the data source')).toBeTruthy()
    expect(screen.getByText('No downstream consumers in the data source')).toBeTruthy()
  })

  it('surfaces a failed fetch with a Retry that re-kicks it', () => {
    useCanvasStore.setState({ nodes: [node('a')], edges: [], visibleEdges: [] } as never)
    const onRetryFetch = vi.fn()
    renderLens(['a'], {}, { fetchStatus: new Map([['a', 'error' as const]]), onRetryFetch })
    fireEvent.click(screen.getByText('Retry'))
    expect(onRetryFetch).toHaveBeenCalledWith('a')
  })

  it('groups field partners under their parent dataset and demotes coarser rollups', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { canContain: ['SCHEMAFIELD'] } },
          { id: 'SCHEMAFIELD', hierarchy: { canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({ nodes: [node('ds', 'DATASET')], edges: [], visibleEdges: [] } as never)
      const onRecenter = vi.fn()
      renderLens(['ds'], { onRecenter }, {
        supplementalEdges: [
          edge('f1', 'fieldA', 'ds'),
          { id: 'c1', source: 'parentDs', target: 'fieldA', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
          edge('f2', 'plat', 'ds'),
        ],
        supplementalNodes: new Map([
          ['fieldA', node('fieldA', 'SCHEMAFIELD')],
          ['parentDs', node('parentDs', 'DATASET')],
          ['plat', node('plat', 'CONTAINER')],
        ]),
        fetchStatus: new Map([['ds', 'done' as const]]),
      })
      // Field grouped under its parent dataset (structural story).
      expect(screen.getByText('label-parentDs')).toBeTruthy()
      expect(screen.getByText('label-fieldA')).toBeTruthy()
      // Coarser CONTAINER partner demoted to the labeled Rollups tier.
      expect(screen.getByText('Rollups')).toBeTruthy()
      expect(screen.getByText('label-plat')).toBeTruthy()
      expect(screen.getByText('rollup')).toBeTruthy()
      // Headline counts split by grain — units never mix.
      expect(screen.getByText(/1 direct connection · 1 rolled-up/)).toBeTruthy()
      // The header row toggles collapse; navigation lives on the
      // dedicated re-center button beside it.
      fireEvent.click(screen.getByTitle('Re-center on label-parentDs'))
      expect(onRecenter).toHaveBeenCalledWith('parentDs')
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('type chips toggle a grain off without silent loss (count stays visible)', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { canContain: ['SCHEMAFIELD'] } },
          { id: 'SCHEMAFIELD', hierarchy: { canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({ nodes: [node('ds', 'DATASET')], edges: [], visibleEdges: [] } as never)
      renderLens(['ds'], {}, {
        supplementalEdges: [edge('f1', 'fieldA', 'ds'), edge('f2', 'plat', 'ds')],
        supplementalNodes: new Map([
          ['fieldA', node('fieldA', 'SCHEMAFIELD')],
          ['plat', node('plat', 'CONTAINER')],
        ]),
      })
      expect(screen.getByText('label-plat')).toBeTruthy()
      // Toggle the CONTAINER chip off — rows hide, the count note appears.
      fireEvent.click(screen.getByText('CONTAINER'))
      expect(screen.queryByText('label-plat')).toBeNull()
      expect(screen.getByText(/1 connection hidden by the type chips/)).toBeTruthy()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('collapses parent groups by default at 3+ groups; chevron expands', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: { ...(prevSchema ?? {}), containmentEdgeTypes: ['CONTAINS'] },
    } as never)
    try {
      useCanvasStore.setState({ nodes: [node('ds')], edges: [], visibleEdges: [] } as never)
      renderLens(['ds'], {}, {
        supplementalEdges: [
          edge('f1', 'kid1', 'ds'),
          edge('f2', 'kid2', 'ds'),
          edge('f3', 'kid3', 'ds'),
          { id: 'c1', source: 'p1', target: 'kid1', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
          { id: 'c2', source: 'p2', target: 'kid2', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
          { id: 'c3', source: 'p3', target: 'kid3', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
        ],
        supplementalNodes: new Map([
          ['kid1', node('kid1')], ['kid2', node('kid2')], ['kid3', node('kid3')],
          ['p1', node('p1')], ['p2', node('p2')], ['p3', node('p3')],
        ]),
      })
      // Three parent groups → collapsed by default: headers with counts
      // visible, member rows hidden.
      expect(screen.getByText('label-p1')).toBeTruthy()
      expect(screen.queryByText('label-kid1')).toBeNull()
      // Chevron expands the group (header click would re-center instead).
      fireEvent.click(screen.getAllByTitle('Expand 1 connection')[0])
      expect(screen.getByText('label-kid1')).toBeTruthy()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('renders the SAME body at depth > 1: partners grouped under their parent, re-center on its button', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: { ...(prevSchema ?? {}), containmentEdgeTypes: ['CONTAINS'] },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('a'), node('b')],
        edges: [edge('e1', 'a', 'b')],
        visibleEdges: [],
      } as never)
      const onRecenter = vi.fn()
      renderLens(['a', 'b'], { onRecenter }, {
        onJumpTo: vi.fn(),
        supplementalEdges: [
          edge('f1', 'b', 'kid1'),
          edge('f2', 'b', 'kid2'),
          { id: 'c1', source: 'pd', target: 'kid1', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
          { id: 'c2', source: 'pd', target: 'kid2', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
        ],
        supplementalNodes: new Map([
          ['kid1', node('kid1')],
          ['kid2', node('kid2')],
          ['pd', node('pd')],
        ]),
      })
      // Depth 2 renders the standard columns — no layout flip: partners
      // grouped under their parent dataset, exactly like depth 1.
      expect(screen.getByText('label-pd')).toBeTruthy()
      expect(screen.getByText('label-kid1')).toBeTruthy()
      // The header row toggles collapse; navigation lives on the
      // dedicated re-center button beside it.
      fireEvent.click(screen.getByTitle('Re-center on label-pd'))
      expect(onRecenter).toHaveBeenCalledWith('pd')
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('path trail and headers carry the focal node\'s parent context', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: { ...(prevSchema ?? {}), containmentEdgeTypes: ['CONTAINS'] },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('a'), node('kid')],
        edges: [edge('e1', 'a', 'kid')],
        visibleEdges: [],
      } as never)
      renderLens(['a', 'kid'], {}, {
        onJumpTo: vi.fn(),
        supplementalEdges: [
          // P contains kid; P is NOT the previous hop, so the breadcrumb
          // must surface it (that's the expanded-parent context the bare
          // trail was losing).
          { id: 'c1', source: 'P', target: 'kid', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
        ],
        supplementalNodes: new Map([['P', node('P')]]),
      })
      expect(screen.getAllByText(/label-P/).length).toBeGreaterThanOrEqual(1)
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('Forward appears when the cursor is mid-path and steps forward without dropping hops', () => {
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
    const onForward = vi.fn()
    renderLens(['a'], { onForward }, {
      history: { entries: ['a', 'b', 'c'], cursor: 1 },
      onJumpTo: vi.fn(),
    })
    fireEvent.click(screen.getByText('Forward'))
    expect(onForward).toHaveBeenCalled()
  })

  it('ArrowRight steps forward; ignored while typing in the filter input', () => {
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
    const onForward = vi.fn()
    renderLens(['a'], { onForward }, {
      history: { entries: ['a', 'b', 'c'], cursor: 1 },
      onJumpTo: vi.fn(),
    })
    fireEvent.keyDown(screen.getByPlaceholderText('Filter connections…'), { key: 'ArrowRight' })
    expect(onForward).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onForward).toHaveBeenCalledTimes(1)
  })

  it('a forward trail chip stays visible and jumps the cursor there non-destructively', () => {
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
    const onJumpTo = vi.fn()
    renderLens(['a'], {}, {
      history: { entries: ['a', 'b', 'c'], cursor: 1 },
      onJumpTo,
    })
    // 'c' is AHEAD of the cursor — the old destructive stack would have
    // dropped it; the history keeps it visible and clickable.
    fireEvent.click(screen.getByTitle('Jump to label-c'))
    expect(onJumpTo).toHaveBeenCalledWith(2)
  })

  it('renders a walkable Contains group for a container focal (containment ≠ flow)', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: { ...(prevSchema ?? {}), containmentEdgeTypes: ['CONTAINS'] },
    } as never)
    try {
      useCanvasStore.setState({ nodes: [node('root')], edges: [], visibleEdges: [] } as never)
      const onRecenter = vi.fn()
      renderLens(['root'], { onRecenter }, {
        supplementalEdges: [
          { id: 'c1', source: 'root', target: 'kid', data: { edgeType: 'CONTAINS' } } as unknown as LineageEdge,
        ],
        supplementalNodes: new Map([['kid', node('kid')]]),
        fetchStatus: new Map([['root', 'done' as const]]),
      })
      expect(screen.getByText('Contains')).toBeTruthy()
      // Containment must NOT count as a flow connection.
      expect(screen.getByText(/0 direct connections · contains 1/)).toBeTruthy()
      fireEvent.click(screen.getByText('label-kid'))
      expect(onRecenter).toHaveBeenCalledWith('kid')
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })
})

describe('LineageLens graph mode', () => {
  beforeEach(() => {
    // Both are persisted preferences — pin them, or one test's header
    // click decides the next test's starting state.
    usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' })
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
  })
  afterEach(() => cleanup())

  it('renders upstream and downstream as cards; double-click focuses', () => {
    const onRecenter = vi.fn()
    renderLens(['b'], { onRecenter })
    // Focal + one card per neighbor (React Flow smoke — logic depth
    // lives in the pure focus-graph tests).
    expect(screen.getAllByText('label-b').length).toBeGreaterThan(0)
    expect(screen.getByText('label-a')).toBeTruthy()
    expect(screen.getByText('label-c')).toBeTruthy()
    // Edge types read as words, not tokens (FLOWS_TO → "Flows to").
    expect(screen.getAllByText('Flows to').length).toBeGreaterThan(0)
    fireEvent.doubleClick(screen.getByText('label-c'))
    expect(onRecenter).toHaveBeenCalledWith('c')
  })

  it('single click selects into the detail strip; Focus here re-centers', () => {
    const onRecenter = vi.fn()
    renderLens(['b'], { onRecenter })
    fireEvent.click(screen.getByText('label-c'))
    const focusBtn = screen.getByText('Focus here')
    expect(focusBtn).toBeTruthy()
    fireEvent.click(focusBtn)
    expect(onRecenter).toHaveBeenCalledWith('c')
  })

  it('a coarse partner offers a chevron that asks what is inside it', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      const onOpenContainer = vi.fn()
      renderLens(['ds'], {}, { onOpenContainer })

      // The coarse partner is not a dead end — it offers its contents,
      // on a control separate from the lineage hop.
      fireEvent.click(screen.getByTitle("Show what's inside label-plat"))
      // Opening asks the server for the next grain down (container level
      // 2 → 3), about the partner the card is connected to — the focal
      // itself at the first hop.
      expect(onOpenContainer).toHaveBeenCalledWith('plat', 'ds', 'in', 2)
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  // REGRESSION: "what's inside this" was only ever offered to a COARSER
  // partner, so an ordinary dataset upstream of your dataset had one ⊕
  // that did a lineage hop — its columns were simply unreachable, and
  // you had to re-center the whole lens to see them.
  it('a SAME-GRAIN neighbour offers its contents too, alongside its lineage hop', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'DATASET', hierarchy: { level: 3, canContain: ['FIELD'] } },
          { id: 'FIELD', hierarchy: { level: 4, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('up', 'DATASET')],
        edges: [edge('e1', 'up', 'ds')],
        visibleEdges: [],
      } as never)
      const onOpenContainer = vi.fn()
      const onEnsureFetched = vi.fn()
      renderLens(['ds'], {}, { onOpenContainer, onEnsureFetched })

      // Two controls, two questions — and using one leaves the other be.
      fireEvent.click(screen.getByTitle("Show what's inside label-up"))
      expect(onOpenContainer).toHaveBeenCalledWith('up', 'ds', 'in', 3)
      expect(onEnsureFetched).not.toHaveBeenCalled()

      // The frame keeps its hop control — looking inside must not end
      // the walk. (The lens re-asserts an unresolved open on re-render,
      // so compare across the click rather than counting from zero.)
      const opensBefore = onOpenContainer.mock.calls.length
      fireEvent.click(screen.getByTitle(/Expand the next hop upstream of label-up/))
      expect(onEnsureFetched).toHaveBeenCalledWith('up')
      expect(onOpenContainer.mock.calls.filter(c => c[0] !== 'up')).toHaveLength(0)
      expect(onOpenContainer.mock.calls.length).toBeGreaterThanOrEqual(opensBefore)
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('renders an opened container as a frame holding its connected children', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      const onRecenter = vi.fn()
      const onOpenContainer = vi.fn()
      renderLens(['ds'], { onRecenter }, {
        onOpenContainer,
        graphSeed: { nodeId: 'ds', expandedGroups: [], expandedFrontier: [], openContainers: ['in:plat'] },
        containerResults: new Map([['in:plat', {
          nodes: [node('kid1', 'DATASET'), node('kid2', 'DATASET')],
          edges: [edge('r1', 'kid1', 'ds'), edge('r2', 'kid2', 'ds')],
          passedThrough: [],
          truncated: false,
          empty: false,
        }]]),
        containerStatus: new Map([['in:plat', 'done' as const]]),
      })

      // Only the children that connect show, and they are real cards you
      // can keep exploring from.
      expect(screen.getByText('label-kid1')).toBeTruthy()
      expect(screen.getByText('label-kid2')).toBeTruthy()
      expect(screen.getByText(/2 connected inside/)).toBeTruthy()
      fireEvent.doubleClick(screen.getByText('label-kid1'))
      expect(onRecenter).toHaveBeenCalledWith('kid1')
      // The answer is already in hand, so nothing is re-asked.
      expect(onOpenContainer).not.toHaveBeenCalled()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  // REGRESSION: band overflow keys used to be `${dir}:${band}` (e.g.
  // "in:1"), which collides with the `${dir}:${urn}` space frames use.
  // The prefix-based dispatch routed band paging into frame paging, so
  // the band's "+N more" was a dead control.
  it('the band overflow card actually reveals more of the band', () => {
    const many = Array.from({ length: 35 }, (_, i) => node(`src${i}`))
    useCanvasStore.setState({
      nodes: [node('ds'), ...many],
      edges: many.map((n, i) => edge(`e${i}`, n.id, 'ds')),
      visibleEdges: [],
    } as never)
    renderLens(['ds'])

    // 30 of 35 fit under the cap; the rest sit behind one overflow card.
    expect(screen.getByText('+5 more')).toBeTruthy()
    expect(screen.getAllByText(/^label-src\d+$/)).toHaveLength(30)

    fireEvent.click(screen.getByText('+5 more'))
    expect(screen.getAllByText(/^label-src\d+$/)).toHaveLength(35)
    expect(screen.queryByText('+5 more')).toBeNull()
  })

  // REGRESSION: the contains stack was derived ONLY from containment
  // edges already on the canvas, while its total came from childCount.
  // So the lens would say "contains 128" and show none of them: you had
  // to leave Focus mode, expand the node on the canvas, and come back.
  // And the ASK is driven by the ontology, not by childCount: every
  // lineage and trace read path strips childCount server-side, so a
  // focal that arrived by a trace claims zero children it in fact has.
  it('asks for the focal\'s children, and shows them, without visiting the canvas', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'dataset', hierarchy: { level: 3, canContain: ['schemaField'] } },
          { id: 'schemaField', hierarchy: { level: 4, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds')],            // no childCount at all
        edges: [],                      // no containment edges loaded either
        visibleEdges: [],
      } as never)
      const onLoadChildrenOf = vi.fn()
      const { rerender } = render(
        <LineageLens
          history={{ entries: ['ds'], cursor: 0 }}
          onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
          onLoadChildrenOf={onLoadChildrenOf}
        />,
      )
      // It asks, because a dataset is a type that holds columns.
      expect(onLoadChildrenOf).toHaveBeenCalledWith('ds')

      // And once the answer lands, they are on screen — no canvas trip.
      rerender(
        <LineageLens
          history={{ entries: ['ds'], cursor: 0 }}
          onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
          onLoadChildrenOf={onLoadChildrenOf}
          childrenOf={new Map([['ds', {
            children: [node('col_a'), node('col_b'), node('col_c')],
            hasMore: false,
            total: 3,
          }]])}
          childrenStatusOf={new Map([['ds', 'done' as const]])}
        />,
      )
      // The stack starts collapsed, but it now names a real, openable
      // total rather than a count with nothing behind it.
      fireEvent.click(screen.getByText('contains 3'))
      // Named, not rendered as a urn tail — fetched children reach the
      // lens's node map like any other resolved entity.
      expect(screen.getByText('label-col_a')).toBeTruthy()
      expect(screen.getByText('label-col_b')).toBeTruthy()
      expect(screen.getByText('label-col_c')).toBeTruthy()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('does not ask for children of a type that can hold nothing', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        entityTypes: [{ id: 'schemaField', hierarchy: { level: 4, canContain: [] } }],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('col', 'schemaField')], edges: [], visibleEdges: [],
      } as never)
      const onLoadChildrenOf = vi.fn()
      renderLens(['col'], {}, { onLoadChildrenOf })
      expect(onLoadChildrenOf).not.toHaveBeenCalled()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  // REGRESSION: container answers were passed straight into the graph
  // builder and nowhere else, so entities the server had just NAMED for
  // an opened frame were unknown to the rest of the lens — they rendered
  // as a urn tail ("a random id"), typed "not loaded", flagged not on
  // canvas, and blank when focused.
  it('resolves names the canvas store never had from the container answer', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
        ],
      },
    } as never)
    try {
      // The canvas knows nothing about `deep-kid`.
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      renderLens(['ds'], {}, {
        onOpenContainer: vi.fn(),
        graphSeed: { nodeId: 'ds', expandedGroups: [], expandedFrontier: [], openContainers: ['in:plat'] },
        containerResults: new Map([['in:plat', {
          nodes: [node('urn:li:dataset:(sf,warehouse.public.deep_kid,PROD)', 'DATASET')],
          edges: [edge('r1', 'urn:li:dataset:(sf,warehouse.public.deep_kid,PROD)', 'ds')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:plat', 'done' as const]]),
      })
      // Its real label — not "PROD", the urn tail the unresolved
      // fallback produces and which reads as a random id.
      expect(screen.getByText('label-urn:li:dataset:(sf,warehouse.public.deep_kid,PROD)')).toBeTruthy()
      expect(screen.queryByText('PROD')).toBeNull()
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  // REGRESSION: a restored exploration put its open containers into
  // state but never re-asked the server, so a shared link reopened
  // frames that stayed empty forever. The kick is driven off the built
  // graph now, so it also names each frame's real partner.
  it('asks the server for a restored open that has no answer yet', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      const onOpenContainer = vi.fn()
      renderLens(['ds'], {}, {
        onOpenContainer,
        graphSeed: { nodeId: 'ds', expandedGroups: [], expandedFrontier: [], openContainers: ['in:plat'] },
      })
      expect(onOpenContainer).toHaveBeenCalledWith('plat', 'ds', 'in', 2)
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  describe('showing everything inside an opened frame', () => {
    const withSchema = (fn: () => void) => {
      const prevSchema = useSchemaStore.getState().schema
      useSchemaStore.setState({
        schema: {
          ...(prevSchema ?? {}),
          containmentEdgeTypes: ['CONTAINS'],
          entityTypes: [
            { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
            { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
          ],
        },
      } as never)
      try { fn() } finally { useSchemaStore.setState({ schema: prevSchema } as never) }
    }

    const openFrame = (extra: Partial<ComponentProps<typeof LineageLens>> = {}) => {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      return renderLens(['ds'], {}, {
        onOpenContainer: vi.fn(),
        graphSeed: { nodeId: 'ds', expandedGroups: [], expandedFrontier: [], openContainers: ['in:plat'] },
        containerResults: new Map([['in:plat', {
          nodes: [node('kid1', 'DATASET')],
          edges: [edge('r1', 'kid1', 'ds')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:plat', 'done' as const]]),
        ...extra,
      })
    }

    it('flips one frame to everything inside and fetches its children', () => withSchema(() => {
      const onLoadAllChildren = vi.fn()
      openFrame({ onLoadAllChildren })

      fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))
      expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat')
      // Flipping one frame is not a preference change.
      expect(usePreferencesStore.getState().lensFrameChildren).toBe('connected')
    }))

    it('shows unconnected children as present but claiming nothing', () => withSchema(() => {
      openFrame({
        onLoadAllChildren: vi.fn(),
        frameAllResults: new Map([['in:plat', {
          children: [node('kid1', 'DATASET'), node('spare', 'DATASET')],
          hasMore: false,
          total: 2,
        }]]),
        frameAllStatus: new Map([['in:plat', 'done' as const]]),
      })
      fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))

      expect(screen.getByText('label-kid1')).toBeTruthy()
      expect(screen.getByText('label-spare')).toBeTruthy()
      expect(screen.getByText('no lineage')).toBeTruthy()
      expect(screen.getByText(/1 connected · 2 of 2 shown/)).toBeTruthy()
    }))

    // A 428-column table used to grow the frame by a page per click
    // ("+N more inside" raised a cap), so five clicks left a ~2,000px
    // frame and 100 live cards. One window, moved.
    it('pages a wide table one fixed window at a time, and says which rows', () => withSchema(() => {
      const cols = Array.from({ length: 428 }, (_, i) => node(`col${String(i).padStart(3, '0')}`, 'DATASET'))
      const onLoadAllChildren = vi.fn()
      openFrame({
        onLoadAllChildren,
        graphSeed: {
          nodeId: 'ds', expandedGroups: [], expandedFrontier: [],
          openContainers: ['in:plat'], frameAll: ['in:plat'],
        },
        frameAllResults: new Map([['in:plat', { children: cols, hasMore: false, total: 428 }]]),
        frameAllStatus: new Map([['in:plat', 'done' as const]]),
      })

      const atMount = onLoadAllChildren.mock.calls.length
      const rows = cols.length + 1        // + the connected child the open found
      const pages = Math.ceil(rows / FRAME_ALL_CAP)
      // 429, not 428: the one child the pair-filtered open found is
      // appended to the server's child list, and the pager counts the
      // rows it can actually reach rather than stranding it.
      expect(screen.getByText(new RegExp(`showing 1–${FRAME_ALL_CAP} of ${rows}`))).toBeTruthy()
      expect(screen.getByText(`page 1 of ${pages}`)).toBeTruthy()
      expect(screen.getByText('label-col000')).toBeTruthy()
      expect(screen.queryByText(`label-col${String(FRAME_ALL_CAP).padStart(3, '0')}`)).toBeNull()
      // Nothing to go back to yet.
      expect(screen.getByTitle('Previous page').hasAttribute('disabled')).toBe(true)

      fireEvent.click(screen.getByTitle('Next page'))
      expect(screen.getByText(new RegExp(`showing ${FRAME_ALL_CAP + 1}–${FRAME_ALL_CAP * 2} of ${rows}`))).toBeTruthy()
      expect(screen.getByText(`page 2 of ${pages}`)).toBeTruthy()
      // The window MOVED — page 1's rows are gone, not stacked above.
      expect(screen.getByText(`label-col${String(FRAME_ALL_CAP).padStart(3, '0')}`)).toBeTruthy()
      expect(screen.queryByText('label-col000')).toBeNull()
      // Everything is already loaded, so turning a page asks for nothing
      // beyond the frame's own first-page kick at mount.
      expect(onLoadAllChildren).toHaveBeenCalledTimes(atMount)
    }))

    it('asks the server for one more page only when the window runs past what is loaded', () => withSchema(() => {
      // Exactly one window's worth fetched, with more on the server.
      const cols = Array.from({ length: FRAME_ALL_CAP }, (_, i) => node(`col${String(i).padStart(3, '0')}`, 'DATASET'))
      const onLoadAllChildren = vi.fn()
      openFrame({
        onLoadAllChildren,
        graphSeed: {
          nodeId: 'ds', expandedGroups: [], expandedFrontier: [],
          openContainers: ['in:plat'], frameAll: ['in:plat'],
        },
        frameAllResults: new Map([['in:plat', { children: cols, hasMore: true, total: null }]]),
        frameAllStatus: new Map([['in:plat', 'done' as const]]),
      })
      // Total unknown while the server still has more — the page count
      // is a floor, never a guess.
      expect(screen.getByText(/^page 1 of \d+\+$/)).toBeTruthy()
      const atMount = onLoadAllChildren.mock.calls.length

      // Page 2 runs past the fetched set: exactly one fetch.
      fireEvent.click(screen.getByTitle('Next page'))
      expect(onLoadAllChildren).toHaveBeenCalledTimes(atMount + 1)
      expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat', '')
    }))

    // REGRESSION: Find dimmed the loaded page client-side, so a column
    // on page 7 of a 428-column table could not be found at all.
    it('sends Find to the server and restarts the window at page 1', () => withSchema(() => {
      vi.useFakeTimers()
      try {
        const cols = Array.from({ length: 60 }, (_, i) => node(`col${String(i).padStart(3, '0')}`, 'DATASET'))
        const onLoadAllChildren = vi.fn()
        openFrame({
          onLoadAllChildren,
          graphSeed: {
            nodeId: 'ds', expandedGroups: [], expandedFrontier: [],
            openContainers: ['in:plat'], frameAll: ['in:plat'],
          },
          frameAllResults: new Map([['in:plat', { children: cols, hasMore: false, total: 60, query: '' }]]),
          frameAllStatus: new Map([['in:plat', 'done' as const]]),
        })
        fireEvent.click(screen.getByTitle('Next page'))
        expect(screen.getByText(/^page 2 of /)).toBeTruthy()
        onLoadAllChildren.mockClear()

        fireEvent.change(screen.getByPlaceholderText('Find…'), { target: { value: 'order' } })
        // A new list starts at the top, immediately — no waiting on the
        // debounce to stop showing a page the matches may not reach.
        expect(screen.getByText(/^page 1 of/)).toBeTruthy()
        expect(onLoadAllChildren).not.toHaveBeenCalled()   // still debouncing

        act(() => { vi.advanceTimersByTime(300) })
        expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat', 'order')
      } finally {
        vi.useRealTimers()
      }
    }))

    // REGRESSION: a page turn called onLoadAllChildren(openKey) with no
    // query while a search was active. The hook saw a different question,
    // refetched page 1 unfiltered and replaced the matches; the debounce
    // then re-ran the search 300ms later. One click, two round trips, a
    // flash of unrelated rows, and the window snapped back to page 1.
    it('keeps an active search when you turn the page or retry', () => withSchema(() => {
      // One window of matches loaded with more on the server, so page 2
      // runs past them and the turn DOES ask the server.
      const cols = Array.from({ length: FRAME_ALL_CAP }, (_, i) => node(`col${String(i).padStart(3, '0')}`, 'DATASET'))
      const onLoadAllChildren = vi.fn()
      openFrame({
        onLoadAllChildren,
        graphSeed: {
          nodeId: 'ds', expandedGroups: [], expandedFrontier: [],
          openContainers: ['in:plat'], frameAll: ['in:plat'],
        },
        frameAllResults: new Map([['in:plat', { children: cols, hasMore: true, total: null, query: 'order' }]]),
        frameAllStatus: new Map([['in:plat', 'done' as const]]),
      })
      fireEvent.change(screen.getByPlaceholderText('Find…'), { target: { value: 'order' } })
      onLoadAllChildren.mockClear()

      fireEvent.click(screen.getByTitle('Next page'))
      expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat', 'order')
      // Never the unfiltered list — that replaced the matches and cost a
      // second round trip when the debounce noticed.
      expect(onLoadAllChildren.mock.calls.every(c => c[1] === 'order')).toBe(true)
    }))

    // REGRESSION: firstPageAskedRef was keyed `${dir}:${urn}` with no
    // focal and cleared only when nodeId went null — which re-centering
    // never does. The second focal's frame never got its first page.
    it('still fetches a frame\'s first page after re-centering', () => withSchema(() => {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('other', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds'), edge('e2', 'plat', 'other')],
        visibleEdges: [],
      } as never)
      const onLoadAllChildren = vi.fn()
      const seed = (focal: string) => ({
        nodeId: focal, expandedGroups: [], expandedFrontier: [],
        openContainers: ['in:plat'], frameAll: ['in:plat'],
      })
      const props = (focal: string) => ({
        history: { entries: [focal], cursor: 0 },
        onRecenter: vi.fn(), onBack: vi.fn(), onForward: vi.fn(), onClose: vi.fn(),
        onOpenContainer: vi.fn(),
        onLoadAllChildren,
        graphSeed: seed(focal),
        containerResults: new Map([['in:plat', {
          nodes: [node('kid1', 'DATASET')], edges: [edge('r1', 'kid1', focal)],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:plat', 'done' as const]]),
      })
      const { rerender } = render(<LineageLens {...props('ds')} />)
      expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat')
      onLoadAllChildren.mockClear()

      // Same container, different focal — a different question, and the
      // caches are per focal, so it must be asked again.
      rerender(<LineageLens {...props('other')} />)
      expect(onLoadAllChildren).toHaveBeenCalledWith('in:plat')
    }))

    it('opens new frames in whichever mode the header default names', () => withSchema(() => {
      usePreferencesStore.setState({ lensFrameChildren: 'all' })
      const onLoadAllChildren = vi.fn()
      // No seed here — the frame is opened by clicking, as a user would.
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      renderLens(['ds'], {}, { onOpenContainer: vi.fn(), onLoadAllChildren })

      fireEvent.click(screen.getByTitle("Show what's inside label-plat"))
      // The frame comes up already in "everything inside".
      expect(screen.getByLabelText('Everything inside, lineage marked').getAttribute('aria-pressed')).toBe('true')
      usePreferencesStore.setState({ lensFrameChildren: 'connected' })
    }))
  })

  it('cards can be dragged to rearrange the picture', () => {
    useCanvasStore.setState({
      nodes: [node('ds'), node('src')],
      edges: [edge('e1', 'src', 'ds')],
      visibleEdges: [],
    } as never)
    renderLens(['ds'])
    // Every card is movable; the lineage is anchored to card ids, so
    // nothing about the connections depends on where they sit.
    // (The Lens portals to body, so query the document, not container.)
    const cards = document.querySelectorAll('.react-flow__node-focusCard')
    expect(cards.length).toBeGreaterThan(0)
    for (const c of cards) expect(c.className).toContain('draggable')
  })

  it('a frame moves as one piece — its children are not dragged out of it', () => {
    const prevSchema = useSchemaStore.getState().schema
    useSchemaStore.setState({
      schema: {
        ...(prevSchema ?? {}),
        containmentEdgeTypes: ['CONTAINS'],
        entityTypes: [
          { id: 'CONTAINER', hierarchy: { level: 2, canContain: ['DATASET'] } },
          { id: 'DATASET', hierarchy: { level: 3, canContain: [] } },
        ],
      },
    } as never)
    try {
      useCanvasStore.setState({
        nodes: [node('ds', 'DATASET'), node('plat', 'CONTAINER')],
        edges: [edge('e1', 'plat', 'ds')],
        visibleEdges: [],
      } as never)
      renderLens(['ds'], {}, {
        onOpenContainer: vi.fn(),
        graphSeed: { nodeId: 'ds', expandedGroups: [], expandedFrontier: [], openContainers: ['in:plat'] },
        containerResults: new Map([['in:plat', {
          nodes: [node('kid1', 'DATASET')],
          edges: [edge('r1', 'kid1', 'ds')],
          passedThrough: [], truncated: false, empty: false,
        }]]),
        containerStatus: new Map([['in:plat', 'done' as const]]),
      })

      // The frame itself is movable...
      const frame = document.querySelector('.react-flow__node-focusFrame')
      expect(frame?.className).toContain('draggable')
      // ...and carries its children, which are therefore not draggable
      // on their own — a table never sheds a column.
      const child = screen.getByText('label-kid1').closest('.react-flow__node')
      expect(child).toBeTruthy()
      expect(child!.className).not.toContain('draggable')
    } finally {
      useSchemaStore.setState({ schema: prevSchema } as never)
    }
  })

  it('the header default is a preference, persisted like the body mode', () => {
    renderLens(['b'])
    expect(usePreferencesStore.getState().lensFrameChildren).toBe('connected')
    fireEvent.click(screen.getByTitle(/Opened containers show everything inside/))
    expect(usePreferencesStore.getState().lensFrameChildren).toBe('all')
    usePreferencesStore.setState({ lensFrameChildren: 'connected' })
  })

  it('the header toggle switches to the list body and persists the preference', () => {
    renderLens(['b'])
    // The graph shows band headers ("Data Sources") too — the LIST
    // body is identified by its column subtitles.
    expect(screen.queryByText('Upstream')).toBeNull()
    fireEvent.click(screen.getByTitle('List — scan all connections as columns'))
    expect(screen.getByText('Upstream')).toBeTruthy()
    expect(usePreferencesStore.getState().lensViewMode).toBe('list')
  })
})
