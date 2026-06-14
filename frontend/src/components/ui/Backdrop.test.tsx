/**
 * Backdrop — regression tests for the click-shield bug.
 *
 * The bug: a full-screen backdrop rendered as a framer-motion element inside
 * <AnimatePresence> could be stranded in the DOM under React StrictMode with
 * live pointer-events, shielding the whole viewport so no button was clickable
 * until a page refresh. <Backdrop> fixes that by being a plain CSS-toggled
 * <div> (never a motion element, never inside AnimatePresence) that is
 * `pointer-events-none` whenever closed. These tests pin those invariants.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Backdrop } from './Backdrop'

describe('Backdrop', () => {
  it('is inert (transparent + pointer-events-none) when closed', () => {
    const { container } = render(<Backdrop open={false} />)
    const el = container.firstChild as HTMLElement
    expect(el.tagName).toBe('DIV')
    expect(el).toHaveClass('opacity-0', 'pointer-events-none')
    expect(el).not.toHaveClass('opacity-100')
  })

  it('is visible and interactive when open', () => {
    const { container } = render(<Backdrop open />)
    const el = container.firstChild as HTMLElement
    expect(el).toHaveClass('opacity-100')
    expect(el).not.toHaveClass('pointer-events-none')
  })

  it('stays mounted as the SAME node across open→close→open and is inert when closed', () => {
    // Core anti-stranding guarantee: unlike a motion element in AnimatePresence,
    // the backdrop is never unmounted/re-created, and is always pointer-events-none
    // when closed — so it can never become an invisible full-screen click shield.
    const { container, rerender } = render(<Backdrop open />)
    const opened = container.firstChild as HTMLElement
    expect(opened).toHaveClass('opacity-100')

    rerender(<Backdrop open={false} />)
    const closed = container.firstChild as HTMLElement
    expect(closed).toBe(opened) // same DOM node — never duplicated or stranded
    expect(closed).toHaveClass('opacity-0', 'pointer-events-none')

    rerender(<Backdrop open />)
    expect(container.firstChild).toBe(opened)
    expect(container.firstChild as HTMLElement).toHaveClass('opacity-100')
  })

  it('invokes onClick when the backdrop is clicked', () => {
    const onClick = vi.fn()
    const { container } = render(<Backdrop open onClick={onClick} />)
    const el = container.firstChild as HTMLElement
    el.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('applies the provided z-index and tint, defaulting the tint when omitted', () => {
    const { container, rerender } = render(
      <Backdrop open zClassName="z-[60]" className="bg-black/60" />,
    )
    const el = container.firstChild as HTMLElement
    expect(el).toHaveClass('fixed', 'inset-0', 'z-[60]', 'bg-black/60')

    rerender(<Backdrop open />)
    expect(container.firstChild as HTMLElement).toHaveClass('bg-black/40') // default tint
  })
})
