/**
 * LineageLens — the walk surface (2026-08-21: hands-free in both modes).
 *
 * The hook drives the walk; the lens's job here is to SAY where it stands
 * — the immediate lineage loading, the full flow walking, complete — with
 * counts ticking (never a percent), and to offer only the two valves that
 * can still stop a walk: the one-time memory checkpoint ("Continue") and a
 * retry for failed steps. There is no "Keep walking", no "Load everything",
 * no "Load more contents": nothing at hop 1 ever needs a click. Every
 * state below is a prop; the driver itself is covered in useLensWalk.test.ts.
 */
import type { ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LineageLens } from '../LineageLens'
import type { WalkEntry, WalkProgress } from '@/hooks/useLensWalk'
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

const progress = (parts: Partial<WalkProgress>): WalkProgress => ({
  phase: 'done', nodes: 2, flows: 0, requests: 1, pending: 0, unbounded: false, error: null, ...parts,
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

describe('LineageLens — the walk narrates itself', () => {
  it('one hop: says the immediate lineage is loading, with counts ticking', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'seeding', nodes: 1240, flows: 3100, requests: 3 }) })
    expect(screen.getByTestId('lens-walk-narration')).toHaveTextContent('loading the immediate lineage · 1,240 nodes · 3,100 flows · 3 requests')
  })

  it('full flow: says it is walking the full flow, with counts ticking', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'walking', nodes: 12400, flows: 8910, requests: 17 }) })
    expect(screen.getByTestId('lens-walk-narration')).toHaveTextContent('walking the full flow · 12,400 nodes · 8,910 flows · 17 requests')
  })

  it('never shows a percentage — the total is unknowable', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'walking', nodes: 5 }) })
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('says the full flow is drawn once the walk completes', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'done' }) })
    expect(screen.getByText(/full flow drawn/i)).toBeInTheDocument()
  })

  it('one hop: says the immediate lineage is complete when more than one page was needed', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'done', requests: 4 }) })
    expect(screen.getByText(/immediate lineage complete/i)).toBeInTheDocument()
  })

  it('never offers "Keep walking", "Load everything" or "Load more contents"', () => {
    const walk = doneWalk({
      ...walkModel('F', [wnode('F'), wnode('w1')]),
      truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:w1',
    })
    renderLens({ walk, fullWalkEnabled: false, walkProgress: progress({ phase: 'seeding', pending: 1 }), onFullWalkToggle: vi.fn() })
    expect(screen.queryByRole('button', { name: /keep walking/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /load everything/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /load more contents/i })).toBeNull()
  })
})

describe('LineageLens — the two valves', () => {
  it('the memory checkpoint asks once, wired to Continue', () => {
    const onWalkContinue = vi.fn()
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'checkpoint', nodes: 50000, pending: 12 }), onWalkContinue })
    expect(screen.getByText(/larger than 50,000 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onWalkContinue).toHaveBeenCalledTimes(1)
  })

  it('a failed step says what is on the board and offers Try again', () => {
    const onWalkRetry = vi.fn()
    const walk = doneWalk({
      ...walkModel('F', [wnode('F'), wnode('up1'), wnode('up2'), wnode('down1')]),
      upstreamUrns: new Set(['up1', 'up2']),
      downstreamUrns: new Set(['down1']),
      truncated: true,
      truncationReason: 'timeout',
    })
    renderLens({ walk, fullWalkEnabled: false, walkProgress: progress({ phase: 'error', pending: 3, error: 'timeout' }), onWalkRetry })
    expect(screen.getByText(/3 steps failed at the data source/i)).toBeInTheDocument()
    expect(screen.getByText(/2 upstream · 1 downstream are on the board/i)).toBeInTheDocument()
    expect(screen.queryByText(/max_nodes|timeout/)).toBeNull()      // never a reason token
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onWalkRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the Walk mode toggle and reports the switch', () => {
    const onFullWalkToggle = vi.fn()
    renderLens({ fullWalkEnabled: false, walkProgress: null, onFullWalkToggle })
    const oneHop = screen.getByRole('button', { name: /one hop/i })
    const fullFlow = screen.getByRole('button', { name: /full flow/i })
    expect(oneHop).toHaveAttribute('aria-pressed', 'true')
    expect(fullFlow).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(fullFlow)
    expect(onFullWalkToggle).toHaveBeenCalledWith(true)
  })

  it('shows none of the walk surface when the feature is not wired', () => {
    renderLens()
    expect(screen.queryByTestId('lens-walk-narration')).toBeNull()
    expect(screen.queryByText(/full flow drawn/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /one hop/i })).toBeNull()
  })
})
