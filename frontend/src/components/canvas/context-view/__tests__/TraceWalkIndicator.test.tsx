/**
 * TraceWalkIndicator — the trace capsule's contract.
 *
 * THE COMPLAINT IT ANSWERS (user, 2026-08-21): "trace chrome on, browse
 * picture underneath, nothing happening." Between the click and the moment
 * the overlay draws, and for as long as the background walk runs behind it,
 * the board must say what it is doing — in the reader's language, with a way
 * out.
 *
 * What is pinned here:
 *  • Every phase narrates: the coarse fetch, the walk (with LIVE nodes and
 *    requests off the driver), the memory ceiling, an error, and the finish.
 *  • Every phase but the finish offers Cancel; the ceiling offers Keep
 *    walking; an error offers Try again. Each is wired to its own callback.
 *  • Counts read as FLOORS while the walk runs — "132+" is a promise the
 *    trace can keep, "132" is not.
 *  • The finish holds for a beat and then leaves, taking its timer with it.
 *  • It never blocks the board: the capsule body passes pointer events
 *    through, only its buttons take them.
 *  • Reduced motion FREEZES the sounding line (CSS) rather than removing it,
 *    so the class is unconditional and the component never asks matchMedia.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TraceWalkIndicator, COMPLETE_DISMISS_MS } from '../TraceWalkIndicator'

const wiring = {
  onCancel: () => {},
  onContinue: () => {},
  onRetry: () => {},
}

const base = {
  nodesHeld: 0,
  requests: 0,
  upCount: 0,
  downCount: 0,
  countsAreFloors: true,
  frontierRemaining: 0,
  error: null,
  ...wiring,
}

describe('TraceWalkIndicator', () => {
  beforeEach(() => { vi.useRealTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is a polite status region, so the board announces itself once per phase', () => {
    render(<TraceWalkIndicator {...base} phase="coarse" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('coarse: says the focus is being found, and offers the way out', () => {
    render(<TraceWalkIndicator {...base} phase="coarse" />)
    expect(screen.getByText('Finding the focus…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /keep walking/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('walking: narrates the live nodes and requests the driver reports', () => {
    render(
      <TraceWalkIndicator
        {...base} phase="walking" nodesHeld={214} requests={38} upCount={132} downCount={82}
      />,
    )
    expect(screen.getByText('Mapping the flow')).toBeInTheDocument()
    expect(screen.getByText('214 nodes · 38 requests')).toBeInTheDocument()
  })

  it('walking: the direction counts read as FLOORS while the walk is still finding more', () => {
    const { rerender } = render(
      <TraceWalkIndicator
        {...base} phase="walking" nodesHeld={214} requests={38} upCount={132} downCount={82}
      />,
    )
    expect(screen.getByText('↑ 132+')).toBeInTheDocument()
    expect(screen.getByText('82+ ↓')).toBeInTheDocument()

    // Exhausted: the same numbers, now exact, so the "+" goes.
    rerender(
      <TraceWalkIndicator
        {...base} phase="walking" nodesHeld={214} requests={38} upCount={132} downCount={82}
        countsAreFloors={false}
      />,
    )
    expect(screen.getByText('↑ 132')).toBeInTheDocument()
    expect(screen.getByText('82 ↓')).toBeInTheDocument()
  })

  it('Cancel leaves the trace', () => {
    const onCancel = vi.fn()
    render(<TraceWalkIndicator {...base} phase="walking" onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ceiling: says what is held and what is left, and Keep walking resumes', () => {
    const onContinue = vi.fn()
    render(
      <TraceWalkIndicator
        {...base} phase="ceiling" nodesHeld={25000} requests={412} frontierRemaining={3}
        onContinue={onContinue}
      />,
    )
    expect(screen.getByText('Showing the first 25,000 of a flow that continues')).toBeInTheDocument()
    expect(screen.getByText('3 more boundaries to follow')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /keep walking/i }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    // The way out is still there — a reader who has seen enough can leave.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('ceiling: one boundary left is said in the singular', () => {
    render(<TraceWalkIndicator {...base} phase="ceiling" nodesHeld={25000} frontierRemaining={1} />)
    expect(screen.getByText('1 more boundary to follow')).toBeInTheDocument()
  })

  it('error: the failure is quoted verbatim, and Try again re-arms it', () => {
    const onRetry = vi.fn()
    render(
      <TraceWalkIndicator
        {...base} phase="error" requests={2}
        error="The trace came back without the entity it was anchored on."
        onRetry={onRetry}
      />,
    )
    expect(screen.getByText('The trace came back without the entity it was anchored on.'))
      .toBeInTheDocument()
    expect(screen.getByText('Stopped after 2 requests')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('error with nothing to quote still says something a reader can act on', () => {
    render(<TraceWalkIndicator {...base} phase="error" error={null} />)
    expect(screen.getByText('The trace could not be completed')).toBeInTheDocument()
  })

  it('complete: reports the finished flow, drops every action, and leaves after a beat', () => {
    vi.useFakeTimers()
    const { container } = render(
      <TraceWalkIndicator {...base} phase="complete" nodesHeld={214} requests={38} />,
    )
    expect(screen.getByText('Complete — 214 nodes')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()

    act(() => { vi.advanceTimersByTime(COMPLETE_DISMISS_MS - 1) })
    expect(screen.queryByText('Complete — 214 nodes')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(1) })
    expect(container.firstChild).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no timer behind when the trace is cancelled mid-beat', () => {
    vi.useFakeTimers()
    const { unmount } = render(<TraceWalkIndicator {...base} phase="complete" nodesHeld={9} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs no timer at all while the trace is still computing', () => {
    vi.useFakeTimers()
    render(<TraceWalkIndicator {...base} phase="walking" nodesHeld={9} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never blocks the board: the capsule passes clicks through, its buttons do not', () => {
    render(<TraceWalkIndicator {...base} phase="walking" />)
    const status = screen.getByRole('status')
    expect(status.className).toContain('pointer-events-none')
    expect(screen.getByRole('button', { name: /cancel/i }).className)
      .toContain('pointer-events-auto')
  })

  it('the sounding line is present while the flow is being walked, both filaments', () => {
    const { container } = render(<TraceWalkIndicator {...base} phase="walking" />)
    expect(container.querySelector('.nx-trace-sounding-up')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-down')).toBeTruthy()
  })

  it('reduced motion FREEZES the sounding line — the class is unconditional, never asked for', () => {
    const matchMedia = vi.fn().mockReturnValue({
      matches: true, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, media: '', onchange: null,
      dispatchEvent: () => false,
    })
    vi.stubGlobal('matchMedia', matchMedia)
    const { container } = render(<TraceWalkIndicator {...base} phase="walking" />)
    // Same markup either way: globals.css owns the freeze, so there is
    // nothing here to get it wrong.
    expect(container.querySelector('.nx-trace-sounding-up')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-down')).toBeTruthy()
    expect(matchMedia).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('the phase is on the root, so the CSS can say coarse from walking without a class soup', () => {
    const { rerender, container } = render(<TraceWalkIndicator {...base} phase="coarse" />)
    expect(container.querySelector('[data-trace-phase="coarse"]')).toBeTruthy()
    rerender(<TraceWalkIndicator {...base} phase="walking" />)
    expect(container.querySelector('[data-trace-phase="walking"]')).toBeTruthy()
  })
})
