import { StrictMode, useRef } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { FIT_MAX_ZOOM, FOCUS_MIN_ZOOM, FOCUS_HEADROOM_PX, useFrameCamera, type CameraTarget } from '../useFrameCamera'
import type { FocusCard, FocusEdge } from '../focus-cards'

const card = (id: string): FocusCard =>
  ({ id, nodeId: id === 'f' ? 'focal-urn' : `urn:${id}` }) as unknown as FocusCard

const wire = (source: string, target: string): FocusEdge =>
  ({ id: `e:${source}>${target}`, source, target }) as unknown as FocusEdge

function Harness({ rf, focalId, cards, edges = [], paneW = 0, paneH = 0, walking = false, frameKey, readerMoved = false, onState }: {
  rf: CameraTarget
  focalId: string
  cards: FocusCard[]
  edges?: FocusEdge[]
  /** A hands-free walk is landing cards (C4, 2026-08-21). */
  walking?: boolean
  /** The layout mode (density · steps · direction): a change re-frames the focus. */
  frameKey?: string
  /** The reader panned or zoomed since this picture was framed. */
  readerMoved?: boolean
  onState?: (state: ReturnType<typeof useFrameCamera>) => void
  /** Defaults to 0 — jsdom's own default `getBoundingClientRect` (no
   *  real layout), which every test in this file predates (P5) and does
   *  not care about: at 0×0 nothing ever measures as "already visible",
   *  so `fitView` always runs exactly as it did before. The two P5 tests
   *  below opt in with real numbers, stamped onto the ref's rect. */
  paneW?: number
  paneH?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const state = useFrameCamera(rf, focalId, cards, edges, true, containerRef, walking, frameKey, readerMoved)
  onState?.(state)
  return (
    <div
      ref={(el) => {
        containerRef.current = el
        if (el && (paneW || paneH)) {
          el.getBoundingClientRect = () =>
            ({ width: paneW, height: paneH, x: 0, y: 0, top: 0, left: 0, right: paneW, bottom: paneH, toJSON() { return this } }) as DOMRect
        }
      }}
    />
  )
}

describe('useFrameCamera', () => {
  let fitView: ReturnType<typeof vi.fn<CameraTarget['fitView']>>
  let getViewport: ReturnType<typeof vi.fn<CameraTarget['getViewport']>>
  let setViewport: ReturnType<typeof vi.fn<CameraTarget['setViewport']>>
  let rf: CameraTarget

  beforeEach(() => {
    vi.useFakeTimers()
    fitView = vi.fn<CameraTarget['fitView']>()
    getViewport = vi.fn<CameraTarget['getViewport']>(() => ({ x: 0, y: 0, zoom: 1 }))
    setViewport = vi.fn<CameraTarget['setViewport']>()
    rf = { fitView, getViewport, setViewport }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const flush = () => act(() => { vi.advanceTimersByTime(60) })
  // The ghost-nudge effect defers to 350ms, past the arrival effect's
  // own delay+animation, whenever a pill starts loading on the SAME
  // render as a new-focal fit or a real arrival — see its own comment
  // ("racingMainMove") in useFrameCamera.ts.
  const flushPastGhostRace = () => act(() => { vi.advanceTimersByTime(400) })

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
        cards={[card('f'), card('n:x'), card('n:new')]}
        edges={[wire('n:new', 'n:x')]}
      />,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(2)
    // The card that arrived, the card it attached to — and ALWAYS the
    // focal. An async answer panning the viewport to itself is how
    // "the actual focus node has disappeared" happened.
    expect(fitView.mock.calls[1][0].nodes).toEqual([{ id: 'n:new' }, { id: 'n:x' }, { id: 'f' }])
  })

  /**
   * Task 20, P5: "the camera nudges only if arrivals land off-viewport."
   * Before this, EVERY expansion eased the camera — even one that landed
   * squarely inside the pane the reader was already looking at.
   */
  it('does not move the camera when the arrival already fits on screen', () => {
    const withPos = (id: string, x: number, y: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80 }) as unknown as FocusCard
    const { rerender } = render(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0)]} paneW={1200} paneH={800} />,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(1) // the new-focal fit
    rerender(
      <Harness
        rf={rf}
        focalId="a"
        cards={[withPos('f', 0, 0), withPos('n:x', 250, 0), withPos('n:new', 500, 0)]}
        edges={[wire('n:new', 'n:x')]}
        paneW={1200}
        paneH={800}
      />,
    )
    flush()
    // Every card in the frame (n:new, n:x, f) sits well inside a
    // 1200×800 pane at the identity viewport — no second fitView.
    expect(fitView).toHaveBeenCalledTimes(1)
  })

  it('still eases when the arrival would land off-pane', () => {
    const withPos = (id: string, x: number, y: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80 }) as unknown as FocusCard
    const { rerender } = render(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0)]} paneW={1200} paneH={800} />,
    )
    flush()
    rerender(
      <Harness
        rf={rf}
        focalId="a"
        // Far outside a 1200×800 pane at the identity viewport.
        cards={[withPos('f', 0, 0), withPos('n:x', 4000, 0), withPos('n:new', 4300, 0)]}
        edges={[wire('n:new', 'n:x')]}
        paneW={1200}
        paneH={800}
      />,
    )
    flush()
    expect(fitView).toHaveBeenCalledTimes(2)
    // Both n:x and n:new arrived together here (neither is a pre-existing
    // anchor the other attached to), in the order `cards` lists them.
    expect(fitView.mock.calls[1][0].nodes).toEqual([{ id: 'n:x' }, { id: 'n:new' }, { id: 'f' }])
  })

  /**
   * Fix round 1 — reviewer finding: the extend-ghost (`ExtendGhost`,
   * FocusGraphView.tsx) draws the instant a pill starts loading, but
   * nothing told the camera, so a click near the pane's edge
   * acknowledged with a shimmer the reader could not see.
   */
  it('nudges the camera when a just-started extend ghost would land off-pane', () => {
    const withPos = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80, band }) as unknown as FocusCard
    const { rerender } = render(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0, 0), withPos('n:x', 800, 0, 2)]} paneW={1200} paneH={800} />,
    )
    flush()
    setViewport.mockClear()
    // n:x's downstream pill starts loading. Its ghost sits one band
    // further out (band 3, x 1110–1350 at CARD_W=240/BAND_GAP=130),
    // which runs past the right edge of a 1200-wide pane.
    rerender(
      <Harness
        rf={rf}
        focalId="a"
        cards={[
          withPos('f', 0, 0, 0),
          { ...withPos('n:x', 800, 0, 2), pillDown: { status: 'loading' } } as unknown as FocusCard,
        ]}
        paneW={1200}
        paneH={800}
      />,
    )
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)
    // A pan only — zoom stays put, moving LEFT (negative dx) to bring
    // the ghost's right edge back inside the pane.
    const [viewport] = setViewport.mock.calls[0]
    expect(viewport.zoom).toBe(1)
    expect(viewport.x).toBeLessThan(0)
  })

  /**
   * The exact `walkFrontier.png` shape, and the reviewer's own repro: a
   * pill is ALREADY loading on the very first render, the SAME moment
   * the new-focal fit runs. Nudging synchronously (the first attempt at
   * this fix) got silently overwritten the instant the main effect's
   * own `fitView` landed 30ms later, and the fixture's ghost stayed
   * invisible in the shot despite existing in the DOM. This is the test
   * that shape needed: `fitView` lands first, `setViewport` lands after.
   */
  it('defers the ghost nudge past a competing new-focal fit, then still applies it', () => {
    const withPos = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80, band }) as unknown as FocusCard
    render(
      <Harness
        rf={rf}
        focalId="a"
        cards={[
          withPos('f', 0, 0, 0),
          { ...withPos('n:x', 800, 0, 2), pillDown: { status: 'loading' } } as unknown as FocusCard,
        ]}
        paneW={1200}
        paneH={800}
      />,
    )
    // The main effect's own 30ms delay has landed; its fitView has run.
    act(() => { vi.advanceTimersByTime(30) })
    expect(fitView).toHaveBeenCalledTimes(1)
    // The ghost nudge has NOT — it is deliberately waiting out the race.
    expect(setViewport).not.toHaveBeenCalled()
    // Past the deferral: the nudge lands, reading whatever viewport the
    // fitView above left behind, not a stale pre-fit one.
    act(() => { vi.advanceTimersByTime(320) })
    expect(setViewport).toHaveBeenCalledTimes(1)
  })

  /**
   * This file's own StrictMode lesson, repeated once for the ghost
   * effect and caught the same way: the DEFERRED branch's first draft
   * stamped `loadingGhostsRef` before scheduling the nudge, not once it
   * actually applied. Under StrictMode's mount → cleanup → mount, run 1
   * stamped it and scheduled a timeout; cleanup cancelled that timeout;
   * run 2 saw "already seen" and scheduled nothing — the nudge that was
   * supposed to fire never did, silently. Real against `walkFrontier.png`
   * (StrictMode is on in the harness): the ghost stayed invisible in the
   * shot even after the deferred-timing fix above, until this was found.
   */
  it('still nudges when the deferred branch\'s first effect run is cancelled (StrictMode)', () => {
    const withPos = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80, band }) as unknown as FocusCard
    render(
      <StrictMode>
        <Harness
          rf={rf}
          focalId="a"
          cards={[
            withPos('f', 0, 0, 0),
            { ...withPos('n:x', 800, 0, 2), pillDown: { status: 'loading' } } as unknown as FocusCard,
          ]}
          paneW={1200}
          paneH={800}
        />
      </StrictMode>,
    )
    flushPastGhostRace()
    expect(setViewport).toHaveBeenCalledTimes(1)
  })

  it('does not nudge for a ghost that already fits on screen', () => {
    const withPos = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80, band }) as unknown as FocusCard
    const { rerender } = render(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0, 0)]} paneW={1200} paneH={800} />,
    )
    flush()
    setViewport.mockClear()
    rerender(
      <Harness
        rf={rf}
        focalId="a"
        cards={[
          withPos('f', 0, 0, 0),
          // y=100, not 0 — the nudge's own landing target wants genuine
          // clearance (`GHOST_LANDING_PADDING_PX`), not merely the more
          // lenient "already visible" tolerance `flush against the edge`
          // would allow.
          { ...withPos('n:x', 0, 100, 0), pillDown: { status: 'loading' } } as unknown as FocusCard,
        ]}
        paneW={1200}
        paneH={800}
      />,
    )
    flush()
    expect(setViewport).not.toHaveBeenCalled()
  })

  it('does not re-nudge for a pill that was already loading last render', () => {
    const withPos = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...card(id), x, y, w: 200, h: 80, band }) as unknown as FocusCard
    const loading = (id: string, x: number, y: number, band: number): FocusCard =>
      ({ ...withPos(id, x, y, band), pillDown: { status: 'loading' } }) as unknown as FocusCard
    const { rerender } = render(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0, 0), loading('n:x', 800, 0, 2)]} paneW={1200} paneH={800} />,
    )
    // The pill is ALREADY loading on the very first (new-focal) render
    // here, so the nudge defers past the race guard.
    flushPastGhostRace()
    expect(setViewport).toHaveBeenCalledTimes(1) // the initial nudge
    setViewport.mockClear()
    // Same pill, still loading (a re-render with no NEW loading pill) —
    // re-nudging here would fight a reader who panned away on purpose.
    rerender(
      <Harness rf={rf} focalId="a" cards={[withPos('f', 0, 0, 0), loading('n:x', 800, 0, 2)]} paneW={1200} paneH={800} />,
    )
    flush()
    expect(setViewport).not.toHaveBeenCalled()
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

  /**
   * C4 (2026-08-21): a hands-free walk lands cards every few seconds for
   * minutes on a wide board. Easing to each wave — the expansion rule
   * above — yanked the reader off whatever they were reading, once per
   * request, for the whole walk. While the walk is landing cards the
   * camera holds still and the hook REPORTS that the board grew, so the
   * view can offer a "Fit" instead of taking it; the reader fits when
   * they want to, which also clears the flag.
   */
  it('holds still while the walk lands cards, and reports that the board grew', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    const onState = (s: ReturnType<typeof useFrameCamera>) => { state = s }
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[card('f')]} walking onState={onState} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)          // a new focal still frames itself
    expect(state!.grew).toBe(false)
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:w1'), card('n:w2')]} edges={[wire('n:w1', 'f')]} walking onState={onState} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)          // arrivals did NOT move the camera
    expect(state!.grew).toBe(true)
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:w1'), card('n:w2'), card('n:w3')]} walking onState={onState} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    // The reader asks for the whole board: one fit of everything, flag cleared.
    act(() => { state!.fitAll() })
    expect(fitView).toHaveBeenCalledTimes(2)
    expect(fitView.mock.calls[1][0].nodes).toBeUndefined()
    expect(fitView.mock.calls[1][0].maxZoom).toBe(FIT_MAX_ZOOM)
    expect(state!.grew).toBe(false)
  })

  it('a card the reader expands after the walk still eases the camera as before', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    const onState = (s: ReturnType<typeof useFrameCamera>) => { state = s }
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} walking onState={onState} />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x')]} walking={false} onState={onState} />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:x'), card('n:new')]} edges={[wire('n:new', 'n:x')]} walking={false} onState={onState} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(2)
    expect(fitView.mock.calls[1][0].nodes).toEqual([{ id: 'n:new' }, { id: 'n:x' }, { id: 'f' }])
    expect(state!.grew).toBe(false)
  })

  it('a new focal clears the grew flag — it is a new picture, framed whole', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    const onState = (s: ReturnType<typeof useFrameCamera>) => { state = s }
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[card('f')]} walking onState={onState} />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={[card('f'), card('n:w1')]} walking onState={onState} />)
    flush()
    expect(state!.grew).toBe(true)
    rerender(<Harness rf={rf} focalId="b" cards={[card('f')]} walking onState={onState} />)
    flush()
    expect(state!.grew).toBe(false)
    expect(fitView).toHaveBeenCalledTimes(2)
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

