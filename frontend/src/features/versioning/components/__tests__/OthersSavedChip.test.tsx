/**
 * OthersSavedChip — someone else saved into the draft you're on:
 *   • it says who and how much, and offers Refresh while you have unsaved edits;
 *   • with nothing unsaved it refreshes by itself, and says so;
 *   • nothing saved by others: nothing to say.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OthersSavedChip } from '../OthersSavedChip'

const onRefresh = vi.fn()
const saved = (by: string[], changes = 5) => ({ commits: by.length, changes, by, capped: false })
const names = { bob: 'Bob B', cy: 'Cy', dee: 'Dee' }

describe('OthersSavedChip', () => {
  beforeEach(() => onRefresh.mockReset())

  it('says who saved how much, and offers Refresh while you have unsaved edits', () => {
    render(<OthersSavedChip savedSince={saved(['bob'])} userNames={names} unsavedCount={2} onRefresh={onRefresh} />)
    expect(screen.getByText(/Bob B saved 5 changes/)).toBeInTheDocument()
    expect(onRefresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes by itself when you have nothing unsaved, and says so', () => {
    render(<OthersSavedChip savedSince={saved(['bob', 'cy'], 1)} userNames={names} unsavedCount={0} onRefresh={onRefresh} />)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Bob B and Cy saved 1 change/)).toBeInTheDocument()
    expect(screen.getByText(/showing them now/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
  })

  it('names two people, then counts the rest', () => {
    render(<OthersSavedChip savedSince={saved(['bob', 'cy', 'dee'])} userNames={names} unsavedCount={1} onRefresh={onRefresh} />)
    expect(screen.getByText(/Bob B and 2 others saved 5 changes/)).toBeInTheDocument()
  })

  it('says nothing when nobody else saved', () => {
    const { container } = render(
      <OthersSavedChip savedSince={saved([], 0)} userNames={names} unsavedCount={0} onRefresh={onRefresh} />)
    expect(container).toBeEmptyDOMElement()
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
