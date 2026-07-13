import { useRef } from 'react'
import { render, act, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { useIsClipped } from '../useIsClipped'

/**
 * Locks the contract that makes the sidebar's reveal-on-clip tooltip worth
 * having: it must appear ONLY when text is genuinely being eaten by the
 * ellipsis, and it must stop appearing the moment the row can show its own text
 * (e.g. the user drags the sidebar wider).
 *
 * If someone rewires this to "always show a tooltip", these tests fail — which
 * is the point. A tooltip on every hover is noise; a tooltip that appears only
 * when it has something to say is the whole feature.
 */

// jsdom has no layout engine — every element reports scrollWidth/clientWidth as
// 0, so the measurement has to be driven explicitly.
let scrollWidth = 0
let clientWidth = 0

function setWidths(scroll: number, client: number) {
  scrollWidth = scroll
  clientWidth = client
}

// jsdom ships no ResizeObserver. Capture the callback so a "resize" can be fired
// on demand — that is how the drag-to-widen behaviour gets tested.
let fireResize: (() => void) | null = null

class MockResizeObserver {
  constructor(cb: () => void) {
    fireResize = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {
    fireResize = null
  }
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const clipped = useIsClipped(ref, enabled)
  return (
    <span ref={ref} data-testid="probe" data-clipped={clipped ? 'yes' : 'no'}>
      Define and manage ontology models
    </span>
  )
}

const clippedAttr = (el: HTMLElement) => el.getAttribute('data-clipped')

describe('useIsClipped — the tooltip only exists when it has something to say', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => scrollWidth,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => clientWidth,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fireResize = null
  })

  it('reports clipped when the ellipsis is eating text', async () => {
    setWidths(240, 160) // the text wants 240px, the row gives it 160
    const { getByTestId } = render(<Probe />)
    await waitFor(() => expect(clippedAttr(getByTestId('probe'))).toBe('yes'))
  })

  it('reports NOT clipped when the text already fits — so no tooltip is offered', async () => {
    setWidths(160, 160)
    const { getByTestId } = render(<Probe />)
    await act(async () => {})
    expect(clippedAttr(getByTestId('probe'))).toBe('no')
  })

  it('tolerates sub-pixel rounding — 1px over is not "clipped"', async () => {
    // Fractional zoom / non-integer DPR routinely makes a perfectly-fitting
    // string report 1px of overflow. Without the tolerance the tooltip would
    // flicker on rows that look completely fine.
    setWidths(161, 160)
    const { getByTestId } = render(<Probe />)
    await act(async () => {})
    expect(clippedAttr(getByTestId('probe'))).toBe('no')
  })

  it('stops reporting clipped once the element grows — dragging the sidebar wider', async () => {
    setWidths(240, 160)
    const { getByTestId } = render(<Probe />)
    await waitFor(() => expect(clippedAttr(getByTestId('probe'))).toBe('yes'))

    // The user drags the sidebar out; the row can now show the whole string.
    setWidths(240, 240)
    await act(async () => {
      fireResize?.()
    })

    // The tooltip must retire itself — no lingering hover affordance on a row
    // that reads in full.
    expect(clippedAttr(getByTestId('probe'))).toBe('no')
  })

  it('measures nothing when disabled — a collapsed sidebar renders no text', async () => {
    setWidths(240, 160)
    const { getByTestId } = render(<Probe enabled={false} />)
    await act(async () => {})
    expect(clippedAttr(getByTestId('probe'))).toBe('no')
  })

  it('degrades safely where ResizeObserver does not exist', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    setWidths(240, 160)
    const { getByTestId } = render(<Probe />)
    // Still measures once — it just cannot track later resizes.
    await waitFor(() => expect(clippedAttr(getByTestId('probe'))).toBe('yes'))
  })
})
