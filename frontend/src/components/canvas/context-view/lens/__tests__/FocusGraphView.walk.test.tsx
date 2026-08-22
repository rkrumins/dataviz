/**
 * C4 (2026-08-21) — the board grows under a hands-free walk without
 * yanking the camera; the reader is OFFERED a fit.
 *
 * `useFrameCamera` holds still while `walking` and reports `grew`; this
 * pins the view's half of it: the pill appears when cards landed during
 * the walk, fits the whole board on click, and goes away.
 */
import { describe, it, expect } from 'vitest'
import { render, act, fireEvent, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { FocusGraphView } from '../FocusGraphView'
import { WALK_FIXTURES } from '@/harness/lensFixtures'
import { buildWalk } from '@/harness/buildWalk'
import type { FocusGraph } from '../focus-cards'

const noop = () => {}

function view(graph: FocusGraph, built: ReturnType<typeof buildWalk>, walking: boolean, recenterKey?: string, recenterSignal?: number) {
  return (
    <ReactFlowProvider>
      <FocusGraphView
        graph={graph}
        focalId={built.focalId}
        focalFetch="done"
        focalReach={built.reach}
        directionFilter={built.directionFilter}
        selectedId={null}
        isolatedId={null}
        reducedMotion
        walking={walking}
        recenterKey={recenterKey}
        recenterSignal={recenterSignal}
        onSelect={noop}
        onFocus={noop}
        onToggleFrame={noop}
        onFrameScroll={noop}
        onFrameQuery={noop}
        onToggleFrameAll={noop}
        onRevealMore={noop}
        onExtend={noop}
        onPage={noop}
      />
    </ReactFlowProvider>
  )
}

/** React Flow hands over its instance a tick after mount and the camera
 *  frames a new focal 30 ms after THAT — and `act` flushes the state
 *  updates only when its callback resolves, so one long wait would let
 *  the instance land at the very end with its frame still pending. A
 *  few short acts let each step flush in turn. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 60)) })
}

describe('FocusGraphView — a board that grows under the walk', () => {
  it('offers "Fit" once cards land during the walk, and the offer clears on click', async () => {
    const built = buildWalk(WALK_FIXTURES.walkHub)
    const all = built.graph
    const half: FocusGraph = { ...all, cards: all.cards.slice(0, Math.ceil(all.cards.length / 2)), edges: [] }
    const { rerender } = render(view(half, built, true))
    await settle()
    expect(screen.queryByRole('button', { name: /board grew/i })).toBeNull()
    rerender(view(all, built, true))
    await settle()
    const pill = screen.getByRole('button', { name: /board grew/i })
    // The walk capsule owns the top-centre while the walk runs
    // (2026-08-22): the offers' row sits BELOW it, never under it.
    expect(pill.parentElement!.className).toMatch(/top-\[4\.75rem\]/)
    rerender(view(all, built, false))
    expect(screen.getByRole('button', { name: /board grew/i }).parentElement!.className).toMatch(/\btop-3\b/)
    fireEvent.click(screen.getByRole('button', { name: /board grew/i }))
    await settle()
    expect(screen.queryByRole('button', { name: /board grew/i })).toBeNull()
  })

  it('never offers it while nothing arrived', async () => {
    const built = buildWalk(WALK_FIXTURES.walkHub)
    const { rerender } = render(view(built.graph, built, true))
    await settle()
    rerender(view({ ...built.graph, cards: [...built.graph.cards] }, built, true))
    await settle()
    expect(screen.queryByRole('button', { name: /board grew/i })).toBeNull()
  })
})

describe('FocusGraphView — back to the focus (2026-08-22)', () => {
  // "A button which says re-center or something, so it zooms in
  // appropriately to the focus node" — in the control stack, beside Fit,
  // labelled like every other control there.
  it('offers "Center on the focus" in the control stack', async () => {
    const built = buildWalk(WALK_FIXTURES.walkHub)
    render(view(built.graph, built, false))
    await settle()
    const button = screen.getByRole('button', { name: /center on the focus/i })
    expect(button).toBeInTheDocument()
    fireEvent.click(button)      // jsdom has no viewport to move; the click must simply not throw
  })
})

describe('FocusGraphView — the way back to the focus is findable (2026-08-22)', () => {
  // "Center on the focus" lived only in the corner stack of icons. Now the
  // header can ask for it (recenterSignal), and the board offers it by
  // itself the moment the focus has left the screen.
  const viewportTransform = () => document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform ?? ''

  it('a recenter signal from the header moves the camera onto the focus', async () => {
    // jsdom measures nothing; give the pane a size so the focus framing
    // has something to centre in.
    const rect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      // The camera measures the board's own wrapper (the `h-full w-full`
      // div around React Flow); everything else stays unmeasured.
      const pane = this.classList.contains('h-full') && this.classList.contains('w-full') && this.querySelector('.react-flow')
      const w = pane ? 1500 : 0
      const h = pane ? 900 : 0
      return { width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON() { return this } } as DOMRect
    }
    try {
      const built = buildWalk(WALK_FIXTURES.walkHub)
      const { rerender } = render(view(built.graph, built, false, 'grouped', 0))
      await settle()
      const before = viewportTransform()
      rerender(view(built.graph, built, false, 'grouped', 1))
      await settle()
      expect(viewportTransform()).not.toBe(before)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect
    }
  })

  it('offers "Center on the focus" on the board only once the focus has left the screen', async () => {
    const built = buildWalk(WALK_FIXTURES.walkHub)
    render(view(built.graph, built, false))
    await settle()
    expect(screen.queryByTestId('lens-focus-offscreen')).toBeNull()
  })
})
