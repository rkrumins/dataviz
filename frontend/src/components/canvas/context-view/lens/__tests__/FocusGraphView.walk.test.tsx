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

function view(graph: FocusGraph, built: ReturnType<typeof buildWalk>, walking: boolean) {
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
    fireEvent.click(pill)
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
