/**
 * The search box takes filters typed as text. A finished token must become the
 * filter its menu would set and leave the box; a token being typed must offer its
 * values; and a token that names nothing must stay as text, flagged, rather than
 * become a filter that matches nothing.
 */
import { useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', () => ({ getViewFacets: vi.fn() }))

import { getViewFacets, type ViewFacetsResponse } from '@/services/viewApiService'
import { EMPTY_FILTERS, ME, type ViewFilterState } from '@/features/view-filters/model'
import { ExplorerSearchBox } from '../ExplorerSearchBox'

const person = (userId: string, displayName: string, count: number) => ({
  userId, displayName, email: `${userId}@example.com`, avatarId: null,
  count, createdCount: count, editedCount: 0, publishedCount: 0,
})

const CTX = { currentUserId: 'u_me', today: '2026-10-12' }

const FACETS: ViewFacetsResponse = {
  tags: [{ value: 'pii', count: 5 }],
  viewTypes: [], creators: [],
  contributors: [person('u_ada', 'Ada Lovelace', 4), person('u_alan', 'Alan Turing', 2)],
}

function Harness({ onApply, onCommit, onRemoveLastFilter, staleState }: {
  onApply: (s: ViewFilterState) => void
  onCommit: (q: string) => void
  onRemoveLastFilter: () => void
  /** Never hand the box the new state, like a host whose re-render lags. */
  staleState?: boolean
}) {
  const [value, setValue] = useState('')
  const [state, setState] = useState(EMPTY_FILTERS)
  // Like the Explorer: changes compose on the latest state, re-rendered or not.
  const latest = useRef(EMPTY_FILTERS)
  const ref = useRef<HTMLInputElement>(null)
  return (
    <ExplorerSearchBox
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      inputRef={ref}
      state={staleState ? EMPTY_FILTERS : state}
      onApplyFilters={update => {
        latest.current = update(latest.current)
        setState(latest.current)
        onApply(latest.current)
      }}
      ctx={CTX}
      currentUser={{ id: 'u_me', name: 'Me Myself', email: 'me@example.com' }}
      recents={[]}
      onClearRecents={() => {}}
      onRemoveRecent={() => {}}
      onRemoveLastFilter={onRemoveLastFilter}
    />
  )
}

function setup({ staleState = false } = {}) {
  const onApply = vi.fn()
  const onCommit = vi.fn()
  const onRemoveLastFilter = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Harness onApply={onApply} onCommit={onCommit} onRemoveLastFilter={onRemoveLastFilter} staleState={staleState} />
    </QueryClientProvider>,
  )
  const input = screen.getByRole('combobox') as HTMLInputElement
  const type = (text: string) => fireEvent.change(input, { target: { value: text, selectionStart: text.length } })
  return { input, type, onApply, onCommit, onRemoveLastFilter }
}

beforeEach(() => {
  vi.mocked(getViewFacets).mockReset()
  vi.mocked(getViewFacets).mockResolvedValue(FACETS)
})

describe('ExplorerSearchBox', () => {
  it('turns a finished token into its filter and keeps the rest as search text', async () => {
    const { input, type, onApply } = setup()
    fireEvent.focus(input)
    type('revenue is:versioned ')
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ sourceKind: 'versioned' }))
    expect(input.value).toBe('revenue ')
  })

  it('offers people while a by: token is typed, and Enter picks one', async () => {
    const { input, type, onApply } = setup()
    fireEvent.focus(input)
    await waitFor(() => expect(getViewFacets).toHaveBeenCalled())
    type('by:al')
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(within(list).getByText('Alan Turing')).toBeTruthy())
    expect(within(list).queryByText('Ada Lovelace')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ contributorIds: ['u_alan'] }))
    expect(input.value).toBe('')
  })

  it('reads by:me as you', () => {
    const { input, type, onApply } = setup()
    fireEvent.focus(input)
    type('by:me ')
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ contributorIds: [ME] }))
  })

  it('leaves a token that names nothing in the box, with a hint', async () => {
    const { input, type, onApply } = setup()
    fireEvent.focus(input)
    await waitFor(() => expect(getViewFacets).toHaveBeenCalled())
    type('is:purple ')
    expect(onApply).not.toHaveBeenCalled()
    expect(input.value).toBe('is:purple ')
    expect(screen.getByRole('status').textContent).toMatch(/is:purple doesn't match anything/)
  })

  it('searches on Enter when there is no token to finish', () => {
    const { input, type, onCommit } = setup()
    fireEvent.focus(input)
    type('quarterly')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('quarterly')
  })

  it('closes its panel on the first Escape without letting the page see it', async () => {
    const { input, type } = setup()
    const pageEscape = vi.fn()
    document.addEventListener('keydown', pageEscape)
    fireEvent.focus(input)
    await waitFor(() => expect(getViewFacets).toHaveBeenCalled())
    type('by:a')
    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(pageEscape).not.toHaveBeenCalled()
    document.removeEventListener('keydown', pageEscape)
  })

  it('takes off the last filter on Backspace in an empty box, and only then', () => {
    const { input, type, onRemoveLastFilter } = setup()
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onRemoveLastFilter).toHaveBeenCalledTimes(1)
    type('a')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onRemoveLastFilter).toHaveBeenCalledTimes(1)
  })

  it('keeps both of two tokens typed before the page re-renders', () => {
    const { input, type, onApply } = setup({ staleState: true })
    fireEvent.focus(input)
    type('is:versioned ')
    type('updated:<30d ')
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ sourceKind: 'versioned', updated: '30d' }))
  })
})