describe('useFrameCamera — the focus first (2026-08-22)', () => {
  // "When I open Focus with dozens of upstream/downstream edges the focus
  // node is tiny, and switching density I have to click Zoom In until I
  // even find it." A new picture used to be FITTED WHOLE, whatever its
  // size; now a board that cannot be read at its fit zoom opens centred
  // on the focus at a readable zoom instead, a layout-mode switch does
  // the same, and `recenter()` does it on demand.
  let fitView: ReturnType<typeof vi.fn<CameraTarget['fitView']>>
  let setViewport: ReturnType<typeof vi.fn<CameraTarget['setViewport']>>
  let rf: CameraTarget
  beforeEach(() => {
    vi.useFakeTimers()
    fitView = vi.fn<CameraTarget['fitView']>()
    setViewport = vi.fn<CameraTarget['setViewport']>()
    rf = { fitView, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport }
  })
  afterEach(() => { vi.useRealTimers() })
  const flush = () => act(() => { vi.advanceTimersByTime(60) })
  const placed = (id: string, x: number, y: number, w: number, h: number, band: number): FocusCard =>
    ({ ...card(id), x, y, w, h, band, frameId: null }) as unknown as FocusCard
  const focal = () => placed('f', 0, -60, 300, 120, 0)
  /** Forty partners stacked in the upstream band: 3,600px tall, a fit
   *  zoom of ~0.19 on a 900px pane — unreadable. */
  const tall = () => Array.from({ length: 40 }, (_, i) => placed(`n:u${i}`, -480, -1800 + i * 90, 240, 80, -1))

  it('a board that fits readably is still fitted whole', () => {
    render(<Harness rf={rf} focalId="a" cards={[focal(), placed('n:x', -480, -40, 240, 80, -1)]} paneW={1500} paneH={900} />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)
    expect(setViewport).not.toHaveBeenCalled()
  })

  it('a board too large to read at its fit zoom opens centred on the focus, at a readable zoom', () => {
    render(<Harness rf={rf} focalId="a" cards={[focal(), ...tall()]} paneW={1500} paneH={900} />)
    flush()
    expect(fitView).not.toHaveBeenCalled()
    expect(setViewport).toHaveBeenCalledTimes(1)
    const vp = setViewport.mock.calls[0][0]
    expect(vp.zoom).toBeGreaterThanOrEqual(FOCUS_MIN_ZOOM)
    expect(vp.zoom).toBeLessThanOrEqual(FIT_MAX_ZOOM)
    // The focal's centre (150, 0) lands on the pane's centre (750, 450).
    expect(vp.x + 150 * vp.zoom).toBeCloseTo(750, 0)
    expect(vp.y + 0 * vp.zoom).toBeCloseTo(450, 0)
  })

  it('a tall focal frame lands with its header under the capsule, not behind it', () => {
    // The focus framing centres the VISIBLE part of a tall frame; with no
    // headroom that put its header at the very top of the pane — exactly
    // where the walk capsule sits.
    const tallFocal = placed('f', 0, -450, 300, 900, 0)
    render(<Harness rf={rf} focalId="a" cards={[tallFocal, ...tall()]} paneW={1500} paneH={900} />)
    flush()
    const vp = setViewport.mock.calls[0][0]
    const screenTop = vp.y + tallFocal.y * vp.zoom
    expect(screenTop).toBeGreaterThanOrEqual(FOCUS_HEADROOM_PX - 1)
  })

  it('a layout-mode switch (the frame key) re-frames the focus', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[focal(), ...tall()]} paneW={1500} paneH={900} frameKey="grouped" />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)
    rerender(<Harness rf={rf} focalId="a" cards={[focal(), ...tall()]} paneW={1500} paneH={900} frameKey="overview" />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(2)
  })

  it('recenter() brings the focus to the middle at the readable zoom, on demand — on any board', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    render(<Harness rf={rf} focalId="a" cards={[focal(), placed('n:x', -480, -40, 240, 80, -1)]} paneW={1500} paneH={900} onState={(s) => { state = s }} />)
    flush()
    setViewport.mockClear()
    act(() => { state!.recenter() })
    expect(setViewport).toHaveBeenCalledTimes(1)
    const vp = setViewport.mock.calls[0][0]
    expect(vp.zoom).toBeGreaterThanOrEqual(FOCUS_MIN_ZOOM)
    expect(vp.x + 150 * vp.zoom).toBeCloseTo(750, 0)
  })
})

