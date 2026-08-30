/**
 * The notification stack and the canvas dock (Data loads + Connections) share
 * the bottom-right corner. The stack is `z-80` with interactive items; the
 * dock is `z-40`. Measured in a real browser: with four notifications on
 * screen, the point at the centre of the Connections header belonged to a
 * NOTIFICATION — collapsing the dock was impossible until the messages timed
 * out, and a canvas raises them continuously as children load.
 *
 * Surfaces that own that corner publish their height as `--canvas-dock-height`;
 * the stack starts above whatever is reserved. Everywhere else the variable is
 * absent and the stack sits where it always did.
 */
import { act, render, renderHook, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotificationStack, useLoadingNotification, useNotificationStore } from '../notifications'

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--canvas-dock-height')
  useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
})

const container = () => screen.getByTestId('notification-stack')

describe('the notification stack clears the canvas dock', () => {
  it('offsets its bottom by the reserved dock height', () => {
    render(<NotificationStack />)
    expect(container().style.bottom).toBe('calc(1.5rem + var(--canvas-dock-height, 0px))')
  })

  it('falls back to the plain inset when nothing reserves the corner', () => {
    render(<NotificationStack />)
    // No canvas mounted: the variable is unset, so the calc resolves to 1.5rem.
    expect(document.documentElement.style.getPropertyValue('--canvas-dock-height')).toBe('')
    expect(container().className).not.toMatch(/\bbottom-6\b/)
  })
})

describe('a notification never swallows a click meant for the app', () => {
  it('the card is click-through, and only its controls opt back in', () => {
    const action = vi.fn()
    useNotificationStore.getState().add({ type: 'info', message: 'Entities loaded', action: { label: 'View', onClick: action } })
    render(<NotificationStack />)
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
      resolve(__dirname, '..', 'notifications.tsx'),
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

describe('a loading notification can compute its own words', () => {
  const live = () => useNotificationStore.getState().notifications
  const said = () => useNotificationStore.getState().history.map(h => h.message)

  it('calls the success message ONCE, at the falling edge — not on every render', () => {
    // The whole point of a function: "Opened “X” · 1,204 items" has to read
    // the count at the moment the load finishes. Evaluated at declaration it
    // would report whatever the canvas held when the load STARTED — zero.
    let items = 0
    const success = vi.fn(() => `Opened · ${items} items`)
    const { rerender } = renderHook(
      ({ isLoading }: { isLoading: boolean }) => useLoadingNotification('k', isLoading, 'Opening…', success),
      { initialProps: { isLoading: true } },
    )

    expect(success).not.toHaveBeenCalled()
    items = 1204
    rerender({ isLoading: true })
    rerender({ isLoading: true })
    expect(success).not.toHaveBeenCalled()

    rerender({ isLoading: false })
    expect(success).toHaveBeenCalledTimes(1)
    expect(said()).toEqual(['Opened · 1204 items'])
  })

  it('resolves a computed loading message when the load starts', () => {
    const loading = vi.fn(() => 'Loading Snowflake…')
    renderHook(() => useLoadingNotification('k', true, loading))
    expect(loading).toHaveBeenCalledTimes(1)
    expect(live().map(t => t.message)).toEqual(['Loading Snowflake…'])
  })

  it('does not replace the live card while a fresh closure arrives every render', () => {
    // An inline `() => ...` has a new identity on every render. In the dep
    // array that re-ran the effect each time and `showLoading` swapped the
    // notification for a new one — a card that restarts continuously.
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useLoadingNotification('k', true, () => `Loading ${n}…`),
      { initialProps: { n: 1 } },
    )
    const id = live()[0].id
    rerender({ n: 2 })
    rerender({ n: 3 })
    expect(live()).toHaveLength(1)
    expect(live()[0].id).toBe(id)
  })

  it('still says nothing when the load ended in failure', () => {
    const success = vi.fn(() => 'Opened · 3 items')
    const { rerender } = renderHook(
      ({ isLoading }: { isLoading: boolean }) =>
        useLoadingNotification('k', isLoading, 'Opening…', success, true),
      { initialProps: { isLoading: true } },
    )
    rerender({ isLoading: false })
    expect(success).not.toHaveBeenCalled()
    expect(said()).toEqual([])
  })

  it('a plain string message still follows its own changes while loading', () => {
    const { rerender } = renderHook(
      ({ phase }: { phase: string }) => useLoadingNotification('k', true, phase),
      { initialProps: { phase: 'Opening…' } },
    )
    expect(live()[0].message).toBe('Opening…')
    rerender({ phase: 'Loading connections…' })
    expect(live()).toHaveLength(1)
    expect(live()[0].message).toBe('Loading connections…')
  })
})

describe('a notification can be given a longer life than the default', () => {
  it('honours its own durationMs, in the dismiss timer AND in the progress bar', () => {
    // The admin Features page offers an Undo on the card that says what it
    // just changed. At the shared 4.5s it expired before it could be read and
    // reached — which is worse than offering nothing, because the escape hatch
    // was visibly there and then gone.
    vi.useFakeTimers()
    try {
      const store = useNotificationStore.getState()
      store.add({ type: 'success', message: 'Lineage trace — turned off', durationMs: 8000 })
      store.add({ type: 'success', message: 'Saved' })
      render(<NotificationStack />)

      const card = screen.getByText('Lineage trace — turned off').closest('.w-80') as HTMLElement
      const bar = card.querySelector<HTMLElement>('[style*="nx-toast-progress"]')!
      expect(bar.style.animation).toContain('8000ms')

      // Past the default, and past when the ordinary one goes.
      act(() => { vi.advanceTimersByTime(5000) })
      expect(useNotificationStore.getState().notifications.map(n => n.message)).toEqual([
        'Lineage trace — turned off',
      ])

      // Gone on its own schedule, not kept alive forever.
      act(() => { vi.advanceTimersByTime(3100) })
      expect(useNotificationStore.getState().notifications).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
