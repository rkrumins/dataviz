/**
 * LineageLens — full walk (trace mode) header surface.
 *
 * The hook drives the walk; the lens's job here is to SAY where it
 * stands — walking, complete, budget-capped, or stalled — and to offer
 * the two controls: the One hop / Full flow mode toggle, and the
 * "keep walking" continuation. Every state below is a prop; the driver
 * itself is covered in useLensWalk.test.ts.
 */
import type { ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LineageLens } from '../LineageLens'
import type { WalkEntry, FullWalkStatus } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'

const wnode = (urn: string, type = 'dataset'): LensWalkNode => ({
  id: urn,
  type: 'generic',
  position: { x: 0, y: 0 },
  data: { urn, label: urn, type },
  urn,
  displayName: urn,
  entityType: type,
}) as unknown as LensWalkNode

function walkModel(focusUrn: string, nodes: LensWalkNode[]): LensWalkModel {
  return {
    focusUrn,
    nodes,
    lineageEdges: [],
    containmentEdges: [],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    frontierUp: [],
    frontierDown: [],
    truncated: false,
    truncationReason: null,
    seedTruncated: false,
    seedCursor: null,
  }
}

const doneWalk = (model: LensWalkModel): WalkEntry => ({
  model, status: 'done', error: null, extendStatus: new Map(), depth: 25,
})

const status = (parts: Partial<FullWalkStatus>): FullWalkStatus => ({
  walking: false, exhausted: false, budgetHit: false, stalled: false, ...parts,
})

function renderLens(extra: Partial<ComponentProps<typeof LineageLens>> = {}) {
  const walk = doneWalk(walkModel('F', [wnode('F'), wnode('up1')]))
  return render(
    <LineageLens
      history={{ entries: ['F'], cursor: 0 }}
      walk={walk}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
      {...extra}
    />,
  )
}

describe('LineageLens — full walk surface', () => {
  it('says it is tracing the full flow, with the running node count, while walking', () => {
    renderLens({ fullWalkEnabled: true, fullWalkStatus: status({ walking: true }) })
    expect(screen.getByText(/tracing the full flow · 2 nodes/i)).toBeInTheDocument()
  })

  it('says the full flow is drawn once the walk exhausts', () => {
    renderLens({ fullWalkEnabled: true, fullWalkStatus: status({ exhausted: true }) })
    expect(screen.getByText(/full flow drawn/i)).toBeInTheDocument()
  })

  it('offers to keep walking when the budget was hit, wired to the continuation', () => {
    const onFullWalkContinue = vi.fn()
    renderLens({ fullWalkEnabled: true, fullWalkStatus: status({ budgetHit: true }), onFullWalkContinue })
    expect(screen.getByText(/the flow continues past 2 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(onFullWalkContinue).toHaveBeenCalledTimes(1)
  })

  it('says the walk stalled when steps failed, and "Try again" re-arms them', () => {
    const onFullWalkContinue = vi.fn()
    renderLens({ fullWalkEnabled: true, fullWalkStatus: status({ stalled: true }), onFullWalkContinue })
    expect(screen.getByText(/part of the flow could not be walked/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onFullWalkContinue).toHaveBeenCalledTimes(1)
  })

  it('renders the Walk mode toggle and reports the switch', () => {
    const onFullWalkToggle = vi.fn()
    renderLens({ fullWalkEnabled: false, fullWalkStatus: null, onFullWalkToggle })
    const oneHop = screen.getByRole('button', { name: /one hop/i })
    const fullFlow = screen.getByRole('button', { name: /full flow/i })
    expect(oneHop).toHaveAttribute('aria-pressed', 'true')
    expect(fullFlow).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(fullFlow)
    expect(onFullWalkToggle).toHaveBeenCalledWith(true)
  })

  it('shows none of the full-walk surface when the feature is not wired', () => {
    renderLens()
    expect(screen.queryByText(/tracing the full flow/i)).toBeNull()
    expect(screen.queryByText(/full flow drawn/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /one hop/i })).toBeNull()
  })
})

describe('LineageLens — capped focus contents offer a manual page', () => {
  it('the floors strip gains "Load more contents" when a seedCursor is open, wired to pageSeeds', () => {
    const pageSeeds = vi.fn()
    const walk = doneWalk({
      ...walkModel('F', [wnode('F'), wnode('w1')]),
      seedTruncated: true,
      seedCursor: 's:w1',
    })
    render(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={walk}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn(), pageSeeds }}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /load more contents/i }))
    expect(pageSeeds).toHaveBeenCalledWith('F')
  })
})

describe('LineageLens — the partial-picture strip tells the truth and offers the way to ALL of it', () => {
  const cappedWalk = () => doneWalk({
    ...walkModel('F', [wnode('F'), wnode('up1'), wnode('up2'), wnode('down1')]),
    upstreamUrns: new Set(['up1', 'up2']),
    downstreamUrns: new Set(['down1']),
    truncated: true,
    truncationReason: 'max_nodes',
  })

  it('states per-direction on-board counts in plain language, not a reason token', () => {
    render(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={cappedWalk()}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/2 upstream · 1 downstream on the board/i)).toBeInTheDocument()
    expect(screen.queryByText(/max_nodes/)).toBeNull()
  })

  it('offers "Load everything", wired to the full-flow switch', () => {
    const onFullWalkToggle = vi.fn()
    render(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={cappedWalk()}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
        fullWalkEnabled={false} fullWalkStatus={null} onFullWalkToggle={onFullWalkToggle}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /load everything/i }))
    expect(onFullWalkToggle).toHaveBeenCalledWith(true)
  })

  it('does not offer "Load everything" once the full walk is already on', () => {
    render(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={cappedWalk()}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
        fullWalkEnabled fullWalkStatus={null} onFullWalkToggle={vi.fn()}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /load everything/i })).toBeNull()
  })
})
