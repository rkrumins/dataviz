/**
 * ChangesExplorer — a review's list beside the canvas: what the canvas shows (a draft, a revision,
 * two revisions compared), one operation at a time, searched, with kind and type behind Filter, a
 * page at a time. Its title offers the canvas's other scopes; it fetches nothing while closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListPage, ChangeListSummary } from '@/services/versioningApiService'

const scrollToIndex = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 36, size: 36,
    })),
    getTotalSize: () => opts.count * 36,
    measureElement: () => undefined,
    scrollToIndex,
  }),
}))
const api = vi.hoisted(() => ({ getChangeSummary: vi.fn(), getChangeEntries: vi.fn(), getChangeEntry: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { useBranchStore } from '@/store/branchStore'
import { useReviewStore } from '@/store/reviewStore'
import { ChangesExplorer } from '../ChangesExplorer'

const NONE = { added: 0, modified: 0, removed: 0 }
function summary(over: Partial<ChangeListSummary> = {}): ChangeListSummary {
  return {
    origin: { branchId: 'br_1' }, counts: { added: 3, modified: 1, removed: 1 },
    entityCounts: { added: 2, modified: 1, removed: 1 }, edgeCounts: { ...NONE, added: 1 }, structureCounts: NONE,
    impact: {},
    byType: [
      { kind: 'node', type: 'Table', added: 2, modified: 1, removed: 0 },
      { kind: 'node', type: 'Column', added: 0, modified: 0, removed: 1 },
      { kind: 'edge', type: 'FLOWS_TO', added: 1, modified: 0, removed: 0 },
    ],
    total: 5, listed: 5, approximate: false, tooLarge: null, window: null, ...over,
  }
}
const row = (entityId: string, status: 'added' | 'modified' | 'removed', type: string, name: string) => ({
  entityId, kind: 'node' as const, status, type, structural: false, displayName: name, urn: `urn:${name}`,
})
const page = (entries: ChangeListPage['entries']): ChangeListPage =>
  ({ entries, total: entries.length, offset: 0, limit: 100, hasMore: false })
const lastFilter = () => api.getChangeEntries.mock.calls.at(-1)?.[3]

function renderRail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ChangesExplorer viewId="v1" /></QueryClientProvider>)
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getChangeSummary.mockResolvedValue(summary())
  api.getChangeEntries.mockResolvedValue(page([row('t1', 'added', 'Table', 'orders'), row('c1', 'removed', 'Column', 'amount')]))
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1', graphId: 'g1', currentBranchId: 'br_1', mainHeadCommitSeq: 42 })
  // The list opens with a review here: this person keeps it open.
  useReviewStore.setState({ available: true, navigatorOpen: true, listOpen: true, listPreferred: true, scope: null, operation: null, filter: {}, current: null, position: 0 })
})

describe('ChangesExplorer', () => {
  it('lists what the canvas shows, counted by operation, a page at a time', async () => {
    renderRail()

    expect(await screen.findByText('orders')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'This draft' })).toBeInTheDocument()
    expect(screen.getByText('5 changes')).toBeInTheDocument()
    expect(api.getChangeSummary).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' })
    expect(lastFilter()).toEqual({ kind: 'node', statuses: [], type: undefined, q: '' })
    expect(screen.getByRole('radio', { name: /^Deleted/ })).toHaveTextContent('Deleted1')
  })

  it('shows one operation at a time, and starts on the one asked for', async () => {
    useReviewStore.getState().startReview({ operation: 'removed' })
    renderRail()
    await waitFor(() => expect(lastFilter()).toMatchObject({ statuses: ['removed'] }))

    fireEvent.click(await screen.findByRole('radio', { name: /^Added/ }))
    await waitFor(() => expect(lastFilter()).toMatchObject({ statuses: ['added'] }))
    fireEvent.click(screen.getByRole('radio', { name: /^All/ }))
    await waitFor(() => expect(lastFilter()).toMatchObject({ statuses: [] }))
  })

  it('asks for a search once it settles, and keeps kind and type behind Filter', async () => {
    renderRail()
    await userEvent.setup().type(await screen.findByRole('textbox', { name: 'Search these changes' }), 'ord')
    await waitFor(() => expect(lastFilter()).toMatchObject({ q: 'ord' }))
    expect(api.getChangeEntries.mock.calls.filter((c) => ['o', 'or'].includes(c[3].q))).toEqual([])

    expect(screen.queryByRole('combobox', { name: 'Type' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Filter: Entities' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'Table' } })
    await waitFor(() => expect(lastFilter()).toMatchObject({ kind: 'node', type: 'Table' }))
    fireEvent.click(screen.getByRole('radio', { name: /^Relationships/ }))
    await waitFor(() => expect(lastFilter()).toMatchObject({ kind: 'edge', type: undefined }))
    expect(screen.getByRole('button', { name: 'Filter: Relationships' })).toBeInTheDocument()
  })

  it("offers the canvas's other scopes in its title", async () => {
    useBranchStore.setState({ currentBranchId: null })
    useBranchStore.getState().openRevision({ seq: 12, headAtOpen: 40 })
    renderRail()

    const title = await screen.findByRole('combobox', { name: 'What to review' })
    expect(title).toHaveDisplayValue('Since #12')
    expect(api.getChangeSummary).toHaveBeenLastCalledWith('ws1', 'g1', { fromSeq: 12, toSeq: 40 })
    fireEvent.change(title, { target: { value: '1' } })
    await waitFor(() => expect(api.getChangeSummary).toHaveBeenLastCalledWith('ws1', 'g1', { fromSeq: 11, toSeq: 12 }))
    expect(screen.getByRole('combobox', { name: 'What to review' })).toHaveDisplayValue('Changed in #12')
  })

  it('says why a list too large to hold isn’t listed', async () => {
    api.getChangeSummary.mockResolvedValue(summary({ listed: 0, tooLarge: { changed: 250_000, limit: 200_000 } }))
    renderRail()
    expect(await screen.findByText(/more than a list here shows/)).toBeInTheDocument()
    expect(api.getChangeEntries).not.toHaveBeenCalled()
  })

  it('fetches nothing while no review is open, and closes to the navigator, remembering it', async () => {
    useReviewStore.setState({ navigatorOpen: false, listOpen: false })
    renderRail()
    expect(api.getChangeSummary).not.toHaveBeenCalled()

    act(() => useReviewStore.setState({ navigatorOpen: true, listOpen: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close the list' }))
    expect(useReviewStore.getState()).toMatchObject({ listOpen: false, navigatorOpen: true, listPreferred: false })
  })

  it('moves between rows with the arrow keys, and keeps the change the navigator moves to in view', async () => {
    renderRail()
    await screen.findByText('amount')
    const orders = screen.getByRole('button', { name: /^Added\s?orders/ })
    orders.focus()
    fireEvent.keyDown(orders, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: /^Deleted\s?amount$/ })).toHaveFocus()

    scrollToIndex.mockClear()
    act(() => useReviewStore.getState().visit({ entityId: 'c1', kind: 'node', status: 'removed', structural: false }, 1))
    // Items: the Table header, orders, the Column header, amount.
    expect(scrollToIndex).toHaveBeenCalledWith(3, { align: 'auto' })
  })

  it('makes a picked row the change the review is on, and marks it', async () => {
    renderRail()
    const amount = () => screen.getByRole('button', { name: /^Deleted\s?amount$/ })
    await screen.findByText('amount')
    fireEvent.click(amount())
    expect(useReviewStore.getState()).toMatchObject({ current: { entityId: 'c1' }, position: 1 })
    expect(amount().closest('[role="listitem"]')).toHaveAttribute('aria-current', 'true')
    // Its chevron still shows what changed, without moving the review.
    fireEvent.click(screen.getByRole('button', { name: 'What changed in orders' }))
    expect(useReviewStore.getState().current?.entityId).toBe('c1')
  })
})