describe('useFrameCamera — the walk settles on the focus (2026-08-22)', () => {
  // The camera holds still while a hands-free walk lands cards (C4), and
  // the focal frame grows around the midline meanwhile — so by the end
  // its header had drifted up under the capsule. One move when the walk
  // ENDS brings the focus back, readable; never if the reader has moved
  // the camera themselves (then the offer stays a pill).
  let fitView: ReturnType<typeof vi.fn<CameraTarget['fitView']>>
  let setViewport: ReturnType<typeof vi.fn<CameraTarget['setViewport']>>
  let rf: CameraTarget
  beforeEach(() => {
    vi.useFakeTimers()
    fitView = vi.fn<CameraTarget['fitView']>()
    setViewport = vi.fn<CameraTarget['setViewport']>()
    rf = { fitView, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport }
  })
  afterEach(() => { vi.useRealTimers() })
  const flush = () => act(() => { vi.advanceTimersByTime(60) })
  const placed = (id: string, x: number, y: number, w: number, h: number, band: number): FocusCard =>
    ({ ...card(id), x, y, w, h, band, frameId: null }) as unknown as FocusCard
  const small = () => [placed('f', 0, -60, 300, 120, 0), placed('n:x', -480, -40, 240, 80, -1)]
  const grown = () => [placed('f', 0, -450, 300, 900, 0), ...Array.from({ length: 40 }, (_, i) => placed(`n:u${i}`, -480, -1800 + i * 90, 240, 80, -1))]

  it('one move when the walk ends and the board grew: the focus, readable', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={small()} paneW={1500} paneH={900} walking />)
    flush()
    expect(fitView).toHaveBeenCalledTimes(1)             // the first paint, fitted whole
    rerender(<Harness rf={rf} focalId="a" cards={grown()} paneW={1500} paneH={900} walking />)
    flush()
    expect(setViewport).not.toHaveBeenCalled()           // holds while walking
    rerender(<Harness rf={rf} focalId="a" cards={grown()} paneW={1500} paneH={900} walking={false} />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)         // the settle
    expect(setViewport.mock.calls[0][0].zoom).toBeGreaterThanOrEqual(FOCUS_MIN_ZOOM)
  })

  it('no settle when the reader moved the camera during the walk — the offer stays', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={small()} paneW={1500} paneH={900} walking onState={(s) => { state = s }} />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={grown()} paneW={1500} paneH={900} walking readerMoved onState={(s) => { state = s }} />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={grown()} paneW={1500} paneH={900} walking={false} readerMoved onState={(s) => { state = s }} />)
    flush()
    expect(setViewport).not.toHaveBeenCalled()
    expect(state!.grew).toBe(true)
  })
})

