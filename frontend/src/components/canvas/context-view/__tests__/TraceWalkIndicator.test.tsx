/**
 * TraceWalkIndicator — the canvas's "your trace is being calculated"
 * capsule (2026-08-19 ruling: the board must never sit silent between
 * the trace click and the first merge wave).
 *
 * Contract under test: each walk phase narrates in plain language with
 * live counts, the paused/stalled/error phases carry their verbs, and
 * the sounding-line track (the signature element) is present while the
 * engine is computing — with its motion class unconditional so reduced
 * motion freezes it rather than removing it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TraceWalkIndicator } from '../TraceWalkIndicator'

describe('TraceWalkIndicator', () => {
  it('preparing: names the entity and says the flow is being mapped', () => {
    render(<TraceWalkIndicator label="fact_orders" phase="preparing" nodeCount={0} flowCount={0} />)
    expect(screen.getByText(/tracing fact_orders/i)).toBeInTheDocument()
    expect(screen.getByText(/mapping the flow/i)).toBeInTheDocument()
  })

  it('walking: narrates live counts', () => {
    render(<TraceWalkIndicator label="fact_orders" phase="walking" nodeCount={214} flowCount={380} />)
    expect(screen.getByText(/214 nodes · 380 flows so far/i)).toBeInTheDocument()
  })

  it('the sounding line is present while computing, with both direction filaments', () => {
    const { container } = render(
      <TraceWalkIndicator label="x" phase="walking" nodeCount={1} flowCount={0} />,
    )
    expect(container.querySelector('.nx-trace-sounding')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-up')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-down')).toBeTruthy()
  })

  it('settled: reports the drawn flow and drops the sounding line', () => {
    const { container } = render(
      <TraceWalkIndicator label="x" phase="settled" nodeCount={214} flowCount={380} />,
    )
    expect(screen.getByText(/flow drawn — 214 nodes · 380 flows/i)).toBeInTheDocument()
    expect(container.querySelector('.nx-trace-sounding')).toBeFalsy()
  })

  it('paused: says the flow continues, and "Keep walking" fires the continuation', () => {
    const onContinue = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="paused" nodeCount={1000} flowCount={900} onContinue={onContinue} />,
    )
    expect(screen.getByText(/paused at 1000 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('stalled: offers "Try again" wired to the continuation', () => {
    const onContinue = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="stalled" nodeCount={12} flowCount={9} onContinue={onContinue} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('error: offers "Retry" wired to the retry handler', () => {
    const onRetry = vi.fn()
    render(
      <TraceWalkIndicator label="x" phase="error" nodeCount={0} flowCount={0} onRetry={onRetry} />,
    )
    expect(screen.getByText(/couldn't reach the data source/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
