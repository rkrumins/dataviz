/**
 * The connect layer — the band to the pointer, the rings on the source and the card under it, and
 * the hint of what linking there would do — is drawn OVER the columns. It used to sit beneath them
 * (z-6, under the columns' z-canvas), so a card painted over the hint and the band went missing
 * behind each column while a connection was being made.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Z_INDEX } from '@/lib/zIndex'
import { ConnectionDragLayer } from '../ConnectionDragLayer'

describe('ConnectionDragLayer', () => {
  it('sits on a rung above the columns, so the hint and the band are never behind a card', () => {
    const { container } = render(<ConnectionDragLayer sourceIds={['a']} pointer={null} live="armed" />)
    const layer = container.firstElementChild as HTMLElement
    expect(layer.className).toMatch(/\bz-chrome\b/)
    expect(Z_INDEX.chrome).toBeGreaterThan(Z_INDEX.canvas)
    // It never takes the pointer: the click or drop lands on the card beneath.
    expect(layer.className).toMatch(/\bpointer-events-none\b/)
  })
})
