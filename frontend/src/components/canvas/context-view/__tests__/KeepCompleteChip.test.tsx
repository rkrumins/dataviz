/**
 * The one question a view that never said is asked, when it holds every top-level entity of its
 * types today: keep it complete as new ones arrive, or only what's here. A quiet chip, and a
 * small sheet with the two answers; nothing is written until one is chosen.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KeepCompleteChip } from '../KeepCompleteChip'

function renderChip(sourceName?: string) {
  const props = { sourceName, onKeep: vi.fn(), onOnlyHere: vi.fn() }
  render(<KeepCompleteChip {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Keep this view complete?' }))
  return props
}

describe('KeepCompleteChip', () => {
  it('says what the view shows, by its source’s name, and asks', () => {
    renderChip('Finance DS')
    expect(screen.getByText('This view shows everything in Finance DS.')).toBeInTheDocument()
    expect(screen.getByText('Keep it complete as new top-level entities arrive?')).toBeInTheDocument()
  })

  it('a source with no name known is “this source”', () => {
    renderChip()
    expect(screen.getByText('This view shows everything in this source.')).toBeInTheDocument()
  })

  it('each answer is its own', () => {
    const keep = renderChip()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it complete' }))
    expect(keep.onKeep).toHaveBeenCalledTimes(1)
    expect(keep.onOnlyHere).not.toHaveBeenCalled()
  })

  it('“No, only what’s here”', () => {
    const only = renderChip()
    fireEvent.click(screen.getByRole('button', { name: 'No, only what’s here' }))
    expect(only.onOnlyHere).toHaveBeenCalledTimes(1)
    expect(only.onKeep).not.toHaveBeenCalled()
  })
})
