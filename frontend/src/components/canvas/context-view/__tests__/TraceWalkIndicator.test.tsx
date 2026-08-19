/**
 * TraceWalkIndicator — the canvas's "your trace is being calculated"
 * capsule (2026-08-19 ruling: the board must never sit silent between
 * the trace click and the first merge wave; uplifted the same day with
 * escape hatches — Cancel while computing, dismiss on parked states —
 * and per-direction counts on the sounding line).
 *
 * Contract under test: each walk phase narrates in plain language with
 * live counts; computing offers Cancel (aborts the session); paused and
 * stalled keep their verbs plus a dismiss that leaves the partial flow;
 * error offers Retry and Cancel; the sounding line (the signature) is
 * present while computing, carries both direction filaments and their
 * counts, and its motion class is unconditional so reduced motion
 * freezes it rather than removing it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TraceWalkIndicator } from '../TraceWalkIndicator'

const noop = () => {}

describe('TraceWalkIndicator', () => {
  it('preparing: names the entity and says the flow is being mapped', () => {
    render(<TraceWalkIndicator label="fact_orders" phase="preparing" nodeCount={0} flowCount={0} upCount={0} downCount={0} onCancel={noop} />)
    expect(screen.getByText('fact_orders')).toBeInTheDocument()
    expect(screen.getByText(/mapping the flow/i)).toBeInTheDocument()
  })

  it('walking: narrates live totals and per-direction counts', () => {
    render(<TraceWalkIndicator label="fact_orders" phase="walking" nodeCount={214} flowCount={380} upCount={132} downCount={82} onCancel={noop} />)
    expect(screen.getByText(/214 nodes · 380 flows and counting/i)).toBeInTheDocument()
    expect(screen.getByText(/132 upstream/i)).toBeInTheDocument()
    expect(screen.getByText(/82 downstream/i)).toBeInTheDocument()
  })

  it('computing offers Cancel, wired to the session abort', () => {
    const onCancel = vi.fn()
    render(<TraceWalkIndicator label="x" phase="walking" nodeCount={3} flowCount={1} upCount={1} downCount={0} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('the sounding line is present while computing, with both direction filaments', () => {
    const { container } = render(
      <TraceWalkIndicator label="x" phase="walking" nodeCount={1} flowCount={0} upCount={0} downCount={0} onCancel={noop} />,
    )
    expect(container.querySelector('.nx-trace-sounding')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-up')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-down')).toBeTruthy()
  })

  it('settled: reports the drawn flow and drops the sounding line and Cancel', () => {
    const { container } = render(
      <TraceWalkIndicator label="x" phase="settled" nodeCount={214} flowCount={380} upCount={132} downCount={82} onCancel={noop} />,
    )
    expect(screen.getByText(/flow drawn/i)).toBeInTheDocument()
    expect(screen.getByText(/214 nodes · 380 flows/i)).toBeInTheDocument()
    expect(container.querySelector('.nx-trace-sounding')).toBeFalsy()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('paused: says the flow continues, "Keep walking" fires the continuation, and dismiss keeps the flow', () => {
    const onContinue = vi.fn()
    const onDismiss = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="paused" nodeCount={1000} flowCount={900} upCount={600} downCount={400} onContinue={onContinue} onDismiss={onDismiss} onCancel={noop} />,
    )
    expect(screen.getByText(/paused at 1000 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('stalled: offers "Try again" wired to the continuation, plus dismiss', () => {
    const onContinue = vi.fn()
    const onDismiss = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="stalled" nodeCount={12} flowCount={9} upCount={5} downCount={4} onContinue={onContinue} onDismiss={onDismiss} onCancel={noop} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('error: offers Retry and Cancel — nothing is drawn, so the way out is leaving the trace', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="error" nodeCount={0} flowCount={0} upCount={0} downCount={0} onRetry={onRetry} onCancel={onCancel} />,
    )
    expect(screen.getByText(/couldn't reach the data source/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
