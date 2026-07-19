/**
 * LineageLens — ego-graph overlay behavior.
 *
 * Data parity with the drawer's LineageNeighbors section is guaranteed by
 * the shared deriveNeighborRecords helper (tested directly below); the
 * component tests cover the lens contract: grouping, re-center stack,
 * and ESC/close handling.
 */
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { deriveNeighborRecords } from '@/lib/lineage-neighbors'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'

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
  handlers: Partial<Record<'onRecenter' | 'onBack' | 'onClose', () => void>> = {},
  extra: Partial<ComponentProps<typeof LineageLens>> = {},
) =>
  render(
    <LineageLens
      lensStack={stack}
      onRecenter={handlers.onRecenter ?? vi.fn()}
      onBack={handlers.onBack ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
      {...extra}
    />,
  )

describe('LineageLens', () => {
  beforeEach(() => {
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
})
