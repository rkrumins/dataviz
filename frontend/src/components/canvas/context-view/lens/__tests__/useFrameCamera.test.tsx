import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { FIT_MAX_ZOOM, useFrameCamera, type CameraEdge, type CameraItem, type CameraTarget } from '../useFrameCamera'

const item = (id: string, parentFrameId?: string): CameraItem =>
  parentFrameId ? { id, parentFrameId } : { id }

function Harness({ rf, focalCardId, items, edges }: {
  rf: CameraTarget
  focalCardId: string
  items: CameraItem[]
  edges?: CameraEdge[]
}) {
  useFrameCamera(rf, focalCardId, items, edges ?? [], true)
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
    render(<Harness rf={rf} focalCardId="card:f" items={[item('card:f'), item('card:x')]} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    // No `nodes` — a new focal fits everything. And it may zoom IN: at
    // maxZoom 1 a focused answer — small by design — rendered at 1:1
    // adrift in a field of dots.
    expect(fitView.mock.calls[0][0].nodes).toBeUndefined()
    expect(fitView.mock.calls[0][0].maxZoom).toBe(FIT_MAX_ZOOM)
    expect(FIT_MAX_ZOOM).toBeGreaterThan(1)
  })

  it('eases to arrivals plus their edge partners plus the focal, never everything', () => {
    const { rerender } = render(
      <Harness rf={rf} focalCardId="card:f" items={[item('card:f'), item('card:a')]} />,
    )
    flush()
    fitView.mockClear()
    rerender(
      <Harness
        rf={rf}
        focalCardId="card:f"
        items={[item('card:f'), item('card:a'), item('card:b')]}
        edges={[{ sourceCardId: 'card:a', targetCardId: 'card:b' }]}
      />,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    const framed = (fitView.mock.calls[0][0].nodes ?? []).map(n => n.id)
    expect(framed).toContain('card:b') // the arrival
    expect(framed).toContain('card:a') // its anchor
    expect(framed).toContain('card:f') // the focal, always
  })

  it('ignores arrivals inside frames — the frame is the event', () => {
    const { rerender } = render(
      <Harness rf={rf} focalCardId="card:f" items={[item('card:f'), item('frame:p')]} />,
    )
    flush()
    fitView.mockClear()
    rerender(
      <Harness
        rf={rf}
        focalCardId="card:f"
        items={[item('card:f'), item('frame:p'), item('card:row', 'frame:p')]}
      />,
    )
    flush()
    expect(fitView).not.toHaveBeenCalled()
  })

  it('re-centering re-fits even under StrictMode double-invocation', () => {
    const ui = (focal: string) => (
      <StrictMode>
        <Harness rf={rf} focalCardId={focal} items={[item(focal)]} />
      </StrictMode>
    )
    const { rerender } = render(ui('card:f'))
    flush()
    fitView.mockClear()
    rerender(ui('card:g'))
    flush()
    // The move happened for the NEW focal — the stamp-only-after-move
    // invariant is what makes this pass under double-invocation.
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(fitView.mock.calls[0][0].nodes).toBeUndefined()
  })

  it('stamps quiet pictures without scheduling a move', () => {
    const items = [item('card:f'), item('card:a')]
    const { rerender } = render(<Harness rf={rf} focalCardId="card:f" items={items} />)
    flush()
    fitView.mockClear()
    rerender(<Harness rf={rf} focalCardId="card:f" items={items} />)
    flush()
    expect(fitView).not.toHaveBeenCalled()
  })
})