describe('useFrameCamera — is the focus in view? (2026-08-22)', () => {
  // The way back to the focus has to be findable exactly when the focus
  // has been lost: the board asks this on every viewport move and offers
  // a pill when the answer is no.
  let rf: CameraTarget
  beforeEach(() => {
    vi.useFakeTimers()
    rf = { fitView: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport: vi.fn() }
  })
  afterEach(() => { vi.useRealTimers() })
  const placed = (id: string, x: number, y: number, w: number, h: number, band: number): FocusCard =>
    ({ ...card(id), x, y, w, h, band, frameId: null }) as unknown as FocusCard
  const focal = () => placed('f', 0, -60, 300, 120, 0)

  it('answers from the viewport it is handed: centred = in view, panned away = lost', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    render(<Harness rf={rf} focalId="a" cards={[focal()]} paneW={1500} paneH={900} onState={(s) => { state = s }} />)
    act(() => { vi.advanceTimersByTime(60) })
    expect(state!.focusInView({ x: 600, y: 450, zoom: 1 })).toBe(true)      // focal spans 600–900 × 390–510
    expect(state!.focusInView({ x: -2000, y: 450, zoom: 1 })).toBe(false)   // panned two screens left
    expect(state!.focusInView({ x: 600, y: -400, zoom: 1 })).toBe(false)    // scrolled above the top
  })

  it('a pane it cannot measure, or a focal with no geometry, never reports the focus lost', () => {
    let state: ReturnType<typeof useFrameCamera> | null = null
    render(<Harness rf={rf} focalId="a" cards={[card('f')]} onState={(s) => { state = s }} />)
    act(() => { vi.advanceTimersByTime(60) })
    expect(state!.focusInView({ x: -2000, y: 0, zoom: 1 })).toBe(true)
  })
})

