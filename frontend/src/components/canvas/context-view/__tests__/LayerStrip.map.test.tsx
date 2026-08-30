/**
 * The layer strip already knew which columns were on screen; it kept the
 * knowledge to itself. These cover the two surfaces that say it out loud:
 * a position rail whose lit window is the visible slice of the whole
 * scrollable width, and ‹ / › buttons that step exactly one layer column.
 *
 * Both are conditional on the canvas actually overflowing — a view whose
 * layers all fit gets the strip it has always had.
 */
import { render, cleanup, fireEvent } from '@testing-library/react'
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
  LAYERS.forEach((layer, i) => {
    const col = document.createElement('div')
    col.setAttribute('data-layer-id', layer.id)
    col.getBoundingClientRect = () => rect(OFFSETS[i] - g.scrollLeft, 320)
    el.appendChild(col)
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
  }
}

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
