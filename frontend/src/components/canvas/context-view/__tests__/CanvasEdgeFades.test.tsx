/**
 * The canvas runs sideways past the window and nothing says so. The edge
 * fades are that sentence: a soft gradient on whichever side still has
 * content, absent on the side that has run out.
 *
 * They are DECORATION over the column rows, which makes one property
 * non-negotiable — `pointer-events-none`. A canvas notification card with
 * pointer events on cost a user a morning of un-clickable right-hand
 * column; nothing painted over the rows may ever take a click again.
 */
import { render, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasEdgeFades } from '../CanvasEdgeFades'

/** A scroller whose horizontal geometry the test drives directly. */
function makeScroller({ scrollLeft = 0, scrollWidth = 2000, clientWidth = 500 } = {}) {
  const g = { scrollLeft, scrollWidth, clientWidth }
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => g.scrollLeft, set: (v: number) => { g.scrollLeft = v } })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => g.scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => g.clientWidth })
  return { el, g }
}

function mount(geometry?: Parameters<typeof makeScroller>[0]) {
  const { el, g } = makeScroller(geometry)
  document.body.appendChild(el)
  const utils = render(<CanvasEdgeFades scrollRef={{ current: el }} />)
  const sides = () => [...utils.container.querySelectorAll('[data-canvas-edge-fade]')]
    .map(n => n.getAttribute('data-canvas-edge-fade'))
  /** Move the scroller the way a real scroll would, and let the fades hear it. */
  const scrollTo = (left: number) => { g.scrollLeft = left; fireEvent.scroll(el) }
  return { ...utils, el, sides, scrollTo }
}

afterEach(() => { cleanup(); document.body.replaceChildren() })

describe('CanvasEdgeFades', () => {
  it('shows only the right fade at the start of the run', () => {
    expect(mount({ scrollLeft: 0 }).sides()).toEqual(['right'])
  })

  it('shows both fades mid-run', () => {
    const { sides, scrollTo } = mount({ scrollLeft: 0 })
    scrollTo(700)
    expect(sides()).toEqual(['left', 'right'])
  })

  it('shows only the left fade at the end of the run', () => {
    const { sides, scrollTo } = mount({ scrollLeft: 0 })
    scrollTo(1500) // scrollWidth 2000 - clientWidth 500
    expect(sides()).toEqual(['left'])
  })

  it('shows nothing when every column already fits', () => {
    expect(mount({ scrollWidth: 500, clientWidth: 500 }).sides()).toEqual([])
  })

  it('never takes a pointer event away from the rows underneath', () => {
    const { container, scrollTo } = mount({ scrollLeft: 0 })
    scrollTo(700)
    const fades = [...container.querySelectorAll('[data-canvas-edge-fade]')]
    expect(fades).toHaveLength(2)
    for (const fade of fades) expect(fade).toHaveClass('pointer-events-none')
  })
})
