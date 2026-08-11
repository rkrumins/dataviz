import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useFrameCamera, type CameraTarget } from '../useFrameCamera'
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
    // The card that arrived, and the card it attached to — not the focal.
    expect(fitView.mock.calls[1][0].nodes).toEqual([{ id: 'n:new' }, { id: 'n:x' }])
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
