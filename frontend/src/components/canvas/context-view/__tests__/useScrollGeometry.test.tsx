/**
 * The geometry the edge fades and the position rail read has to change
 * when a COLUMN does. Collapsing one narrows the run by hundreds of
 * pixels while every box pinned to the container measures exactly the
 * same as before — the scroller is 100% wide and the columns wrapper is
 * a block-level flex container that stays 100% wide while its columns
 * overflow it — and at scrollLeft 0 nothing needs clamping, so no scroll
 * event fires either. Watched only through those boxes, the fades keep
 * promising canvas that is no longer there.
 *
 * So the hook watches the columns themselves, and watches the wrapper for
 * columns coming and going.
 */
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RefObject } from 'react'
import { useScrollGeometry } from '../useScrollGeometry'

/**
 * A ResizeObserver that actually fires, and only for the elements it was
 * asked to watch — jsdom has none, and the global test stub (src/test/setup.ts)
 * never calls back, so "observed" and "ignored" would look identical.
 */
class FiringResizeObserver {
  static live: FiringResizeObserver[] = []
  targets = new Set<Element>()
  constructor(readonly cb: () => void) { FiringResizeObserver.live.push(this) }
  observe(el: Element) { this.targets.add(el) }
  unobserve(el: Element) { this.targets.delete(el) }
  disconnect() { this.targets.clear() }
}

/** Report a size change on `el` — heard only by observers watching IT. */
const resize = (el: Element) => act(() => {
  for (const ro of FiringResizeObserver.live) if (ro.targets.has(el)) ro.cb()
})

function Geometry({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const { scrollLeft, scrollWidth, clientWidth } = useScrollGeometry(scrollRef)
  return <output>{`${scrollLeft}|${scrollWidth}|${clientWidth}`}</output>
}

/** The live shape: a 600-wide scroller, a 100%-wide wrapper, columns overflowing it. */
function mount({ scrollWidth = 1854, clientWidth = 600 } = {}) {
  const g = { scrollLeft: 0, scrollWidth, clientWidth }
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => g.scrollLeft })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => g.scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => g.clientWidth })
  const wrapper = document.createElement('div')
  el.appendChild(wrapper)
  const addColumn = (id: string) => {
    const col = document.createElement('div')
    col.setAttribute('data-layer-id', id)
    wrapper.appendChild(col)
    return col
  }
  const columns = ['l1', 'l2', 'l3', 'l4', 'l5'].map(addColumn)
  document.body.appendChild(el)
  const utils = render(<Geometry scrollRef={{ current: el }} />)
  return { ...utils, el, g, wrapper, columns, addColumn, read: () => utils.container.textContent }
}

describe('useScrollGeometry', () => {
  let original: typeof globalThis.ResizeObserver
  beforeEach(() => {
    original = globalThis.ResizeObserver
    FiringResizeObserver.live = []
    globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof globalThis.ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = original
    cleanup()
    document.body.replaceChildren()
  })

  it('re-reads the run when a column collapses', async () => {
    const { read, g, columns } = mount()
    expect(read()).toBe('0|1854|600')
    // A column collapses to its 60px rail: the run shortens, the scroller
    // and the wrapper do not move a pixel, and nothing scrolls.
    g.scrollWidth = 1594
    await resize(columns[2])
    expect(read()).toBe('0|1594|600')
  })

  it('picks up a column added after it subscribed, and watches it too', async () => {
    const { read, g, addColumn } = mount()
    g.scrollWidth = 2200
    const added = addColumn('l6')
    await waitFor(() => expect(read()).toBe('0|2200|600'))
    g.scrollWidth = 1900
    await resize(added)
    expect(read()).toBe('0|1900|600')
  })
})
