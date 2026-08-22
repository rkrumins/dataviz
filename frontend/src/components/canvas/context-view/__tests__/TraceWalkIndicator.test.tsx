/**
 * TraceWalkIndicator — the capsule that narrates a canvas trace while it
 * computes (D4, 2026-08-21; the 2026-08-19 design, re-read off the walk
 * driver's own phases).
 *
 * Contract under test: every phase speaks plain language with the driver's
 * live counts — never a percent, never a spinner, never the wire's reason
 * token; the checkpoint is the one decision it asks (Continue); a failed
 * step offers Try again; Cancel leaves the trace from the first click; the
 * finished beat holds `COMPLETE_DISMISS_MS` and the capsule removes itself;
 * the sounding line is present while the walk runs and its motion class is
 * unconditional (reduced motion freezes it in CSS, never removes it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TraceWalkIndicator, COMPLETE_DISMISS_MS, type TraceWalkIndicatorProps } from '../TraceWalkIndicator'

const base = (over: Partial<TraceWalkIndicatorProps> = {}): TraceWalkIndicatorProps => ({
  phase: 'walking',
  nodes: 0, flows: 0, requests: 0, pending: 0, error: null,
  upCount: 0, downCount: 0,
  onCancel: vi.fn(), onContinue: vi.fn(), onRetry: vi.fn(),
  ...over,
})

describe('TraceWalkIndicator — what it says', () => {
  it('loading: the focus is being found, and Cancel is already there', () => {
    const p = base({ phase: 'loading' })
    render(<TraceWalkIndicator {...p} />)
    expect(screen.getByText(/finding the focus/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })

  it('seeding: loading the immediate lineage, with the driver’s counts ticking', () => {
    render(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 13859, flows: 11044, requests: 2, upCount: 3547, downCount: 4928 })} />)
    expect(screen.getByText(/loading the immediate lineage/i)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/13,859 nodes · 11,044 flows · 2 requests/)
    expect(document.body.textContent).toMatch(/3,547/)
    expect(document.body.textContent).toMatch(/4,928/)
  })

  it('walking: mapping the flow, counts ticking, never a percent', () => {
    render(<TraceWalkIndicator {...base({ phase: 'walking', nodes: 20549, flows: 18072, requests: 6 })} />)
    expect(screen.getByText(/mapping the flow/i)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/20,549 nodes · 18,072 flows · 6 requests/)
    expect(document.body.textContent).not.toMatch(/%/)
  })

  it('checkpoint: says how large the flow is, and Continue is the one decision', () => {
    const p = base({ phase: 'checkpoint', nodes: 50480, pending: 12 })
    render(<TraceWalkIndicator {...p} />)
    expect(document.body.textContent).toMatch(/larger than 50,480 nodes/i)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(p.onContinue).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /keep walking/i })).toBeNull()
  })

  it('error: part of the lineage could not be loaded — Try again and Cancel, no reason token', () => {
    const p = base({ phase: 'error', nodes: 214, pending: 3, error: 'timeout' })
    render(<TraceWalkIndicator {...p} />)
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/3 steps failed/i)
    expect(document.body.textContent).not.toMatch(/timeout|max_nodes/)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(p.onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('TraceWalkIndicator — the finished beat and the line', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('done: one beat of "Complete", no buttons, then it leaves by itself', () => {
    // The walk was seen running first — a capsule that only ever saw
    // `done` has nothing to announce (see the Lens block below).
    const { rerender } = render(<TraceWalkIndicator {...base({ phase: 'walking', nodes: 50000 })} />)
    rerender(<TraceWalkIndicator {...base({ phase: 'done', nodes: 50480, flows: 47768, requests: 27 })} />)
    expect(document.body.textContent).toMatch(/complete — 50,480 nodes · 47,768 flows/i)
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { vi.advanceTimersByTime(COMPLETE_DISMISS_MS + 10) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('the sounding line shows while the walk runs, with both filaments and the motion class', () => {
    const { container, rerender } = render(<TraceWalkIndicator {...base({ phase: 'walking' })} />)
    expect(container.querySelector('.nx-trace-sounding-up')).toBeTruthy()
    expect(container.querySelector('.nx-trace-sounding-down')).toBeTruthy()
    rerender(<TraceWalkIndicator {...base({ phase: 'done' })} />)
    expect(container.querySelector('.nx-trace-sounding')).toBeNull()
  })

  it('the board underneath stays usable: only the buttons take pointer events', () => {
    render(<TraceWalkIndicator {...base({ phase: 'walking' })} />)
    const host = screen.getByRole('status')
    expect(host.className).toMatch(/pointer-events-none/)
    expect(screen.getByRole('button', { name: /cancel/i }).className).toMatch(/pointer-events-auto/)
  })
})

describe('TraceWalkIndicator — on the Lens board too (2026-08-22)', () => {
  // "The loading state can be missed and the user might confuse it for
  // nothing happening": the Lens borrows this capsule, so both boards say
  // "calculating" the same way. Three things the Lens needs of it.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('names the subject while its lineage is being found', () => {
    render(<TraceWalkIndicator {...base({ phase: 'loading', subject: 'Executive Board Dashboard' })} />)
    expect(screen.getByText(/mapping the lineage of Executive Board Dashboard/i)).toBeInTheDocument()
    expect(screen.queryByText(/finding the focus/i)).toBeNull()
  })

  it('offers no Cancel when there is nothing to cancel into', () => {
    render(<TraceWalkIndicator {...base({ phase: 'seeding', onCancel: undefined })} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('mounted already complete it says nothing, and a later wave brings it back', () => {
    // A focus the lens has already walked opens straight at `done`: no
    // "Complete" flash for work the reader never saw start. A ⊕ wave
    // afterwards is a new computation, so the capsule returns for it and
    // leaves again on its own.
    const { rerender } = render(<TraceWalkIndicator {...base({ phase: 'done' })} />)
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 12 })} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    rerender(<TraceWalkIndicator {...base({ phase: 'done', nodes: 30 })} />)
    expect(document.body.textContent).toMatch(/complete — 30 nodes/i)
    act(() => { vi.advanceTimersByTime(COMPLETE_DISMISS_MS + 10) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('TraceWalkIndicator — progress you can read (2026-08-22)', () => {
  // "More interactive, intuitive and modern … a clever way to mark the
  // progress." The total is still unknowable, so there is still no
  // percentage; what there IS: the four stages of every walk, the steps
  // still owed, the time it has taken, a beat on the line for every page
  // that lands, and a line of guidance once the wait is long.
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const stages = () => [...screen.getByRole('list', { name: /progress/i }).querySelectorAll('li')]
    .map(li => `${li.textContent?.trim()}:${li.getAttribute('data-state')}`)

  it('walks four stages — Focus · Picture · Flows · Drawn — and says which one it is on', () => {
    const { rerender } = render(<TraceWalkIndicator {...base({ phase: 'loading' })} />)
    expect(stages()).toEqual(['Focus:current', 'Picture:todo', 'Flows:todo', 'Drawn:todo'])
    rerender(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 390, flows: 386, requests: 2 })} />)
    expect(stages()).toEqual(['Focus:done', 'Picture:done', 'Flows:current', 'Drawn:todo'])
    rerender(<TraceWalkIndicator {...base({ phase: 'walking', nodes: 12453, flows: 10055, requests: 3 })} />)
    expect(stages()).toEqual(['Focus:done', 'Picture:done', 'Flows:current', 'Drawn:todo'])
    rerender(<TraceWalkIndicator {...base({ phase: 'done', nodes: 20212, flows: 17953, requests: 4 })} />)
    expect(stages()).toEqual(['Focus:done', 'Picture:done', 'Flows:done', 'Drawn:done'])
  })

  it('says how many steps are still owed — a floor, never a percent', () => {
    render(<TraceWalkIndicator {...base({ phase: 'walking', nodes: 5000, flows: 4000, requests: 14, pending: 11 })} />)
    expect(document.body.textContent).toMatch(/14 requests · 11 more to go/)
    expect(document.body.textContent).not.toMatch(/%/)
  })

  it('keeps time once the wait is long enough to wonder about', () => {
    render(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 1, flows: 0, requests: 1 })} />)
    expect(document.body.textContent).not.toMatch(/· \d+ s(?!\w)/)
    act(() => { vi.advanceTimersByTime(3_100) })
    expect(document.body.textContent).toMatch(/· 3 s(?!\d)/)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(document.body.textContent).toMatch(/· 7 s(?!\d)/)
  })

  it('offers a line of guidance on a long wait, and changes it', () => {
    render(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 1, flows: 0, requests: 1, surface: 'lens' })} />)
    expect(screen.queryByTestId('walk-guidance')).toBeNull()
    act(() => { vi.advanceTimersByTime(4_100) })
    const first = screen.getByTestId('walk-guidance').textContent
    expect(first).toBeTruthy()
    act(() => { vi.advanceTimersByTime(6_100) })
    expect(screen.getByTestId('walk-guidance').textContent).not.toBe(first)
  })

  it('beats on the sounding line every time a page lands', () => {
    const { container, rerender } = render(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 10, flows: 5, requests: 1 })} />)
    const beat = () => container.querySelector('.nx-trace-sounding-beat')?.getAttribute('data-beat')
    expect(beat()).toBe('1')
    rerender(<TraceWalkIndicator {...base({ phase: 'seeding', nodes: 400, flows: 380, requests: 2 })} />)
    expect(beat()).toBe('2')
  })
})
