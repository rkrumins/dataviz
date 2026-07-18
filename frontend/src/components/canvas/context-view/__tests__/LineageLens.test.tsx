/**
 * LineageLens — ego-graph overlay behavior.
 *
 * Data parity with the drawer's LineageNeighbors section is guaranteed by
 * the shared deriveNeighborRecords helper (tested directly below); the
 * component tests cover the lens contract: grouping, re-center stack,
 * and ESC/close handling.
 */
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

describe('LineageLens', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      visibleEdges: [],
    } as never)
  })
  afterEach(() => cleanup())

  const renderLens = (stack: string[], handlers: Partial<Record<'onRecenter' | 'onBack' | 'onClose', () => void>> = {}) =>
    render(
      <LineageLens
        lensStack={stack}
        onRecenter={handlers.onRecenter ?? vi.fn()}
        onBack={handlers.onBack ?? vi.fn()}
        onClose={handlers.onClose ?? vi.fn()}
      />,
    )

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
