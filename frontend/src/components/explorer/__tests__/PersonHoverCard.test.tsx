/**
 * The card opens on the side of its trigger with room for it: below a trigger in the
 * top half of the window, above one in the bottom half, where it used to run off the
 * foot of the screen.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonHoverCard } from '../PersonHoverCard'

const realHeight = window.innerHeight

function hoverAt(top: number) {
  render(
    <PersonHoverCard userId="u_ada" displayName="Ada Lovelace" roles={['Created · 1 May']}>
      <button type="button">Ada</button>
    </PersonHoverCard>,
  )
  const trigger = screen.getByRole('button', { name: 'Ada' })
  trigger.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 100, right: 120, width: 20, height: 20, x: 100, y: top, toJSON: () => ({}) })
  fireEvent.mouseEnter(trigger)
  act(() => { vi.advanceTimersByTime(300) })
  return screen.getByRole('tooltip')
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, 'innerHeight', { value: realHeight, configurable: true })
})

describe('PersonHoverCard', () => {
  it('opens below a trigger in the top half of the window', () => {
    const card = hoverAt(100)
    expect(card.style.top).toBe('128px')
    expect(card.style.bottom).toBe('')
  })

  it('opens above a trigger in the bottom half', () => {
    const card = hoverAt(700)
    expect(card.style.bottom).toBe('108px')
    expect(card.style.top).toBe('')
  })
})
