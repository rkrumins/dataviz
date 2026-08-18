/**
 * TraceWalkDock — the native canvas trace's bottom dock. Prop-driven;
 * the walk itself is covered in useCanvasTraceWalk.test.ts. Contract:
 * every state of the walk is SAID (walking, drawn, budget, stalled,
 * failed, hidden-by-assignment), the flow's shape is COUNTED (upstream /
 * downstream in the wire colors, per-entity-type census), the direction
 * toggles filter the canvas, the Flow view escalation opens the Lens,
 * and the expanded panel lists every participant with click-to-jump.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TraceWalkDock, type TraceWalkDockProps } from '../TraceWalkDock'
import type { FullWalkStatus } from '@/hooks/useLensWalk'

const status = (parts: Partial<FullWalkStatus>): FullWalkStatus => ({
  walking: false, exhausted: false, budgetHit: false, stalled: false, ...parts,
})

function renderDock(extra: Partial<TraceWalkDockProps> = {}) {
  const props: TraceWalkDockProps = {
    tracedName: 'clean_opportunities',
    nodeCount: 42,
    flowCount: 17,
    upstreamCount: 12,
    downstreamCount: 8,
    hiddenCount: 0,
    typeCensus: [
      { type: 'dataset', count: 14 },
      { type: 'column', count: 28 },
    ],
    upstream: [{ urn: 'u:raw_loans', label: 'raw_loans' }],
    downstream: [{ urn: 'd:board_report', label: 'board_report' }],
    showUpstream: true,
    showDownstream: true,
    onToggleUpstream: vi.fn(),
    onToggleDownstream: vi.fn(),
    onJumpToUrn: vi.fn(),
    onOpenFlowView: vi.fn(),
    walkStatus: 'done',
    walkError: null,
    status: status({ exhausted: true }),
    onKeepWalking: vi.fn(),
    onRetry: vi.fn(),
    onExit: vi.fn(),
    ...extra,
  }
  render(<TraceWalkDock {...props} />)
  return props
}

describe('TraceWalkDock — narration', () => {
  it('narrates an in-progress walk with live counts', () => {
    renderDock({ status: status({ walking: true }), walkStatus: 'done' })
    expect(screen.getByText(/tracing clean_opportunities/i)).toBeInTheDocument()
    expect(screen.getByText(/42 nodes · 17 flows/i)).toBeInTheDocument()
  })

  it('says the full flow is drawn when the walk exhausts', () => {
    renderDock({ status: status({ exhausted: true }) })
    expect(screen.getByText(/full flow of clean_opportunities/i)).toBeInTheDocument()
  })

  it('counts participants hidden by layer assignment, honestly', () => {
    renderDock({ hiddenCount: 3 })
    expect(screen.getByText(/3 not shown \(no layer assignment\)/i)).toBeInTheDocument()
  })

  it('offers Keep walking at the budget', () => {
    const props = renderDock({ status: status({ budgetHit: true }) })
    expect(screen.getByText(/the flow continues past 42 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(props.onKeepWalking).toHaveBeenCalledTimes(1)
  })

  it('offers Try again when the walk stalls', () => {
    const props = renderDock({ status: status({ stalled: true }) })
    expect(screen.getByText(/part of the flow could not be walked/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(props.onKeepWalking).toHaveBeenCalledTimes(1)
  })

  it('says a failed initial fetch and offers Retry', () => {
    const props = renderDock({ walkStatus: 'error', walkError: 'backend down', status: null })
    expect(screen.getByText(/backend down/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })

  it('always offers Exit trace', () => {
    const props = renderDock()
    fireEvent.click(screen.getByRole('button', { name: /exit trace/i }))
    expect(props.onExit).toHaveBeenCalledTimes(1)
  })
})

describe('TraceWalkDock — the flow, counted', () => {
  it('shows upstream and downstream counts in the wire colors, as direction toggles', () => {
    const props = renderDock()
    const up = screen.getByRole('button', { name: /12 upstream/i })
    const down = screen.getByRole('button', { name: /8 downstream/i })
    expect(up.className).toMatch(/cyan/)
    expect(down.className).toMatch(/amber/)
    expect(up).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(up)
    expect(props.onToggleUpstream).toHaveBeenCalledTimes(1)
    fireEvent.click(down)
    expect(props.onToggleDownstream).toHaveBeenCalledTimes(1)
  })

  it('reflects a hidden direction on its toggle', () => {
    renderDock({ showUpstream: false })
    expect(screen.getByRole('button', { name: /12 upstream/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the per-entity-type census of the flow', () => {
    renderDock()
    expect(screen.getByText(/14 dataset/i)).toBeInTheDocument()
    expect(screen.getByText(/28 column/i)).toBeInTheDocument()
  })

  it('offers the Flow view escalation to the Lens narrative', () => {
    const props = renderDock()
    fireEvent.click(screen.getByRole('button', { name: /flow view/i }))
    expect(props.onOpenFlowView).toHaveBeenCalledTimes(1)
  })
})

describe('TraceWalkDock — bottom-chrome coexistence', () => {
  it('publishes its height as --trace-dock-height on the canvas body, and clears it on unmount', () => {
    const host = document.createElement('div')
    host.setAttribute('data-canvas-body', '')
    document.body.appendChild(host)
    const { unmount } = render(<TraceWalkDock {...({
      tracedName: 'x', nodeCount: 1, flowCount: 1, upstreamCount: 0, downstreamCount: 0,
      hiddenCount: 0, typeCensus: [], upstream: [], downstream: [],
      showUpstream: true, showDownstream: true,
      onToggleUpstream: vi.fn(), onToggleDownstream: vi.fn(), onJumpToUrn: vi.fn(),
      onOpenFlowView: vi.fn(), walkStatus: 'done', walkError: null,
      status: status({ exhausted: true }), onKeepWalking: vi.fn(), onRetry: vi.fn(), onExit: vi.fn(),
    } satisfies TraceWalkDockProps)} />, { container: host })

    expect(host.style.getPropertyValue('--trace-dock-height')).toMatch(/px$/)
    unmount()
    expect(host.style.getPropertyValue('--trace-dock-height')).toBe('')
    host.remove()
  })
})

describe('TraceWalkDock — the participants panel', () => {
  it('expands to list every upstream and downstream participant', () => {
    renderDock()
    fireEvent.click(screen.getByRole('button', { name: /show participants/i }))
    const upList = screen.getByRole('list', { name: /upstream/i })
    const downList = screen.getByRole('list', { name: /downstream/i })
    expect(within(upList).getByText('raw_loans')).toBeInTheDocument()
    expect(within(downList).getByText('board_report')).toBeInTheDocument()
  })

  it('clicking a participant jumps to it on the canvas', () => {
    const props = renderDock()
    fireEvent.click(screen.getByRole('button', { name: /show participants/i }))
    fireEvent.click(screen.getByText('raw_loans'))
    expect(props.onJumpToUrn).toHaveBeenCalledWith('u:raw_loans')
  })
})
