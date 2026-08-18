/**
 * TraceWalkBar — the native canvas trace's narration strip. Prop-driven;
 * the walk itself is covered in useCanvasTraceWalk.test.ts. Contract:
 * every state of the walk is SAID (walking, drawn, budget, stalled,
 * failed, hidden-by-assignment), and the three actions are wired.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TraceWalkBar, type TraceWalkBarProps } from '../TraceWalkBar'
import type { FullWalkStatus } from '@/hooks/useLensWalk'

const status = (parts: Partial<FullWalkStatus>): FullWalkStatus => ({
  walking: false, exhausted: false, budgetHit: false, stalled: false, ...parts,
})

function renderBar(extra: Partial<TraceWalkBarProps> = {}) {
  const props: TraceWalkBarProps = {
    tracedName: 'clean_opportunities',
    nodeCount: 42,
    flowCount: 17,
    hiddenCount: 0,
    walkStatus: 'done',
    walkError: null,
    status: status({ exhausted: true }),
    onKeepWalking: vi.fn(),
    onRetry: vi.fn(),
    onExit: vi.fn(),
    ...extra,
  }
  render(<TraceWalkBar {...props} />)
  return props
}

describe('TraceWalkBar', () => {
  it('narrates an in-progress walk with live counts', () => {
    renderBar({ status: status({ walking: true }), walkStatus: 'done' })
    expect(screen.getByText(/tracing clean_opportunities · 42 nodes · 17 flows/i)).toBeInTheDocument()
  })

  it('says the full flow is drawn when the walk exhausts', () => {
    renderBar({ status: status({ exhausted: true }) })
    expect(screen.getByText(/full flow · 42 nodes · 17 flows/i)).toBeInTheDocument()
  })

  it('counts participants hidden by layer assignment, honestly', () => {
    renderBar({ hiddenCount: 3 })
    expect(screen.getByText(/3 not shown \(no layer assignment\)/i)).toBeInTheDocument()
  })

  it('offers Keep walking at the budget', () => {
    const props = renderBar({ status: status({ budgetHit: true }) })
    expect(screen.getByText(/the flow continues past 42 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(props.onKeepWalking).toHaveBeenCalledTimes(1)
  })

  it('offers Try again when the walk stalls', () => {
    const props = renderBar({ status: status({ stalled: true }) })
    expect(screen.getByText(/part of the flow could not be walked/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(props.onKeepWalking).toHaveBeenCalledTimes(1)
  })

  it('says a failed initial fetch and offers Retry', () => {
    const props = renderBar({ walkStatus: 'error', walkError: 'backend down', status: null })
    expect(screen.getByText(/backend down/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })

  it('always offers Exit trace', () => {
    const props = renderBar()
    fireEvent.click(screen.getByRole('button', { name: /exit trace/i }))
    expect(props.onExit).toHaveBeenCalledTimes(1)
  })
})