describe('useFrameCamera — the first paint is framed, and the walk always settles (2026-08-22)', () => {
  // "On the initial open, when the lineage is done loading, the focus node
  // is tiny until I click Center on focus." Two causes, both here: the
  // camera stamped the EMPTY board as framed, so the real first paint was
  // treated as an arrival during the walk and held; and the end-of-walk
  // settle ran only when top-level cards had arrived — a coarse-first walk
  // that merely fills rows never qualified.
  let fitView: ReturnType<typeof vi.fn<CameraTarget['fitView']>>
  let setViewport: ReturnType<typeof vi.fn<CameraTarget['setViewport']>>
  let rf: CameraTarget
  beforeEach(() => {
    vi.useFakeTimers()
    fitView = vi.fn<CameraTarget['fitView']>()
    setViewport = vi.fn<CameraTarget['setViewport']>()
    rf = { fitView, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport }
  })
  afterEach(() => { vi.useRealTimers() })
  const flush = () => act(() => { vi.advanceTimersByTime(60) })
  const placed = (id: string, x: number, y: number, w: number, h: number, band: number): FocusCard =>
    ({ ...card(id), x, y, w, h, band, frameId: null }) as unknown as FocusCard
  const big = (focalH = 120) => [placed('f', 0, -focalH / 2, 300, focalH, 0), ...Array.from({ length: 40 }, (_, i) => placed(`n:u${i}`, -480, -1800 + i * 90, 240, 80, -1))]

  it('an empty board is not a framed picture: the first real paint gets the focus-first framing even mid-walk', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={[]} paneW={1500} paneH={900} walking />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={big()} paneW={1500} paneH={900} walking />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)          // centred on the focus, readable
    expect(setViewport.mock.calls[0][0].zoom).toBeGreaterThanOrEqual(FOCUS_MIN_ZOOM)
  })

  it('the settle survives the re-renders the end of a walk itself causes', () => {
    // `done` re-lays the board out (vouched edges, counts) within the same
    // tick as the walking → done edge. A settle timer cancelled by that
    // re-render, whose re-run no longer sees the edge, never fired — the
    // focus stayed where the first framing left it.
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={big(120)} paneW={1500} paneH={900} walking />)
    flush()
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking />)
    flush()
    setViewport.mockClear()
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking={false} />)
    act(() => { vi.advanceTimersByTime(10) })
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking={false} />)   // a fresh cards array, 10 ms later
    act(() => { vi.advanceTimersByTime(10) })
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking={false} />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)
  })

  it('a walk that only filled rows — no new top-level card — still settles on the focus when it ends', () => {
    const { rerender } = render(<Harness rf={rf} focalId="a" cards={big(120)} paneW={1500} paneH={900} walking />)
    flush()
    setViewport.mockClear()
    // Rows landed inside the focal frame: same top-level cards, a taller focal.
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking />)
    flush()
    expect(setViewport).not.toHaveBeenCalled()              // holds while walking
    rerender(<Harness rf={rf} focalId="a" cards={big(900)} paneW={1500} paneH={900} walking={false} />)
    flush()
    expect(setViewport).toHaveBeenCalledTimes(1)            // the settle
  })
})
