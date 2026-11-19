/**
 * SavedNarrowingsSection — the narrowings saved with a view: each opens, hands on its short
 * link and exports for anyone who can open the view; only its saver (or an editor) renames
 * or removes it; and its saver downloads it as it was saved.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SavedNarrowingsButton, SavedNarrowingsSection, type SavedNarrowingItem } from '../SavedNarrowingsSection'

const item = (over: Partial<SavedNarrowingItem> = {}): SavedNarrowingItem => ({
  id: 'n1', name: 'Orders upstream', savedAt: Date.now() - 3_600_000, sentence: 'orders and everything upstream',
  held: 1234, canChange: true, active: false, hasCopy: false, ...over,
})

const handlers = () => ({
  onOpen: vi.fn(), onCopyLink: vi.fn((id: string) => `https://x/views/v1?narrowSaved=${id}`), onExport: vi.fn(),
  onDownloadCopy: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(),
})

describe('SavedNarrowingsSection', () => {
  it('opens one, copies its short link, and exports it', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const h = handlers()
    render(<SavedNarrowingsSection items={[item()]} {...h} />)
    expect(screen.getByText('1,234 when saved · 1h ago')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Orders upstream').closest('button')!)
    expect(h.onOpen).toHaveBeenCalledWith('n1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy a link to Orders upstream' })) })
    expect(writeText).toHaveBeenCalledWith('https://x/views/v1?narrowSaved=n1')
    fireEvent.click(screen.getByRole('button', { name: 'Export Orders upstream' }))
    expect(h.onExport).toHaveBeenCalledWith('n1')
  })

  it('renames and removes only what the reader may change, and downloads its saver’s copy', () => {
    const h = handlers()
    render(<SavedNarrowingsSection items={[item(), item({ id: 'n2', name: 'Theirs', canChange: false, hasCopy: true })]} {...h} />)
    const theirs = screen.getByText('Theirs').closest('li')!
    expect(within(theirs).queryByRole('button', { name: /Rename|Remove/ })).toBeNull()
    fireEvent.click(within(theirs).getByRole('button', { name: 'Download Theirs as it was saved' }))
    expect(h.onDownloadCopy).toHaveBeenCalledWith('n2')
    fireEvent.click(screen.getByRole('button', { name: 'Rename Orders upstream' }))
    const input = screen.getByLabelText('Name this saved narrowing')
    fireEvent.change(input, { target: { value: 'Upstream of orders' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.onRename).toHaveBeenCalledWith('n1', 'Upstream of orders')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Orders upstream' }))
    expect(h.onRemove).toHaveBeenCalledWith('n1')
  })

  it('the header shows its button only while the view has some, and opens the list from it', () => {
    const h = handlers()
    const { rerender } = render(<SavedNarrowingsButton items={[]} {...h} />)
    expect(screen.queryByRole('button', { name: /Saved narrowings/ })).toBeNull()
    rerender(<SavedNarrowingsButton items={[item()]} {...h} />)
    fireEvent.click(screen.getByRole('button', { name: 'Saved narrowings (1)' }))
    const panel = screen.getByRole('dialog', { name: 'Saved narrowings' })
    fireEvent.click(within(panel).getByText('Orders upstream').closest('button')!)
    expect(h.onOpen).toHaveBeenCalledWith('n1')
    expect(screen.queryByRole('dialog', { name: 'Saved narrowings' })).toBeNull()
  })

  it('a list that couldn’t be read says so, in the header too, and asks again', () => {
    const onRetry = vi.fn()
    render(<SavedNarrowingsButton items={[]} {...handlers()} error="Couldn’t load the narrowings saved with this view." onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: 'Saved narrowings (couldn’t load)' }))
    const panel = screen.getByRole('dialog', { name: 'Saved narrowings' })
    expect(within(panel).getByRole('alert')).toHaveTextContent('Couldn’t load the narrowings saved with this view.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
