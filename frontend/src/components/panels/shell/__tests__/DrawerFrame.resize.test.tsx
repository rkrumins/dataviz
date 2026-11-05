/**
 * DrawerFrame's width: its left edge drags (or steps from the keyboard) to the
 * width the reader wants, which every drawer that opens there then keeps. Until
 * the reader chooses, the panel keeps its own default width.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferencesStore } from '@/store/preferences'

import { DrawerFrame } from '../DrawerShell'
import { DRAWER_MIN_WIDTH, drawerWidthCss } from '../drawerWidth'

function renderFrame() {
  return render(
    <DrawerFrame panel="test-drawer" label="Test details">
      <p>Inside</p>
    </DrawerFrame>,
  )
}

beforeEach(() => usePreferencesStore.setState({ drawerWidth: null }))

describe('DrawerFrame — width', () => {
  it('keeps the panel\'s default until the reader chooses one', () => {
    renderFrame()
    expect(drawerWidthCss(null)).toBe('clamp(420px, 32vw, 560px)')
    // jsdom drops clamp() from inline styles; what matters is that no width of
    // the reader's is set.
    expect(screen.getByText('Inside').parentElement!.style.width).not.toMatch(/px$/)
  })

  it('drags wider at its left edge, and keeps the width for the next drawer', () => {
    const { unmount } = renderFrame()
    const edge = screen.getByRole('separator', { name: 'Resize details panel' })
    const start = Number(edge.getAttribute('aria-valuenow'))
    fireEvent.pointerDown(edge, { clientX: 1000 })
    fireEvent.pointerMove(window, { clientX: 900 })
    fireEvent.pointerUp(window, { clientX: 900 })
    expect(usePreferencesStore.getState().drawerWidth).toBe(start + 100)
    unmount()

    renderFrame()
    expect(screen.getByText('Inside').parentElement).toHaveStyle({ width: `${start + 100}px` })
  })

  it('steps from the keyboard, and goes no narrower than its least', () => {
    usePreferencesStore.setState({ drawerWidth: 500 })
    renderFrame()
    const edge = screen.getByRole('separator', { name: 'Resize details panel' })
    expect(edge).toHaveAttribute('aria-valuenow', '500')
    fireEvent.keyDown(edge, { key: 'ArrowLeft' })
    expect(usePreferencesStore.getState().drawerWidth).toBe(516)
    fireEvent.keyDown(edge, { key: 'Home' })
    expect(usePreferencesStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)
  })
})
