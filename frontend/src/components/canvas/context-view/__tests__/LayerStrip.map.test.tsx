/**
 * The layer strip already knew which columns were on screen; it kept the
 * knowledge to itself. These cover the two surfaces that say it out loud:
 * a position rail whose lit window is the visible slice of the whole
 * scrollable width, and ‹ / › buttons that step exactly one layer column.
 *
 * Both are conditional on the canvas actually overflowing — a view whose
 * layers all fit gets the strip it has always had.
 */
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LayerStrip } from '../LayerStrip'

const LAYERS = [
  { id: 'l1', name: 'Source', color: '#3b82f6' },
  { id: 'l2', name: 'Staging', color: '#f59e0b' },
  { id: 'l3', name: 'Transform', color: '#10b981' },
  { id: 'l4', name: 'Warehouse', color: '#8b5cf6' },
]
/** Column left edges as scroll offsets — the live view's shape, near enough. */
const OFFSETS = [60, 430, 800, 1170]
const SCROLL_WIDTH = 2000
const CLIENT_WIDTH = 500
const COLUMN_WIDTH = 320
/** LayerColumn's collapsed rail. */
const COLLAPSED_WIDTH = 60

/**
 * A ResizeObserver that actually fires, and only for the elements it was
 * asked to watch — jsdom has none, and the global stub (src/test/setup.ts)
 * never calls back, so "watched" and "ignored" would look identical.
 */
class FiringResizeObserver {
  static live: FiringResizeObserver[] = []
  targets = new Set<Element>()
  constructor(readonly cb: () => void) { FiringResizeObserver.live.push(this) }
  observe(el: Element) { this.targets.add(el) }
  unobserve(el: Element) { this.targets.delete(el) }
  disconnect() { this.targets.clear() }
}
const resize = (el: Element) => act(() => {
  for (const ro of FiringResizeObserver.live) if (ro.targets.has(el)) ro.cb()
})

const rect = (left: number, width: number): DOMRect => ({
  left, right: left + width, width, top: 0, bottom: 400, height: 400, x: left, y: 0, toJSON: () => ({}),
})

function mount({ scrollLeft = 0, scrollWidth = SCROLL_WIDTH, clientWidth = CLIENT_WIDTH } = {}) {
  const g = { scrollLeft, scrollWidth, clientWidth }
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => g.scrollLeft, set: (v: number) => { g.scrollLeft = v } })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => g.scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => g.clientWidth })
  el.getBoundingClientRect = () => rect(0, g.clientWidth)
  // The columns sit in a wrapper inside the scroller, as they do on the
  // canvas: the wrapper is 100% wide, so a collapse moves nothing but the
  // columns themselves.
  const geo = OFFSETS.map(left => ({ left, width: COLUMN_WIDTH }))
  const wrapper = document.createElement('div')
  el.appendChild(wrapper)
  const cols = LAYERS.map((layer, i) => {
    const col = document.createElement('div')
    col.setAttribute('data-layer-id', layer.id)
    col.getBoundingClientRect = () => rect(geo[i].left - g.scrollLeft, geo[i].width)
    wrapper.appendChild(col)
    return col
  })
  const scrollTo = vi.fn()
  el.scrollTo = scrollTo as unknown as HTMLDivElement['scrollTo']

  const body = document.createElement('div')
  body.setAttribute('data-canvas-body', '')
  body.appendChild(el)
  const host = document.createElement('div')
  body.appendChild(host)
  document.body.appendChild(body)

  const utils = render(<LayerStrip layers={LAYERS} scrollRef={{ current: el }} />, { container: host })
  const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)
  return {
    ...utils,
    body,
    host,
    el,
    scrollTo,
    rail: () => q<HTMLElement>('[data-layer-rail]'),
    window: () => q<HTMLElement>('[data-layer-rail-window]'),
    prev: () => q<HTMLButtonElement>('button[aria-label="Previous layer"]'),
    next: () => q<HTMLButtonElement>('button[aria-label="Next layer"]'),
    scroll: (left: number) => { g.scrollLeft = left; fireEvent.scroll(el) },
    lit: () => [...host.querySelectorAll('[aria-current="true"]')].map(n => n.textContent),
    /**
     * Collapse a column to its rail, the way LayerColumn's own state does:
     * the run shortens and everything after it slides left, while the
     * scroller and the wrapper measure exactly what they did before — and
     * at scrollLeft 0 there is nothing to clamp, so nothing scrolls.
     */
    collapse: (i: number) => {
      const shrink = geo[i].width - COLLAPSED_WIDTH
      geo[i].width = COLLAPSED_WIDTH
      for (let j = i + 1; j < geo.length; j++) geo[j].left -= shrink
      g.scrollWidth -= shrink
      return resize(cols[i])
    },
  }
}

let originalRO: typeof globalThis.ResizeObserver
beforeEach(() => {
  originalRO = globalThis.ResizeObserver
  FiringResizeObserver.live = []
  globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof globalThis.ResizeObserver
})
afterEach(() => { globalThis.ResizeObserver = originalRO })

