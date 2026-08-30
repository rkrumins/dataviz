/**
 * The toast stack and the canvas dock (Activity + Connections) share the
 * bottom-right corner. The stack is `z-80` with interactive items; the dock is
 * `z-40`. Measured in a real browser: with four toasts on screen, the point at
 * the centre of the Connections header belonged to a TOAST — collapsing the
 * dock was impossible until the messages timed out, and a canvas raises them
 * continuously as children load.
 *
 * Surfaces that own that corner publish their height as `--canvas-dock-height`;
 * the stack starts above whatever is reserved. Everywhere else the variable is
 * absent and the stack sits where it always did.
 */
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ToastContainer, useToastStore } from '../toast'

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--canvas-dock-height')
  useToastStore.setState({ toasts: [], history: [], _nextId: 1 })
})

const container = () => screen.getByTestId('toast-stack')

describe('the toast stack clears the canvas dock', () => {
  it('offsets its bottom by the reserved dock height', () => {
    render(<ToastContainer />)
    expect(container().style.bottom).toBe('calc(1.5rem + var(--canvas-dock-height, 0px))')
  })

  it('falls back to the plain inset when nothing reserves the corner', () => {
    render(<ToastContainer />)
    // No canvas mounted: the variable is unset, so the calc resolves to 1.5rem.
    expect(document.documentElement.style.getPropertyValue('--canvas-dock-height')).toBe('')
    expect(container().className).not.toMatch(/\bbottom-6\b/)
  })
})
