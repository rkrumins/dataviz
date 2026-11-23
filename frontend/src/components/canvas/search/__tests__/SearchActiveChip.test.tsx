/**
 * SearchActiveChip — a search still shaping the canvas says what it is doing
 * to the rows, and how to step through it, reopen it or put it away.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePersonaStore } from '@/store/persona'
import { useSearchStore } from '@/store/searchStore'

import { SearchActiveChip } from '../SearchActiveChip'

const chip = (over: Partial<React.ComponentProps<typeof SearchActiveChip>> = {}) => {
  const props = {
    count: 128, unit: 'match' as const, layerNames: ['Sources', 'Tables', 'Columns', 'Reports'], viewId: 'v1',
    onReveal: vi.fn(), onOpen: vi.fn(), onClear: vi.fn(), ...over,
  }
  render(<SearchActiveChip {...props} />)
  return props
}
const status = () => screen.getByRole('status', { name: 'A search is shaping the canvas' })

afterEach(() => {
  useSearchStore.setState({ canvasFilterMode: 'highlight', orderedMatchUrns: [], orderedEdgeKeys: [], focusedMatchIndex: null } as never)
  usePersonaStore.setState({ mode: 'technical' })
})

describe('SearchActiveChip', () => {
  it('says what it highlights, how many, and where', () => {
    chip()
    expect(status()).toHaveTextContent('Highlighting 128 search matches across 4 layers')
    expect(status()).toHaveTextContent('Everything else is dimmed, not hidden.')
    // Highlight hides nothing, so there is nothing to show again.
    expect(screen.queryByRole('button', { name: /Show all rows/ })).toBeNull()
  })

  it('names a single layer, and counts one match as one', () => {
    chip({ count: 1, layerNames: ['Reports'] })
    expect(status()).toHaveTextContent('Highlighting 1 search match in Reports')
  })

  it('says when rows are hidden, and gives every row back in one click', () => {
    useSearchStore.setState({ canvasFilterMode: 'isolate' } as never)
    chip()
    expect(status()).toHaveTextContent('Showing only 128 search matches')
    expect(status()).toHaveTextContent('Rows that don’t match are hidden from the canvas.')
    fireEvent.click(screen.getByRole('button', { name: /Show all rows/ }))
    expect(useSearchStore.getState().canvasFilterMode).toBe('highlight')
  })

  it('hide mode says the matches are what is hidden', () => {
    useSearchStore.setState({ canvasFilterMode: 'hide' } as never)
    chip()
    expect(status()).toHaveTextContent('Hiding 128 search matches')
    expect(status()).toHaveAttribute('data-search-mode', 'hide')
  })

  it('steps through the matches and shows each on the canvas', () => {
    useSearchStore.setState({ orderedMatchUrns: ['a', 'b', 'c'], orderedEdgeKeys: [], focusedMatchIndex: null } as never)
    const props = chip()
    expect(screen.getByText('3 to step')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(useSearchStore.getState().focusedMatchIndex).toBe(0)
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(useSearchStore.getState().focusedMatchIndex).toBe(2)
    expect(props.onReveal).toHaveBeenCalledTimes(2)
  })

  it('leaves paths and connections to the panel', () => {
    useSearchStore.setState({ orderedMatchUrns: ['a'], focusedMatchIndex: null } as never)
    chip({ unit: 'path', count: 3, layerNames: [] })
    expect(status()).toHaveTextContent('Highlighting 3 routes')
    expect(screen.queryByRole('button', { name: 'Next match' })).toBeNull()
  })

  it('reopens the search, or clears it', () => {
    const props = chip()
    fireEvent.click(screen.getByRole('button', { name: /Open search/ }))
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(props.onOpen).toHaveBeenCalledOnce()
    expect(props.onClear).toHaveBeenCalledOnce()
  })

  it('names the mode as the panel does only in the Technical view', () => {
    useSearchStore.setState({ canvasFilterMode: 'isolate' } as never)
    usePersonaStore.setState({ mode: 'technical' })
    const { unmount } = render(<SearchActiveChip count={2} unit="match" layerNames={[]} viewId="v" onReveal={vi.fn()} onOpen={vi.fn()} onClear={vi.fn()} />)
    expect(status()).toHaveTextContent('Isolate')
    unmount()
    usePersonaStore.setState({ mode: 'business' })
    render(<SearchActiveChip count={2} unit="match" layerNames={[]} viewId="v" onReveal={vi.fn()} onOpen={vi.fn()} onClear={vi.fn()} />)
    expect(status()).not.toHaveTextContent('Isolate')
    expect(status()).toHaveTextContent('Showing only 2 search matches')
  })
})
