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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('a toast never swallows a click meant for the app', () => {
  it('the card is click-through, and only its controls opt back in', () => {
    const action = vi.fn()
    useToastStore.getState().addToast({ type: 'info', message: 'Entities loaded', action: { label: 'View', onClick: action } })
    render(<ToastContainer />)
    const card = screen.getByText('Entities loaded').closest('.w-80') as HTMLElement
    expect(card).not.toBeNull()
    // Measured live: four of these over the right-hand canvas column left the
    // rows beneath unclickable for seconds at a time, again and again as
    // children loaded — the left of a row worked and the rest was dead.
    expect(card.className).toContain('pointer-events-none')
    expect(card.className).not.toContain('pointer-events-auto')
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.className).toContain('pointer-events-auto')
    }
  })
})

describe('the stack stays organised', () => {
  it('exiting cards leave the flow, and nothing animates the width', () => {
    // The stack used to leave 64-128px holes: a dismissed card kept its slot
    // for the whole exit, so the survivors floated apart down the right of the
    // screen. And `scale: 0.95` made a card measure 304px of the 320px it
    // occupies, so a stack mid-flight looked like several different widths.
    const src = readFileSync(
      resolve(__dirname, '..', 'toast.tsx'),
      'utf8',
    )
    expect(src).toMatch(/<AnimatePresence mode="popLayout">/)
    expect(src).toMatch(/flex flex-col-reverse items-end/)
    // The card rises and fades; it never scales, because a scaled card
    // measures narrower than the space it occupies.
    expect(src).toMatch(/initial=\{\{ opacity: 0, y: 16 \}\}/)
    expect(src).not.toMatch(/scale: 0\.95/)
  })
})
