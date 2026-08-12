import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { FIT_MAX_ZOOM, useFrameCamera, type CameraTarget } from '../useFrameCamera'
import type { FocusCard } from '../focus-graph'

const card = (id: string, partnerIds: string[] = []): FocusCard =>
  ({ id, nodeId: id === 'f' ? 'focal-urn' : `urn:${id}`, partnerIds }) as unknown as FocusCard

function Harness({ rf, focalId, cards }: { rf: CameraTarget; focalId: string; cards: FocusCard[] }) {
  useFrameCamera(rf, focalId, cards, true)
  return null
}

describe('useFrameCamera', () => {
  let fitView: ReturnType<typeof vi.fn<CameraTarget['fitView']>>
  let rf: CameraTarget

  beforeEach(() => {
    vi.useFakeTimers()
    fitView = vi.fn<CameraTarget['fitView']>()
    rf = { fitView }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const flush = () => act(() => { vi.advanceTimersByTime(60) })

  it('frames the whole picture when the focal is new', () => {
    render(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    // No `nodes` — a new focal fits everything.
    expect(fitView.mock.calls[0][0].nodes).toBeUndefined()
    // And it may zoom IN. At maxZoom 1 a focused answer — which is
    // small by design — rendered at 1:1 adrift in a field of dots.
    expect(fitView.mock.calls[0][0].maxZoom).toBe(FIT_MAX_ZOOM)
    expect(FIT_MAX_ZOOM).toBeGreaterThan(1)
  })

  /**
   * The regression this file exists for. React invokes effects twice
   * under StrictMode (run → cleanup → run), and any rapid re-render does
   * the same. When the hook stamped its bookkeeping at the TOP of the
   * effect, the first run recorded "framed" and scheduled the move, the
   * cleanup cancelled the move, and the second run saw "same focal,
   * nothing arrived" and did nothing. The camera then never re-fit on a
   * focal change and stayed pointing at the previous graph — the focal
   * rendered correctly and was nowhere on screen.
   */
  it('still frames when the first effect run is cancelled before its move (StrictMode)', () => {
    render(
      <StrictMode>
        <Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} />
      </StrictMode>,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('re-frames when the focal changes', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[card('f')]} />)
    flush()
    rerender(<Harness rf={rf} focalId="b" cards={[card('f'), card('n:y')]} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(2)
    expect(fitView.mock.calls[1][0].nodes).toBeUndefined()
  })

  it('eases to the arrived cards plus their anchors on an expansion', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} />)
    flush()
    rerender(
      <Harness
        rf={rf}
        focalId="a"
        cards={[card('f'), card('n:x'), card('n:new', ['urn:n:x'])]}
      />,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(2)
    // The card that arrived, the card it attached to — and ALWAYS the
    // focal. An async answer panning the viewport to itself is how
    // "the actual focus node has disappeared" happened.
    expect(fitView.mock.calls[1][0].nodes).toEqual([{ id: 'n:new' }, { id: 'n:x' }, { id: 'f' }])
  })

  it('holds still while a frame churns its rows', () => {
    // A resolving container replaces its rows on every step of the
    // server walk. Easing to each batch yanked the viewport once per
    // step — the reported "chaos". Rows are the frame's business.
    const withFrame = (rows: string[]) => [
      card('f'),
      card('fr:in:dom'),
      ...rows.map(id => ({ ...card(id), frameId: 'fr:in:dom' }) as unknown as FocusCard),
    ]
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={withFrame(['r1'])} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    rerender(<Harness rf={rf} focalId="a" cards={withFrame(['r2', 'r3'])} />)
    flush()
    // New row ids arrived, but nothing outside the frame did.
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('does not move the camera when nothing arrived', () => {
    const cards = [card('f'), card('n:x')]
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={cards} />)
    flush()
    // A new array with the same ids: a rebuild, not an expansion.
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('waits for the instance rather than framing against nothing', () => {
    const { rerender } = render(<Harness rf={null as unknown as CameraTarget} focalId="a" cards={[card('f')]} />)
    flush()
    expect(fitView).not.toHaveBeenCalled()
    rerender(<Harness rf={rf} focalId="a" cards={[card('f')]} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
  })
})
