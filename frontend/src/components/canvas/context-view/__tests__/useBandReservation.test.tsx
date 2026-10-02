/**
 * Bottom-docked chrome (the layer strip, the edge legend) must reserve the
 * band it floats in, or a column's last row ends up under it. Each piece
 * publishes its height as a CSS variable on the canvas body — this hook is
 * the one way they all do it.
 */
import { useRef } from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBandReservation } from '../useBandReservation'

const HEIGHTS: Record<string, number> = { whole: 40, header: 24 }

function Chrome({ measureHeader = false }: { measureHeader?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useBandReservation(
    ref,
    '--test-chrome-height',
    measureHeader ? (el) => el.querySelector<HTMLElement>('[data-header]')?.offsetHeight ?? 0 : undefined,
  )
  return (
    <div ref={ref} data-measure="whole">
      <div data-header data-measure="header" />
      <div data-measure="body" />
    </div>
  )
}

function mount(props: { measureHeader?: boolean } = {}) {
  const utils = render(
    <div data-canvas-body>
      <Chrome {...props} />
    </div>,
  )
  return { ...utils, body: utils.container.querySelector<HTMLElement>('[data-canvas-body]')! }
}

describe('useBandReservation', () => {
  let original: PropertyDescriptor | undefined

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return HEIGHTS[this.getAttribute('data-measure') ?? ''] ?? 0
      },
    })
  })

  afterEach(() => {
    cleanup()
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
  })

  it('publishes the element height plus the gap on the canvas body', () => {
    const { body } = mount()
    expect(body.style.getPropertyValue('--test-chrome-height')).toBe('48px')
  })

  it('measures what the caller asks for — the header, not the expanded body', () => {
    const { body } = mount({ measureHeader: true })
    expect(body.style.getPropertyValue('--test-chrome-height')).toBe('32px')
  })

  it('withdraws the reservation on unmount', () => {
    const { body, unmount } = mount()
    unmount()
    expect(body.style.getPropertyValue('--test-chrome-height')).toBe('')
  })
})
