/**
 * The layer strip while layers FOLD to fit.
 *
 * Nothing overflows then — every layer is on screen, open or as a spine — so
 * "which columns are in view" would light every pill and the scroll steps
 * would have nothing to scroll. The strip navigates the fold window instead.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LayerStrip, type LayerStripFold } from '../LayerStrip'

const LAYERS = [
  { id: 'l1', name: 'Source', color: '#3b82f6' },
  { id: 'l2', name: 'Staging', color: '#f59e0b' },
  { id: 'l3', name: 'Transform', color: '#10b981' },
  { id: 'l4', name: 'Warehouse', color: '#8b5cf6' },
]

/** A scroller whose run fits exactly — the folded canvas. */
function scroller() {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 1200 })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 1200 })
  el.scrollTo = vi.fn() as unknown as HTMLDivElement['scrollTo']
  document.body.appendChild(el)
  return el
}

function fold(over: Partial<LayerStripFold> = {}): LayerStripFold {
  return {
    openIds: new Set(['l2', 'l3']),
    focusLayer: vi.fn(),
    step: vi.fn(),
    canStep: { back: true, forward: true },
    ...over,
  }
}

const pill = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('LayerStrip — navigating the fold window', () => {
  it('lights the OPEN layers, not every layer on screen', () => {
    render(<LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} fold={fold()} />)
    expect(pill('Staging').getAttribute('aria-current')).toBe('true')
    expect(pill('Transform').getAttribute('aria-current')).toBe('true')
    expect(pill('Source').getAttribute('aria-current')).toBe('false')
    expect(pill('Warehouse').getAttribute('aria-current')).toBe('false')
  })

  it('opens a layer from its pill instead of scrolling to it', () => {
    const f = fold()
    const el = scroller()
    render(<LayerStrip layers={LAYERS} scrollRef={{ current: el }} fold={f} />)
    fireEvent.click(pill('Warehouse'))
    expect(f.focusLayer).toHaveBeenCalledWith('l4')
    expect(el.scrollTo).not.toHaveBeenCalled()
  })

  it('says what a folded layer’s pill does', () => {
    render(<LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} fold={fold()} />)
    expect(pill('Warehouse').getAttribute('title')).toBe('Unfold Warehouse')
  })

  it('slides the window one layer with ‹ and ›, though nothing overflows', () => {
    const f = fold()
    render(<LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} fold={f} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous layer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next layer' }))
    expect(f.step).toHaveBeenNthCalledWith(1, -1)
    expect(f.step).toHaveBeenNthCalledWith(2, 1)
  })

  it('goes flat at the ends of the run', () => {
    render(
      <LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} fold={fold({ canStep: { back: false, forward: true } })} />,
    )
    expect(screen.getByRole('button', { name: 'Previous layer' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next layer' })).toBeEnabled()
  })
})

describe('LayerStrip — folding on or off', () => {
  it('names what a press does, and says whether folding is on', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} foldToggle={{ enabled: true, onToggle }} />,
    )
    const on = screen.getByRole('button', { name: /Unfold all/ })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} foldToggle={{ enabled: false, onToggle }} />)
    expect(screen.getByRole('button', { name: /^Fold$/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('offers no toggle when the layers all fit', () => {
    render(<LayerStrip layers={LAYERS} scrollRef={{ current: scroller() }} />)
    expect(screen.queryByRole('button', { name: /Unfold all|^Fold$/ })).toBeNull()
  })
})
