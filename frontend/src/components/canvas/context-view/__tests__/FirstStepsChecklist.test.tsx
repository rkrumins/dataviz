/**
 * FirstStepsChecklist — steps derive from REAL canvas/publish state; dismissal and
 * completion persist per graph.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { canvasState, containmentTypes, stagedCount } = vi.hoisted(() => ({
  canvasState: { nodes: [] as unknown[], edges: [] as unknown[] },
  containmentTypes: ['CONTAINS'],
  stagedCount: { value: 0 },
}))

vi.mock('@/store/canvas', () => ({
  useCanvasStore: (sel: (s: typeof canvasState) => unknown) => sel(canvasState),
}))
vi.mock('@/store/schema', () => ({
  useContainmentEdgeTypes: () => containmentTypes,
}))
vi.mock('@/store/stagedChangesStore', () => ({
  useStagedChangeCount: () => stagedCount.value,
}))

import { FirstStepsChecklist } from '../FirstStepsChecklist'

const node = (id: string, parentId?: string) => ({ id, data: parentId ? { parentId } : {} })
const edge = (edgeType: string) => ({ id: `e-${edgeType}`, data: { edgeType } })

describe('FirstStepsChecklist', () => {
  beforeEach(() => {
    localStorage.clear()
    canvasState.nodes = []
    canvasState.edges = []
    stagedCount.value = 0
  })

  it('shows zero progress on an empty canvas', () => {
    render(<FirstStepsChecklist graphId="g1" mainHeadSeq={1} />)
    expect(screen.getByText('0 of 4 done')).toBeInTheDocument()
  })

  it('ticks entity, child and connection steps from canvas state', () => {
    canvasState.nodes = [node('a'), node('b', 'a')]
    canvasState.edges = [edge('CONTAINS'), edge('FLOWS_TO')]
    render(<FirstStepsChecklist graphId="g1" mainHeadSeq={1} />)
    expect(screen.getByText('3 of 4 done')).toBeInTheDocument()
  })

  it('does not count AGGREGATED rollups as a user connection', () => {
    canvasState.nodes = [node('a')]
    canvasState.edges = [edge('AGGREGATED')]
    render(<FirstStepsChecklist graphId="g1" mainHeadSeq={1} />)
    expect(screen.getByText('1 of 4 done')).toBeInTheDocument()
  })

  it('hides itself once everything is done and persists completion', () => {
    canvasState.nodes = [node('a'), node('b', 'a')]
    canvasState.edges = [edge('CONTAINS'), edge('FLOWS_TO')]
    const { container } = render(<FirstStepsChecklist graphId="g1" mainHeadSeq={2} />)
    expect(container).toBeEmptyDOMElement()
    expect(localStorage.getItem('synodic-first-steps-dismissed:g1')).toBe('done')
  })

  it('dismisses on X and stays dismissed', async () => {
    render(<FirstStepsChecklist graphId="g2" mainHeadSeq={1} />)
    await userEvent.click(screen.getByTitle('Hide'))
    expect(screen.queryByText('First steps')).not.toBeInTheDocument()
    const again = render(<FirstStepsChecklist graphId="g2" mainHeadSeq={1} />)
    expect(again.container).toBeEmptyDOMElement()
  })
})