describe('LayerStrip position rail', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren() })

  it('sizes the window to the visible fraction of the whole run', () => {
    const { window } = mount()
    // 500 of 2000 on screen — a quarter of the track, parked at the left.
    expect(window()!.style.width).toBe('25%')
    expect(window()!.style.left).toBe('0%')
  })

  it('a narrower slice of a longer run gets a narrower window', () => {
    const { window } = mount({ scrollWidth: 5000 })
    expect(window()!.style.width).toBe('10%')
  })

  it('moves the window with scrollLeft', () => {
    const { window, scroll } = mount()
    scroll(500)
    expect(window()!.style.left).toBe('25%')
    scroll(1500)
    expect(window()!.style.left).toBe('75%')
  })

  it('scrubs the canvas to the point pressed on the rail', () => {
    const { rail, scrollTo } = mount()
    rail()!.getBoundingClientRect = () => rect(0, 200)
    fireEvent.pointerDown(rail()!, { clientX: 100 })
    // Half way along the track: centre the 500-wide window on 1000.
    expect(scrollTo).toHaveBeenCalledWith({ left: 750, behavior: 'auto' })
  })

  it('a cancelled drag does not leave the whole page scrubbing', () => {
    const { rail, scrollTo } = mount()
    rail()!.getBoundingClientRect = () => rect(0, 200)
    fireEvent.pointerDown(rail()!, { clientX: 100 })
    expect(scrollTo).toHaveBeenCalledTimes(1)
    // The UA takes the gesture over — a native drag, a lost pointer — so the
    // stream ends in `pointercancel` and `pointerup` never comes. Left bound,
    // every mouse move on the page would scroll the canvas, no button held.
    fireEvent.pointerCancel(window)
    fireEvent.pointerMove(window, { clientX: 150 })
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('unmounting mid-drag takes the listeners with it', () => {
    const { rail, scrollTo, unmount } = mount()
    rail()!.getBoundingClientRect = () => rect(0, 200)
    fireEvent.pointerDown(rail()!, { clientX: 100 })
    unmount() // entering trace mode unmounts the strip
    fireEvent.pointerMove(window, { clientX: 150 })
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('lives inside the element whose height the band reserves', () => {
    const { rail, body } = mount()
    expect(rail()!.closest('[data-layer-strip-bar]')).not.toBeNull()
    expect(body.style.getPropertyValue('--layer-strip-height')).not.toBe('')
  })
})

describe('LayerStrip step controls', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren() })

  it('steps to the next column, not by a pixel amount', () => {
    const { next, scrollTo } = mount()
    fireEvent.click(next()!)
    expect(scrollTo).toHaveBeenCalledWith({ left: OFFSETS[1], behavior: 'smooth' })
  })

  it('steps back to the previous column', () => {
    const { prev, scrollTo, scroll } = mount()
    scroll(800)
    fireEvent.click(prev()!)
    expect(scrollTo).toHaveBeenCalledWith({ left: OFFSETS[1], behavior: 'smooth' })
  })

  it('disables the way back at the start and the way on at the end', () => {
    const { prev, next, scroll } = mount()
    expect(prev()!.disabled).toBe(true)
    expect(next()!.disabled).toBe(false)
    scroll(1500) // 2000 - 500: nothing further right
    expect(prev()!.disabled).toBe(false)
    expect(next()!.disabled).toBe(true)
  })
})

describe('LayerStrip when a column collapses', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren() })

  it('re-sizes the rail window to the shorter run', async () => {
    const { window: railWindow, collapse } = mount()
    expect(railWindow()!.style.width).toBe('25%')
    await collapse(1) // 2000 - 260 = 1740 of run, still 500 on screen
    expect(railWindow()!.style.width).toBe('28.74%')
  })

  it('relights the pills for the columns the collapse brought into view', async () => {
    const { lit, collapse } = mount()
    await waitFor(() => expect(lit()).toEqual(['Source']))
    await collapse(1)
    await waitFor(() => expect(lit()).toEqual(['Source', 'Staging']))
  })
})

describe('LayerStrip when everything already fits', () => {
  let originalOffsetHeight: PropertyDescriptor | undefined
  const BAR_HEIGHT = 34

  beforeEach(() => {
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-layer-strip-bar') ? BAR_HEIGHT : 0 },
    })
  })
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  })

  it('renders neither rail nor step controls, and reserves the same band', () => {
    const { rail, prev, next, body, host } = mount({ scrollWidth: CLIENT_WIDTH })
    expect(rail()).toBeNull()
    expect(prev()).toBeNull()
    expect(next()).toBeNull()
    // Still the whole strip, still every pill, still the same reserved band.
    expect(host.querySelectorAll('button[aria-current]')).toHaveLength(LAYERS.length)
    expect(body.style.getPropertyValue('--layer-strip-height')).toBe(`${BAR_HEIGHT + 8}px`)
  })
})
