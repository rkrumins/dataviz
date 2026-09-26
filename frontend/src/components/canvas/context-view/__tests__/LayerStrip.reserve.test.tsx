/**
 * The layer strip floats over the bottom of the columns. A column whose
 * content ends inside the strip's footprint has a last row nobody can
 * click (the strip's pills take the click and jump layers) and nothing to
 * scroll it clear with. The strip therefore publishes its height on the
 * canvas body — exactly the way TraceBottomDock publishes
 * `--trace-dock-height` — so the columns can reserve the band.
 */
import { createRef } from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LayerStrip } from '../LayerStrip'

const LAYERS = [
  { id: 'l1', name: 'Source', color: '#3b82f6' },
  { id: 'l2', name: 'Staging', color: '#f59e0b' },
]

const BAR_HEIGHT = 34
const GAP = 8

function mount(layers = LAYERS) {
  const scrollRef = createRef<HTMLDivElement>()
  const utils = render(
    <div data-canvas-body>
      <div ref={scrollRef} />
      <LayerStrip layers={layers} scrollRef={scrollRef} />
    </div>,
  )
  const body = utils.container.querySelector<HTMLElement>('[data-canvas-body]')!
  return { ...utils, body }
}

describe('LayerStrip reserves its band', () => {
  let originalOffsetHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    // jsdom lays nothing out; give the strip's pill bar a real height.
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-layer-strip-bar') ? BAR_HEIGHT : 0
      },
    })
  })

  afterEach(() => {
    cleanup()
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    vi.restoreAllMocks()
  })

  it('publishes its height plus the gap on the canvas body', () => {
    const { body } = mount()
    expect(body.style.getPropertyValue('--layer-strip-height')).toBe(`${BAR_HEIGHT + GAP}px`)
  })

  it('withdraws the reservation when it unmounts', () => {
    const { body, unmount } = mount()
    expect(body.style.getPropertyValue('--layer-strip-height')).not.toBe('')
    unmount()
    expect(body.style.getPropertyValue('--layer-strip-height')).toBe('')
  })

  it('reserves nothing when it renders nothing', () => {
    const { body } = mount([LAYERS[0]])
    expect(body.style.getPropertyValue('--layer-strip-height')).toBe('')
  })
})
